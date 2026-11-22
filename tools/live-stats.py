"""
Summarize recorded public matches (spectator streams, mechreplay/1 lines; see tools/watch.ts).
Per bot name: outcomes (place, kills, damage ratio, cubes, upgrades, loadout) and behaviour
(spacing from enemies, crowding, height, boosting, hit distance, first weapon), plus which
behaviours go with better placement across all mechs.

  python3 -I tools/live-stats.py REC_DIR
"""
import collections, glob, json, math, statistics as st, struct, sys

meta = json.load(open("kit/arena/v2/world.json"))["terrain"]
NX, NY = meta["nx"], meta["ny"]
H = struct.unpack(f"<{NX*NY}h", open("kit/arena/v2/terrain.i16", "rb").read())


def ground(x, y):
    i = min(max(int(round(x - meta["minX"])), 0), NX - 1)
    j = min(max(int(round(y - meta["minY"])), 0), NY - 1)
    return H[j * NX + i] / 100


def matches(path):
    """Split a recording into complete matches (header ... result)."""
    cur = None
    for line in open(path):
        if not line.strip():
            continue
        x = json.loads(line)
        if x.get("type") == "header":
            cur = {"header": x, "frames": []}
        elif x.get("type") == "result" and cur:
            cur["result"] = x
            yield cur
            cur = None
        elif cur is not None and "m" in x and "type" not in x:
            cur["frames"].append(x)


rows = []  # one per mech per complete match
for path in sorted(glob.glob(sys.argv[1] + "/*.jsonl")):
    for mt in matches(path):
        names = {m["id"]: m["name"] for m in mt["header"]["mechs"]}
        res = {m["id"]: m for m in mt["result"]["mechs"]}
        feat = collections.defaultdict(lambda: collections.defaultdict(list))
        hitd = collections.defaultdict(list)
        prev = {}
        for f in mt["frames"]:
            cur = {m[0]: m for m in f["m"] if m[6] > 0}
            for i, m in cur.items():
                ds = sorted(math.hypot(o[1] - m[1], o[2] - m[2]) for j, o in cur.items() if j != i)
                if not ds:
                    continue
                feat[i]["nearest"].append(ds[0])
                feat[i]["crowd"].append(1 if len(ds) > 1 and ds[1] < 100 else 0)
                feat[i]["high"].append(1 if m[3] - ground(m[1], m[2]) > 4 else 0)
                feat[i]["boost"].append(1 if m[8] & 2 else 0)
                if i in prev:
                    feat[i]["speed"].append(math.hypot(m[1] - prev[i][1], m[2] - prev[i][2]) / 0.1)
            prev = cur
            for e in f.get("ev", []):
                if e.get("e") == "hit" and e.get("src") in cur and e.get("dst") in cur and e.get("dst") in names:
                    a, b = cur[e["src"]], cur[e["dst"]]
                    hitd[e["src"]].append(math.hypot(a[1] - b[1], a[2] - b[2]))
        n = len(res)
        for i, r in res.items():
            fe = feat[i]
            if not fe["nearest"]:
                continue
            rows.append({
                "name": names[i], "place": r["place"], "points": n - r["place"], "kills": r["kills"],
                "ratio": r["damage_dealt"] / max(1, r["damage_taken"]), "cubes": r["cubes_max"], "ups": len(r["upgrades"]),
                "loadout": "+".join(r["loadout"]), "first_w": r["first_weapon_t"], "alive_s": r["death_t"] or mt["result"]["ticks"] / 20,
                "nearest": st.median(fe["nearest"]), "crowd": st.mean(fe["crowd"]), "high": st.mean(fe["high"]),
                "boost": st.mean(fe["boost"]), "speed": st.mean(fe["speed"] or [0]), "hitdist": st.median(hitd[i]) if hitd[i] else float("nan"),
                "upgrades": r["upgrades"], "drops": r.get("drops_taken", 0),
            })

nm = len({id(r) for r in rows})
print(f"{len(rows)} mech-matches from recordings")
by = collections.defaultdict(list)
for r in rows:
    by[r["name"]].append(r)
print(f"\n{'bot':16} {'n':>3} {'pts':>5} {'kills':>5} {'ratio':>5} {'cubes':>5} {'ups':>4} {'near':>5} {'crowd':>5} {'high':>5} {'boost':>5} {'hitd':>5} {'1stW':>5}  top loadout")
for name, rs in sorted(by.items(), key=lambda kv: -st.mean(r["points"] for r in kv[1])):
    lo = collections.Counter(r["loadout"] for r in rs).most_common(1)[0][0]
    fw = [r["first_w"] for r in rs if r["first_w"] is not None]
    hd = [r["hitdist"] for r in rs if not math.isnan(r["hitdist"])]
    print(f"{name[:16]:16} {len(rs):>3} {st.mean(r['points'] for r in rs):5.1f} {st.mean(r['kills'] for r in rs):5.1f} {st.mean(r['ratio'] for r in rs):5.2f} "
          f"{st.mean(r['cubes'] for r in rs):5.1f} {st.mean(r['ups'] for r in rs):4.1f} {st.mean(r['nearest'] for r in rs):5.0f} {st.mean(r['crowd'] for r in rs):5.2f} "
          f"{st.mean(r['high'] for r in rs):5.2f} {st.mean(r['boost'] for r in rs):5.2f} {st.mean(hd) if hd else 0:5.0f} {st.mean(fw) if fw else 0:5.1f}  {lo}")


def corr(a, b):
    ma, mb = st.mean(a), st.mean(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va = math.sqrt(sum((x - ma) ** 2 for x in a)); vb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return cov / (va * vb) if va and vb else float("nan")


print("\ncorrelation with points across all mech-matches:")
for k in ["kills", "ratio", "cubes", "ups", "nearest", "crowd", "high", "boost", "speed", "alive_s"]:
    print(f"  {k:8} {corr([r[k] for r in rows], [r['points'] for r in rows]):+.2f}")
ups = collections.Counter(u for r in rows if r["points"] >= 12 for u in r["upgrades"])
print("\nupgrades taken by top-4 finishers:", ups.most_common(10))
