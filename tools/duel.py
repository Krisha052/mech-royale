"""
Local 1v1 duel simulator for mechfight/1 bots. Not the real server: an open field, gun only,
physics and numbers from protocol.md and the recorded hello config. Use it to check that shots
land and to compare fighting styles; confirm anything that matters with a real submission.

  python3 tools/duel.py --games 20 -- "bun bot.ts" "bun example.ts"

Each game spawns both bots fresh, places them `--dist` m apart in the open area at (427, -114)
facing random directions, and runs until one dies or --time seconds pass.
"""
import argparse, gzip, json, math, random, shlex, struct, subprocess, sys, time

TAU = 2 * math.pi
CX, CY = 427.0, -114.0  # open, flat area (tools/open-area.ts)


def wrap(a):
    return (a + math.pi) % TAU - math.pi


class Terrain:
    def __init__(self, d):
        meta = json.load(open(f"{d}/v2/world.json"))["terrain"]
        self.minX, self.minY, self.nx, self.ny = meta["minX"], meta["minY"], meta["nx"], meta["ny"]
        raw = open(f"{d}/v2/terrain.i16", "rb").read()
        self.h = struct.unpack(f"<{self.nx * self.ny}h", raw)

    def at(self, x, y):
        fx, fy = x - self.minX, y - self.minY
        i, j = int(math.floor(fx)), int(math.floor(fy))
        u, v = fx - i, fy - j

        def g(i, j):
            i = min(max(i, 0), self.nx - 1); j = min(max(j, 0), self.ny - 1)
            return self.h[j * self.nx + i] / 100

        return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v


class Mech:
    def __init__(self, mid, pos, yaw, cfg):
        m = cfg["mech"]; g = cfg["weapons"]["gun"]
        self.id, self.cfg = mid, cfg
        self.pos = list(pos); self.vel = [0.0, 0.0, 0.0]
        self.aim = [yaw, 0.0]; self.cmd_aim = [yaw, 0.0]
        self.hp = self.max_hp = m["hp"]; self.energy = m["energy"]
        self.ammo, self.cooldown, self.reload = g["mag"], 0.0, 0.0
        self.move, self.boost, self.fire, self.want_reload = [0.0, 0.0], False, False, False
        self.last_combat = -99.0; self.last_spend = -99.0
        self.events = []; self.seen_until = -99.0
        self.stats = dict(shots=0, hits=0, dmg=0.0, rear=0, taken=0.0, spd=0.0, n=0)

    def eye(self):
        return [self.pos[0], self.pos[1], self.pos[2] + self.cfg["mech"]["eye_height"]]


def sees(a, b, t, cfg):
    v = cfg["vision"]
    d = math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1])
    if d <= v["near_range"]:
        ok = True
    elif d <= v["range"]:
        yaw = math.atan2(b.pos[1] - a.pos[1], b.pos[0] - a.pos[0])
        ok = abs(wrap(yaw - a.aim[0])) <= math.radians(v["fov_deg"]) / 2
    else:
        ok = False
    if ok:
        a.seen_until = t + v.get("memory_s", 5)
    return ok or t <= a.seen_until


def obs_for(me, other, t, tick, cfg, alive):
    w = cfg["weapons"]["gun"]; m = cfg["mech"]
    o = {
        "type": "obs", "tick": tick, "t": round(t, 2), "alive": alive,
        "self": {"id": me.id, "pos": me.pos, "vel": me.vel, "aim": me.aim, "hp": me.hp, "max_hp": me.max_hp,
                 "energy": me.energy, "max_energy": m["energy"], "grounded": True, "cubes": 0, "upgrades": [],
                 "weapons": [{"kind": "gun", "cooldown": max(0, me.cooldown), "ammo": me.ammo, "reload": max(0, me.reload), "stats": w}, None],
                 "in_zone": True, "stats": {k: m[k] for k in ("radius", "height", "eye_height", "muzzle_height", "walk_speed", "boost_speed", "turn_rate", "hp")}},
        "mechs": [], "projectiles": [], "crates": [], "cubes": [], "pickups": [], "sounds": [], "beams": [],
        "events": me.events, "drops": [], "offer": None,
        "zone": {"center": [CX, CY], "radius": 2000, "next_center": [CX, CY], "next_radius": 2000, "shrink_start": 9999, "shrink_end": 9999, "dps": 0},
    }
    if other.hp > 0 and sees(me, other, t, cfg):
        o["mechs"].append({"id": other.id, "kind": "mech", "pos": other.pos, "vel": other.vel, "aim": other.aim,
                           "hp": other.hp, "max_hp": other.max_hp, "cubes": 0, "weapons": ["gun"], "charging": False})
    me.events = []
    return o


def hit_test(p0, p1, target, cfg):
    """Does the segment p0->p1 pass through target's cylinder? Returns the fraction along it or None."""
    r = cfg["mech"]["radius"] + cfg["projectile"]["gun_radius"]
    h = cfg["mech"]["height"]
    n = 12
    for s in range(1, n + 1):
        f = s / n
        x = p0[0] + (p1[0] - p0[0]) * f; y = p0[1] + (p1[1] - p0[1]) * f; z = p0[2] + (p1[2] - p0[2]) * f
        if math.hypot(x - target.pos[0], y - target.pos[1]) <= r and target.pos[2] <= z <= target.pos[2] + h:
            return f
    return None


def game(cmds, cfg, hello, args, seed):
    rnd = random.Random(seed)
    terrain = Terrain(args.map)
    import os
    envs = []
    for extra in (args.envA, args.envB):
        e = {k: v for k, v in os.environ.items() if not k.startswith("BOT_")}
        for kv in filter(None, (extra or "").split(",")):
            k, v = kv.split("="); e[k.strip()] = v.strip()
        envs.append(e)
    procs = [subprocess.Popen(shlex.split(c), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, env=envs[i]) for i, c in enumerate(cmds)]
    a0 = rnd.uniform(-math.pi, math.pi)
    mechs = []
    for i in range(2):
        side = -1 if i == 0 else 1
        x = CX + math.cos(a0) * side * args.dist / 2; y = CY + math.sin(a0) * side * args.dist / 2
        mechs.append(Mech(i, [x, y, terrain.at(x, y)], rnd.uniform(-math.pi, math.pi), cfg))
    for i, p in enumerate(procs):
        h = dict(hello); h["slot"] = i; h["seed"] = rnd.randrange(1, 2**31)
        p.stdin.write(json.dumps(h) + "\n"); p.stdin.flush(); p.stdout.readline()
    m, g = cfg["mech"], cfg["weapons"]["gun"]
    dt = 1 / cfg["match"]["tick_hz"]
    bullets = []  # [owner, pos, vel, travelled]
    t, tick, think_ms = 0.0, 0, [[], []]
    while t < args.time and all(x.hp > 0 for x in mechs):
        if tick % cfg["match"]["decide_every"] == 0:
            for i, (me, p) in enumerate(zip(mechs, procs)):
                o = obs_for(me, mechs[1 - i], t, tick, cfg, 2)
                t0 = time.perf_counter(); p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
                a = json.loads(p.stdout.readline()); think_ms[i].append((time.perf_counter() - t0) * 1000)
                mv = a.get("move", [0, 0]); L = math.hypot(*mv)
                me.move = [mv[0] / L, mv[1] / L] if L > 1 else list(mv)
                me.boost = bool(a.get("boost")); me.cmd_aim = list(a.get("aim", me.cmd_aim))
                me.fire = bool((a.get("fire") or [False])[0]); me.want_reload = bool(a.get("reload"))
        for me in mechs:
            # aim slews
            dy = wrap(me.cmd_aim[0] - me.aim[0]); step = m["turn_rate"] * dt
            me.aim[0] = wrap(me.aim[0] + max(-step, min(step, dy)))
            tp = max(m["min_pitch"], min(m["max_pitch"], me.cmd_aim[1])); dp = tp - me.aim[1]; ps = m["pitch_rate"] * dt
            me.aim[1] += max(-ps, min(ps, dp))
            # movement
            boosting = me.boost and me.energy > 0 and math.hypot(*me.move) > 0.1
            spd = m["boost_speed"] if boosting else m["walk_speed"]
            if boosting:
                me.energy = max(0, me.energy - m["boost_drain"] * dt); me.last_spend = t
            elif t - me.last_spend > m["energy_regen_delay"]:
                me.energy = min(m["energy"], me.energy + m["energy_regen"] * dt)
            for k in range(2):
                want = me.move[k] * spd; dv = want - me.vel[k]; acc = m["ground_accel"] * dt
                me.vel[k] += max(-acc, min(acc, dv))
            me.pos[0] += me.vel[0] * dt; me.pos[1] += me.vel[1] * dt
            me.pos[0] = min(max(me.pos[0], CX - 400), CX + 120); me.pos[1] = min(max(me.pos[1], CY - 200), CY + 200)
            me.pos[2] = terrain.at(me.pos[0], me.pos[1])
            me.stats["spd"] += math.hypot(me.vel[0], me.vel[1]); me.stats["n"] += 1
            # gun
            me.cooldown -= dt
            if me.reload > 0:
                me.reload -= dt
                if me.reload <= 0: me.ammo = g["mag"]
            elif me.want_reload and me.ammo < g["mag"]:
                me.reload = g["reload"]; me.want_reload = False
            if me.fire and me.cooldown <= 0 and me.reload <= 0 and me.ammo > 0:
                sd = math.radians(g["spread_deg"])
                yaw = me.aim[0] + rnd.gauss(0, sd); pit = me.aim[1] + rnd.gauss(0, sd)
                d = [math.cos(pit) * math.cos(yaw), math.cos(pit) * math.sin(yaw), math.sin(pit)]
                o = m["radius"] + 0.5
                start = [me.pos[0] + d[0] * o, me.pos[1] + d[1] * o, me.pos[2] + m["muzzle_height"] + d[2] * o]
                bullets.append([me.id, start, [d[0] * g["speed"], d[1] * g["speed"], d[2] * g["speed"]], 0.0])
                me.cooldown = g["cooldown"]; me.ammo -= 1; me.stats["shots"] += 1; me.last_combat = t
                if me.ammo == 0: me.reload = g["reload"]
            # regen
            if t - me.last_combat > m["regen_delay"]:
                me.hp = min(me.max_hp, me.hp + m["regen_per_s"] * dt)
        nb = []
        for b in bullets:
            owner, p, v, trav = b
            q = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt]
            tgt = mechs[1 - owner]; shooter = mechs[owner]
            f = hit_test(p, q, tgt, cfg) if tgt.hp > 0 else None
            if f is not None:
                inc = math.atan2(-v[1], -v[0])  # direction the shot came from, as seen by the target
                rear = abs(wrap(inc - tgt.aim[0])) > math.radians(m["front_arc_deg"]) / 2
                dmg = g["damage"] * (m["rear_mult"] if rear else 1)
                tgt.hp -= dmg; tgt.last_combat = t
                shooter.stats["hits"] += 1; shooter.stats["dmg"] += dmg; shooter.stats["rear"] += rear; tgt.stats["taken"] += dmg
                tgt.events.append({"type": "damaged", "amount": dmg, "weapon": "gun", "bearing": inc, "by": owner, "rear": rear})
                shooter.events.append({"type": "hit", "target": tgt.id, "amount": dmg, "weapon": "gun", "rear": rear})
                continue
            trav += g["speed"] * dt
            if trav < g["range"] and q[2] > terrain.at(q[0], q[1]):
                nb.append([owner, q, v, trav])
        bullets = nb
        t += dt; tick += 1
    for p in procs:
        try:
            p.stdin.write(json.dumps({"type": "end", "place": 1, "kills": 0}) + "\n"); p.stdin.flush()
        except BrokenPipeError:
            pass
        try: p.wait(2)
        except subprocess.TimeoutExpired: p.kill()
    winner = None if all(x.hp > 0 for x in mechs) else (0 if mechs[0].hp > 0 else 1)
    return winner, t, [x.stats for x in mechs], [x.hp for x in mechs], [max(x) if x else 0 for x in think_ms]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=10)
    ap.add_argument("--dist", type=float, default=120)
    ap.add_argument("--time", type=float, default=90)
    ap.add_argument("--map", default="kit/arena")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--envA", default="", help="comma-separated BOT_*=value settings for bot A only")
    ap.add_argument("--envB", default="", help="comma-separated BOT_*=value settings for bot B only")
    ap.add_argument("cmds", nargs=2)
    a = ap.parse_args(sys.argv[1:sys.argv.index("--")] + sys.argv[sys.argv.index("--") + 1:]) if "--" in sys.argv else ap.parse_args()
    lines = gzip.open("kit/check/stream.jsonl.gz", "rt").read().splitlines()
    hello = json.loads(lines[0]); hello["map"]["dir"] = a.map; cfg = hello["config"]
    wins = [0, 0, 0]; tot = [dict(shots=0, hits=0, dmg=0.0, rear=0, taken=0.0, spd=0.0, n=0) for _ in range(2)]; times = []
    for gi in range(a.games):
        w, t, st, hp, slow = game(a.cmds, cfg, hello, a, a.seed * 1000 + gi)
        wins[2 if w is None else w] += 1; times.append(t)
        for i in range(2):
            for k in tot[i]: tot[i][k] += st[i][k]
        print(f"game {gi + 1:2d}: winner {['A', 'B', 'none'][2 if w is None else w]:4s} at {t:5.1f}s  hp A {max(0, hp[0]):5.0f} B {max(0, hp[1]):5.0f}  "
              f"hit% A {100 * st[0]['hits'] / max(1, st[0]['shots']):4.1f} B {100 * st[1]['hits'] / max(1, st[1]['shots']):4.1f}  slowest ms A {slow[0]:.0f} B {slow[1]:.0f}")
    for i, name in enumerate("AB"):
        s = tot[i]
        print(f"{name} ({a.cmds[i]}): wins {wins[i]}/{a.games}  shots {s['shots']}  hit% {100 * s['hits'] / max(1, s['shots']):.1f}  "
              f"dmg/game {s['dmg'] / a.games:.0f}  rear hits {s['rear']}  taken/game {s['taken'] / a.games:.0f}  avg speed {s['spd'] / max(1, s['n']):.1f} m/s")
    print(f"draws {wins[2]}  avg length {sum(times) / len(times):.1f}s")


if __name__ == "__main__":
    main()
