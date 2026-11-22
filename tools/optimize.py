"""
Overnight settings search for bot.ts in the real-map arena (tools/arena-sim.ts).

Cross-entropy method over the bot's BOT_* settings, in a normalized [0, 1] space:
each generation samples LAMBDA candidates around the current mean, evaluates them all on the
same fresh seeds (common random numbers), keeps the best MU and moves the mean/spread toward
them. Promising candidates are re-checked on held-out seeds against the baseline defaults.

  python3 tools/optimize.py --dir DIR --hours 10 --log tools/opt-log.jsonl

DIR holds the bot and arena to run (a frozen copy, so the repo can change meanwhile).
Everything is logged as JSON lines; `--report` prints the best confirmed settings.
"""
import argparse, json, math, os, random, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

REALISTIC = ["--hunter-jump", "0.08", "--hunter-mix", "mortar:0.35,laser:0.3,lightning:0.07"]

# name: (low, high, kind) ; kind "f" float, "i" integer, "b" on/off
SPACE = {
    "WANT": (80, 200, "f"), "WANT_LASER": (100, 240, "f"), "WANT_MORTAR": (80, 200, "f"), "BAND": (10, 50, "f"),
    "RADIAL": (0, 2, "f"), "FLIP_MIN": (0.3, 1.5, "f"), "FLIP_RAND": (0.3, 2.0, "f"), "BOOST_FIGHT": (0, 80, "f"),
    "RETREAT_HP": (0, 0.5, "f"), "RETREAT_N": (2, 5, "i"), "RECOVER_HP": (0, 0.7, "f"),
    "FARM_UNTIL": (120, 480, "f"), "FARM_RANGE": (80, 350, "f"), "FARM_MIN_HP": (0.4, 0.95, "f"),
    "NPC_STANDOFF": (45, 120, "f"), "CUBE_RANGE": (70, 250, "f"), "GRAB_IN_FIGHT": (0, 150, "f"),
    "BULLET_MARGIN": (0, 2, "f"), "BULLET_HORIZON": (0.4, 1.6, "f"), "DODGE_MARGIN": (0, 5, "f"),
    "TARGET_HP_W": (0, 0.3, "f"), "PACK": (0, 2, "f"),
    "THREAT": (0, 1, "b"), "NPC_FIX": (0, 1, "b"), "ROOF_SAFE": (0, 1, "b"),
}
NAMES = list(SPACE)


def defaults(bot_path):
    src = open(bot_path).read()
    d = {}
    for n in NAMES:
        m = re.search(r'knob\("' + n + r'", ([-0-9.]+)\)', src)
        if not m:
            sys.exit(f"setting {n} not found in {bot_path}")
        d[n] = float(m.group(1))
    return d


def to_unit(cfg):
    return [min(1, max(0, (cfg[n] - SPACE[n][0]) / (SPACE[n][1] - SPACE[n][0]))) for n in NAMES]


def from_unit(u):
    cfg = {}
    for n, x in zip(NAMES, u):
        lo, hi, kind = SPACE[n]
        x = min(1, max(0, x))
        v = lo + x * (hi - lo)
        cfg[n] = int(round(v)) if kind == "i" else (1 if v >= 0.5 else 0) if kind == "b" else round(v, 3)
    return cfg


def run_one(dirpath, cfg, seed, runs):
    env = ",".join(f"BOT_{k}={v}" for k, v in cfg.items())
    out = subprocess.run(["bun", "tools/arena-sim.ts", "--runs", str(runs), "--seed", str(seed), "--env", env] + REALISTIC,
                         cwd=dirpath, capture_output=True, text=True, timeout=3600).stdout
    m = re.search(r"kills mean ([0-9.]+)", out)
    return float(m.group(1)) if m else float("nan")


def evaluate(pool, dirpath, cfgs, seeds, runs):
    """Mean kills for each config over the same seeds (common random numbers)."""
    jobs = [(i, s) for i in range(len(cfgs)) for s in seeds]
    futs = {pool.submit(run_one, dirpath, cfgs[i], s, runs): (i, s) for i, s in jobs}
    res = [[] for _ in cfgs]
    for f, (i, s) in futs.items():
        res[i].append(f.result())
    return [sum(r) / len(r) for r in res]


def log(path, rec):
    rec["time"] = time.strftime("%H:%M:%S")
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)


def report(path):
    recs = [json.loads(l) for l in open(path)]
    confs = [r for r in recs if r["type"] == "confirm"]
    base = [r for r in recs if r["type"] == "baseline"]
    gens = [r for r in recs if r["type"] == "generation"]
    print(f"generations: {len(gens)}; confirmations: {len(confs)}")
    if base:
        print(f"baseline (current defaults) on held-out seeds: {base[-1]['score']:.2f}")
    for r in sorted(confs, key=lambda r: -r["score"])[:5]:
        print(f"confirmed {r['score']:.2f} (search score {r['search_score']:.2f}): {json.dumps(r['cfg'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--hours", type=float, default=10)
    ap.add_argument("--log", default="tools/opt-log.jsonl")
    ap.add_argument("--lambda", dest="lam", type=int, default=8)
    ap.add_argument("--mu", type=int, default=3)
    ap.add_argument("--runs", type=int, default=15, help="runs per seed in the search")
    ap.add_argument("--seeds", type=int, default=4, help="seeds per generation")
    ap.add_argument("--workers", type=int, default=7)
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    if a.report:
        return report(a.log)

    base = defaults(os.path.join(a.dir, "bot.ts"))
    mean = to_unit(base)
    sigma = [0.18] * len(NAMES)
    rng = random.Random(12345)
    held_out = [101, 103, 107, 109, 113, 127]  # confirmation seeds, never used in the search
    deadline = time.time() + a.hours * 3600
    best_search = -1.0
    with ThreadPoolExecutor(a.workers) as pool:
        b = evaluate(pool, a.dir, [base], held_out, 20)[0]
        log(a.log, {"type": "baseline", "score": b, "cfg": base})
        gen = 0
        while time.time() < deadline:
            gen += 1
            seeds = [1000 * gen + k for k in range(a.seeds)]
            us = [mean] + [[m + rng.gauss(0, s) for m, s in zip(mean, sigma)] for _ in range(a.lam - 1)]
            cfgs = [from_unit(u) for u in us]
            scores = evaluate(pool, a.dir, cfgs, seeds, a.runs)
            order = sorted(range(len(us)), key=lambda i: -scores[i])
            elite = [us[i] for i in order[: a.mu]]
            new_mean = [sum(e[k] for e in elite) / a.mu for k in range(len(NAMES))]
            # shrink slowly and never below 0.08, so the search keeps exploring instead of fixing early on noise
            new_sigma = [max(0.08, 0.9 * s + 0.1 * math.sqrt(sum((e[k] - new_mean[k]) ** 2 for e in elite) / a.mu)) for k, s in enumerate(sigma)]
            mean, sigma = [min(1, max(0, x)) for x in new_mean], new_sigma
            top = order[0]
            log(a.log, {"type": "generation", "gen": gen, "scores": [round(x, 2) for x in scores], "best": scores[top],
                        "mean_score": scores[0], "best_cfg": cfgs[top], "sigma_avg": round(sum(sigma) / len(sigma), 3)})
            # confirm a candidate on held-out seeds when it looks better than anything so far
            if scores[top] > best_search and gen > 1:
                best_search = scores[top]
                c = evaluate(pool, a.dir, [cfgs[top]], held_out, 20)[0]
                log(a.log, {"type": "confirm", "gen": gen, "score": c, "search_score": scores[top], "cfg": cfgs[top]})
            # every 5 generations also confirm the current mean (the search's consensus)
            if gen % 5 == 0:
                mc = from_unit(mean)
                c = evaluate(pool, a.dir, [mc], held_out, 20)[0]
                log(a.log, {"type": "confirm", "gen": gen, "score": c, "search_score": scores[0], "cfg": mc, "what": "mean"})


if __name__ == "__main__":
    main()
