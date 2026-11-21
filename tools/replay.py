"""Feed the kit's recorded match to a bot one observation at a time; report its modes and timing.
Usage: python3 tools/replay.py -- bun bot.ts"""
import gzip, json, subprocess, sys, time, collections
cmd = sys.argv[sys.argv.index("--") + 1:]
lines = gzip.open("kit/check/stream.jsonl.gz", "rt").read().splitlines()
hello = json.loads(lines[0]); hello["map"]["dir"] = "kit/arena"
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
p.stdin.write(json.dumps(hello) + "\n"); p.stdin.flush()
print("ready:", p.stdout.readline().strip())
labels, times, fired, modes = collections.Counter(), [], 0, []
for l in lines[1:]:
    m = json.loads(l)
    if m.get("type") != "obs": continue
    t0 = time.perf_counter(); p.stdin.write(l + "\n"); p.stdin.flush()
    a = json.loads(p.stdout.readline()); times.append((time.perf_counter() - t0) * 1000)
    lab = (a.get("debug") or {}).get("label", ""); labels[lab.split(" hp")[0]] += 1; modes.append(lab)
    if any(a.get("fire") or []): fired += 1
p.stdin.write(json.dumps({"type": "end", "place": 1, "kills": 0}) + "\n"); p.stdin.flush(); p.wait(5)
times.sort()
print(f"answers {len(times)}  fired on {fired}  ms p50 {times[len(times)//2]:.1f} max {times[-1]:.1f}  first {times and max(times[:3]):.1f}")
print("modes:", labels.most_common())
print("sample:", modes[::30])
