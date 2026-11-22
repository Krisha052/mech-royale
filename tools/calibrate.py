"""Which arena model predicts real scores? Runs historical bot versions (with known real practice
scores) through several arena models and reports how well each model's scores correlate with reality.

  python3 tools/calibrate.py VERSIONS_DIR [runs]
VERSIONS_DIR/<name>/bot.ts (+ world.ts, mechfight.ts) and VERSIONS_DIR/real.txt ("name score" lines)."""
import re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

VD = sys.argv[1]
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 20
REAL = {l.split()[0]: float(l.split()[1]) for l in open(f"{VD}/real.txt") if l.strip()}
H = ["--hunter-jump", "0.08", "--hunter-mix", "mortar:0.35,laser:0.3,lightning:0.07"]
MODELS = {
    "kills (previous arena)": H,
    "full, non-hunters fight back": ["--full"] + H,
    "full, non-hunters never fight": ["--full", "--retaliate", "0"] + H,
}
SEEDS = [3, 5]


def one(model, name, seed):
    out = subprocess.run(["bun", "tools/arena-sim.ts", "--runs", str(RUNS), "--seed", str(seed), "--bot", f"{VD}/{name}/bot.ts"] + MODELS[model],
                         capture_output=True, text=True).stdout
    m = re.search(r"FULL points mean ([0-9.]+)", out) or re.search(r"kills mean ([0-9.]+)", out)
    return model, name, float(m.group(1)) if m else float("nan")


def rank(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    for k, i in enumerate(order):
        r[i] = k
    return r


def corr(a, b):
    n = len(a); ma = sum(a) / n; mb = sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va = sum((x - ma) ** 2 for x in a) ** 0.5; vb = sum((y - mb) ** 2 for y in b) ** 0.5
    return cov / (va * vb) if va and vb else float("nan")


jobs = [(m, n, s) for m in MODELS for n in REAL for s in SEEDS]
res = {}
with ThreadPoolExecutor(8) as pool:
    for m, n, v in pool.map(lambda j: one(*j), jobs):
        res.setdefault((m, n), []).append(v)
names = sorted(REAL, key=lambda n: REAL[n])
for m in MODELS:
    sim = [sum(res[(m, n)]) / len(res[(m, n)]) for n in names]
    real = [REAL[n] for n in names]
    print(f"\n{m}: Pearson {corr(sim, real):+.2f}, Spearman {corr(rank(sim), rank(real)):+.2f}")
    print("   " + "  ".join(f"{n} {r:.2f}->{s:.2f}" for n, r, s in zip(names, real, sim)))
    nf = [i for i, n in enumerate(names) if n != "pacifist"]
    print(f"   without the pacifist: Pearson {corr([sim[i] for i in nf], [real[i] for i in nf]):+.2f}, Spearman {corr(rank([sim[i] for i in nf]), rank([real[i] for i in nf])):+.2f}")
