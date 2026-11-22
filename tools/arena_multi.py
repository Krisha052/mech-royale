"""Average kills over 4 seeds x RUNS for each setting, at most 8 simulations at a time (one per core),
with the bot's timing safeguard off so CPU load cannot change its behaviour.
Usage: python3 tools/arena_multi.py RUNS "name:BOT_X=1,BOT_Y=2|--sim-option value" ..."""
import re, shlex, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
runs, specs = sys.argv[1], sys.argv[2:]
SEEDS = [3, 5, 7, 9]
def parse(spec):
    name, _, rest = spec.partition(":")
    envs, _, extra = rest.partition("|")
    return name, ",".join(x for x in ["BOT_TIMING=0", envs] if x), shlex.split(extra)
def one(job):
    name, envs, extra, seed = job
    out = subprocess.run(["bun", "tools/arena-sim.ts", "--runs", runs, "--seed", str(seed), "--env", envs] + extra, capture_output=True, text=True).stdout
    m = re.search(r"kills mean ([0-9.]+)", out)
    return name, seed, float(m.group(1)) if m else float("nan")
jobs = [(*parse(s), sd) for s in specs for sd in SEEDS]
res = {}
with ThreadPoolExecutor(8) as pool:
    for name, seed, v in pool.map(one, jobs):
        res.setdefault(name, {})[seed] = v
for s in specs:
    name = parse(s)[0]
    vals = [res[name][sd] for sd in SEEDS]
    print(f"{name:14} mean {sum(vals) / len(vals):.2f}   per seed: {' '.join(f'{v:.2f}' for v in vals)}", flush=True)
