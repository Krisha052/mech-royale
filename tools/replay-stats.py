"""Summarize a public mechreplay/1 file (e.g. https://play.joinbuilders.org/replays/mechanics-v2-16.jsonl.gz):
per-mech results, gun accuracy and hit distance by bot type, movement. Usage: python3 -I tools/replay-stats.py FILE.jsonl.gz"""
import gzip, json, collections, math, statistics as st, sys
L = [json.loads(l) for l in gzip.open(sys.argv[1], 'rt').read().splitlines()]
H, R = L[0], L[-1]; frames = L[1:-1]
name = {m['id']: m['name'] for m in H['mechs']}
for m in sorted(R['mechs'], key=lambda m: m['place']):
    print(f"{m['id']:>2} {m['name']:10} place {m['place']:>2} kills {m['kills']} dealt {m['damage_dealt']:>5} taken {m['damage_taken']:>5} "
          f"{','.join(m['loadout']):16} first weapon {m['first_weapon_t']} died {m['death_t']} by {m['killed_with']}")
fires, hits, hitd = collections.Counter(), collections.Counter(), collections.defaultdict(list)
for f in frames:
    cur = {m[0]: m for m in f['m']}
    for e in f.get('ev', []):
        if e['e'] == 'fire': fires[(name.get(e['id']), e['w'])] += 1
        if e['e'] == 'hit' and e.get('src') in name and e.get('dst') in name:
            hits[(name[e['src']], e['w'])] += 1
            a, b = cur.get(e['src']), cur.get(e['dst'])
            if a and b: hitd[name[e['src']]].append(math.hypot(a[1] - b[1], a[2] - b[2]))
for nm in sorted(set(name.values())):
    d = hitd.get(nm, [])
    print(f"{nm:10} gun {hits[(nm, 'gun')]}/{fires[(nm, 'gun')]}  median hit distance {st.median(d) if d else 0:.0f} m")
