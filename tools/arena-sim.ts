/**
 * Real-map, multi-hunter simulator (approximation of the practice matches, not the real server).
 *
 * Our bot (a subprocess speaking mechfight/1) against a squad of built-in hunters that, like the
 * practice house bots, share vision of us, come one at a time early and more as we kill them,
 * weakest first. Buildings block movement, sight and shots (world.ts). Score = kills before death.
 *
 *   bun tools/arena-sim.ts --runs 8 --weapon laser --seed 1 --env BOT_WANT_LASER=140
 *
 * Hunter numbers are calibrated against the public house-bot replay (tools/replay-stats.py):
 * they fight at ~55 m, boost ~25% of the time, and hit roughly 35-60% with the gun.
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { World } from "../world.ts"

// ---------- options ----------
const argv = process.argv.slice(2)
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const RUNS = Number(opt("runs", "6"))
const WEAPON = opt("weapon", "") // our second weapon at spawn: laser | mortar | lightning | ""
const HUNTER_WEAPON = opt("hunter-weapon", "") // hunters' second weapon: mortar | ""
const SEED = Number(opt("seed", "1"))
const TIME = Number(opt("time", "300"))
const MAXACTIVE = Number(opt("max-active", "4"))
const BOT = opt("bot", "bot.ts")
const ENV = opt("env", "") // comma-separated BOT_*=v for our bot
const VERBOSE = argv.includes("--verbose")

const stream = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n")
const hello = JSON.parse(stream[0])
hello.map.dir = "kit/arena"
const cfg = hello.config
const M = cfg.mech
const W = cfg.weapons
const world = new World("kit/arena")
const dt = 1 / cfg.match.tick_hz
const TAU = Math.PI * 2
const wrap = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI
const hyp2 = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1])

let seed = 1
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
const gauss = () => {
  const u = Math.max(rand(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand())
}

// hunter types in the order the squad sends them (4 easy, 4 medium, 4 hard, 3 expert)
type HType = { name: string; aimDeg: number }
const TYPES: HType[] = [
  ...Array(4).fill({ name: "easy", aimDeg: 3.0 }),
  ...Array(4).fill({ name: "medium", aimDeg: 2.0 }),
  ...Array(4).fill({ name: "hard", aimDeg: 1.3 }),
  ...Array(3).fill({ name: "expert", aimDeg: 0.9 }),
]

// ---------- mechs ----------
type Weapon2 = "" | "laser" | "mortar" | "lightning"
class Mech {
  pos: number[]
  vel = [0, 0, 0]
  aim: [number, number] = [0, 0]
  cmdAim: [number, number] = [0, 0]
  hp = M.hp
  maxHp = M.hp
  energy = M.energy
  lastSpend = -99
  lastCombat = -99
  grounded = true
  move: number[] = [0, 0]
  boost = false
  jump = false
  fire = false
  fire2 = false
  wantReload = false
  ammo = W.gun.mag
  cooldown = 0
  reload = 0
  second: Weapon2
  cool2 = 0
  charge = 0
  heldFull = 0
  events: any[] = []
  // stats
  shots = 0
  hits = 0
  dealt = 0
  taken = 0
  // hunter brain
  type?: HType
  path: [number, number][] = []
  lastPlan = -99
  strafe = 1
  nextFlip = 0
  boostUntil = 0
  aimErr: [number, number] = [0, 0]
  constructor(public id: number, x: number, y: number, second: Weapon2) {
    this.pos = [x, y, world.groundAt(x, y)]
    this.second = second
  }
  center(): number[] {
    return [this.pos[0], this.pos[1], this.pos[2] + M.height / 2]
  }
  eye(): number[] {
    return [this.pos[0], this.pos[1], this.pos[2] + M.eye_height]
  }
  muzzle(): number[] {
    return [this.pos[0], this.pos[1], this.pos[2] + M.muzzle_height]
  }
}

function bodyBlocked(x: number, y: number, z: number) {
  for (let k = 0; k <= 8; k++) {
    const px = k === 8 ? x : x + Math.cos((k / 8) * TAU) * M.radius
    const py = k === 8 ? y : y + Math.sin((k / 8) * TAU) * M.radius
    for (const h of [M.step_up + 0.1, 3, 5, 7, 8.9]) if (world.solid(px, py, z + h)) return true
  }
  return false
}

function physics(m: Mech, t: number) {
  // aim slews
  const dy = wrap(m.cmdAim[0] - m.aim[0])
  const ys = M.turn_rate * dt
  m.aim[0] = wrap(m.aim[0] + Math.max(-ys, Math.min(ys, dy)))
  const tp = Math.max(M.min_pitch, Math.min(M.max_pitch, m.cmdAim[1]))
  const ps = M.pitch_rate * dt
  m.aim[1] += Math.max(-ps, Math.min(ps, tp - m.aim[1]))
  // horizontal velocity
  const L = Math.hypot(m.move[0], m.move[1])
  const mv = L > 1 ? [m.move[0] / L, m.move[1] / L] : m.move
  const boosting = m.boost && m.energy > 0 && (L > 0.1 || !m.grounded)
  const spd = (boosting && m.grounded ? M.boost_speed : M.walk_speed) * (m.charge > 0 ? M.charge_move_mult : 1)
  const acc = (m.grounded ? M.ground_accel : M.air_accel) * dt
  for (const k of [0, 1]) {
    const dv = mv[k] * spd - m.vel[k]
    m.vel[k] += Math.max(-acc, Math.min(acc, dv))
  }
  if (m.jump && m.grounded) {
    m.vel[2] = M.jump_speed
    m.grounded = false
  }
  if (boosting && !m.grounded) m.vel[2] = Math.min(M.max_rise_speed, m.vel[2] + M.jet_accel * dt)
  if (boosting) {
    m.energy = Math.max(0, m.energy - (m.grounded ? M.boost_drain : M.jet_drain) * dt)
    m.lastSpend = t
  } else if (t - m.lastSpend > M.energy_regen_delay) m.energy = Math.min(M.energy, m.energy + M.energy_regen * dt)
  m.vel[2] -= M.gravity * dt
  const tryAt = (x: number, y: number) => {
    const stand = world.standZ(x, y, m.pos[2])
    if (stand - m.pos[2] > M.step_up + 0.01 && m.grounded) return false
    return !bodyBlocked(x, y, Math.max(m.pos[2], stand))
  }
  const nx = m.pos[0] + m.vel[0] * dt
  const ny = m.pos[1] + m.vel[1] * dt
  if (tryAt(nx, ny)) {
    m.pos[0] = nx
    m.pos[1] = ny
  } else if (tryAt(nx, m.pos[1])) {
    m.pos[0] = nx
    m.vel[1] = 0
  } else if (tryAt(m.pos[0], ny)) {
    m.pos[1] = ny
    m.vel[0] = 0
  } else {
    m.vel[0] = 0
    m.vel[1] = 0
  }
  const floor = world.standZ(m.pos[0], m.pos[1], m.pos[2] + 0.01)
  m.pos[2] += m.vel[2] * dt
  if (m.pos[2] <= floor) {
    m.pos[2] = floor
    m.vel[2] = 0
    m.grounded = true
  } else if (m.pos[2] - floor > 0.05) m.grounded = false
  // regen
  if (t - m.lastCombat > M.regen_delay) m.hp = Math.min(m.maxHp, m.hp + M.regen_per_s * dt)
}

/** Does segment p->q pass through mech m's cylinder? */
function segHits(p: number[], q: number[], m: Mech, r = M.radius + cfg.projectile.gun_radius) {
  const n = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / 1))
  for (let s = 1; s <= n; s++) {
    const f = s / n
    const x = p[0] + (q[0] - p[0]) * f
    const y = p[1] + (q[1] - p[1]) * f
    const z = p[2] + (q[2] - p[2]) * f
    if (Math.hypot(x - m.pos[0], y - m.pos[1]) <= r && z >= m.pos[2] && z <= m.pos[2] + M.height) return true
  }
  return false
}

function damage(target: Mech, shooter: Mech, amount: number, weapon: string, from: number[], t: number) {
  const inc = Math.atan2(from[1] - target.pos[1], from[0] - target.pos[0])
  const rear = Math.abs(wrap(inc - target.aim[0])) > (M.front_arc_deg * Math.PI) / 360
  const dmg = amount * (rear ? M.rear_mult : 1)
  target.hp -= dmg
  target.lastCombat = t
  shooter.lastCombat = t
  target.taken += dmg
  shooter.dealt += dmg
  shooter.hits++
  target.events.push({ type: "damaged", amount: dmg, weapon, bearing: inc, by: shooter.id, rear })
  shooter.events.push({ type: "hit", target: target.id, amount: dmg, weapon, rear })
}

// ---------- vision (what our bot sees) ----------
function sees(me: Mech, o: Mech) {
  const d = hyp2(me.pos, o.pos)
  const near = d <= cfg.vision.near_range
  const inCone = d <= cfg.vision.range && Math.abs(wrap(Math.atan2(o.pos[1] - me.pos[1], o.pos[0] - me.pos[0]) - me.aim[0])) <= (cfg.vision.fov_deg * Math.PI) / 360
  if (!near && !inCone) return false
  const eye = me.eye()
  return world.clear(eye, o.center(), 2) || world.clear(eye, [o.pos[0], o.pos[1], o.pos[2] + M.height], 2)
}

// ---------- hunter AI ----------
function hunterThink(h: Mech, A: Mech, t: number) {
  const d = hyp2(h.pos, A.pos)
  const los = world.clear(h.muzzle(), A.center(), 2)
  const want = 55
  const toA = Math.atan2(A.pos[1] - h.pos[1], A.pos[0] - h.pos[0])
  if (!los || d > want + 25) {
    if (t - h.lastPlan > 1 || h.path.length === 0) {
      h.path = world.path(h.pos[0], h.pos[1], A.pos[0], A.pos[1], 6000) ?? [[A.pos[0], A.pos[1]]]
      h.lastPlan = t
    }
    while (h.path.length > 1 && hyp2(h.pos, h.path[0]) < 3) h.path.shift()
    const wp = h.path[0] ?? [A.pos[0], A.pos[1]]
    const yaw = Math.atan2(wp[1] - h.pos[1], wp[0] - h.pos[0])
    h.move = [Math.cos(yaw), Math.sin(yaw)]
    h.boost = d > 120 && h.energy > 30
  } else {
    if (t > h.nextFlip) {
      h.strafe = rand() < 0.5 ? -1 : 1
      h.nextFlip = t + 1 + rand() * 1.5
    }
    const side = toA + (h.strafe * Math.PI) / 2
    const radial = d > want + 10 ? 0.5 : d < want - 15 ? -0.5 : 0
    h.move = [Math.cos(side) + radial * Math.cos(toA), Math.sin(side) + radial * Math.sin(toA)]
    if (t > h.boostUntil && rand() < 0.03) h.boostUntil = t + 1.5
    h.boost = t < h.boostUntil && h.energy > 20
  }
  // aim: lead with the gun's bullet speed, plus a slowly varying aim error
  const c = A.center()
  const mz = h.muzzle()
  let tf = Math.hypot(c[0] - mz[0], c[1] - mz[1], c[2] - mz[2]) / W.gun.speed
  const lp = [c[0] + A.vel[0] * tf, c[1] + A.vel[1] * tf, c[2]]
  tf = Math.hypot(lp[0] - mz[0], lp[1] - mz[1], lp[2] - mz[2]) / W.gun.speed
  const lead = [c[0] + A.vel[0] * tf, c[1] + A.vel[1] * tf, c[2]]
  const s = (h.type!.aimDeg * Math.PI) / 180
  h.aimErr = [h.aimErr[0] * 0.7 + gauss() * s * 0.55, h.aimErr[1] * 0.7 + gauss() * s * 0.3]
  const ay = Math.atan2(lead[1] - h.pos[1], lead[0] - h.pos[0]) + h.aimErr[0]
  const ap = Math.atan2(lead[2] - mz[2], hyp2(lead, h.pos)) + h.aimErr[1]
  h.cmdAim = [ay, ap]
  const err = Math.abs(wrap(h.aim[0] - ay))
  h.fire = los && d < W.gun.range && err < 0.08
  // mortar: lob at us when it can
  h.fire2 = h.second === "mortar" && d > 30 && d < 200 && h.cool2 <= 0 && los
  h.jump = false
}

// ---------- one run ----------
type Result = { kills: number; time: number; taken: number; aHit: number; hHit: number; aShots: number; hShots: number; slowest: number }

async function run(runSeed: number): Promise<Result> {
  seed = runSeed
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BOT_"))) as Record<string, string>
  for (const kv of ENV.split(",").filter(Boolean)) {
    const [k, v] = kv.split("=")
    env[k.trim()] = v.trim()
  }
  const bot = spawn("bun", [BOT], { stdio: ["pipe", "pipe", "ignore"], env })
  const lines = createInterface({ input: bot.stdout! })
  const queue: string[] = []
  let waiting: ((s: string) => void) | null = null
  lines.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : queue.push(l)))
  const next = () => new Promise<string>((res) => (queue.length ? res(queue.shift()!) : (waiting = res)))
  const send = (o: unknown) => bot.stdin!.write(JSON.stringify(o) + "\n")

  // our spawn: walkable ground in the central campus
  const pick = (cx: number, cy: number, rMin: number, rMax: number): [number, number] => {
    for (;;) {
      const a = rand() * TAU
      const r = rMin + rand() * (rMax - rMin)
      const x = cx + Math.cos(a) * r
      const y = cy + Math.sin(a) * r
      if (x < world.minX + 30 || y < world.minY + 30 || x > world.minX + world.nx - 30 || y > world.minY + world.ny - 30) continue
      const [gi, gj] = world.navOf(x, y)
      if (world.walkable(gi, gj)) return [x, y]
    }
  }
  const [ax, ay] = pick(0, -40, 0, 200)
  const A = new Mech(0, ax, ay, WEAPON as Weapon2)
  A.aim = [rand() * TAU - Math.PI, 0]
  const hunters: Mech[] = []
  let sent = 0
  let lastSpawn = -99
  let kills = 0
  send({ ...hello, slot: 0, seed: runSeed })
  await next()
  const bullets: { owner: Mech; p: number[]; v: number[]; trav: number }[] = []
  const shells: { owner: Mech; p: number[]; v: number[]; age: number }[] = []
  const seenUntil = new Map<number, number>()
  let t = 0
  let tick = 0
  let slowest = 0
  const zone = { center: [ax, ay], radius: 2000, next_center: [ax, ay], next_radius: 1500, shrink_start: 9999, shrink_end: 9999, dps: 0 }

  while (t < TIME && A.hp > 0) {
    // squad: one early, more as we thin them out, weakest first
    const alive = hunters.filter((h) => h.hp > 0)
    const cap = Math.min(MAXACTIVE, 1 + Math.floor(kills / 2) + (t > 200 ? 1 : 0))
    if (alive.length < cap && sent < TYPES.length && t - lastSpawn > 4) {
      const [hx, hy] = pick(A.pos[0], A.pos[1], 160, 230)
      const h = new Mech(1 + sent, hx, hy, HUNTER_WEAPON as Weapon2)
      h.type = TYPES[sent]
      hunters.push(h)
      sent++
      lastSpawn = t
    }
    if (tick % cfg.match.decide_every === 0) {
      // our observation
      const visible = hunters.filter((h) => {
        if (h.hp <= 0) return false
        if (sees(A, h)) seenUntil.set(h.id, t + cfg.vision.memory_s)
        return (seenUntil.get(h.id) ?? -1) >= t
      })
      const second =
        A.second === "laser" ? { kind: "laser", cooldown: Math.max(0, A.cool2), charge: A.charge, stats: W.laser }
        : A.second === "mortar" ? { kind: "mortar", cooldown: Math.max(0, A.cool2), stats: W.mortar }
        : A.second === "lightning" ? { kind: "lightning", cooldown: Math.max(0, A.cool2), stats: W.lightning }
        : null
      send({
        type: "obs", tick, t: +t.toFixed(2), alive: 1 + hunters.filter((h) => h.hp > 0).length + (TYPES.length - sent),
        self: { id: 0, pos: [...A.pos], vel: [...A.vel], aim: [...A.aim], hp: A.hp, max_hp: A.maxHp, energy: A.energy, max_energy: M.energy, grounded: A.grounded,
          cubes: 0, upgrades: [], weapons: [{ kind: "gun", cooldown: Math.max(0, A.cooldown), ammo: A.ammo, reload: Math.max(0, A.reload), stats: W.gun }, second],
          in_zone: true, stats: { radius: M.radius, height: M.height, eye_height: M.eye_height, muzzle_height: M.muzzle_height, walk_speed: M.walk_speed, boost_speed: M.boost_speed, turn_rate: M.turn_rate, hp: A.maxHp } },
        mechs: visible.map((h) => ({ id: h.id, kind: "mech", pos: [...h.pos], vel: [...h.vel], aim: [...h.aim], hp: h.hp, max_hp: h.maxHp, cubes: 0, weapons: ["gun", ...(h.second ? [h.second] : [])], charging: false })),
        projectiles: shells.filter((s) => s.owner !== A && (hyp2(s.p, A.pos) <= cfg.vision.near_range || (hyp2(s.p, A.pos) <= cfg.vision.range && Math.abs(wrap(Math.atan2(s.p[1] - A.pos[1], s.p[0] - A.pos[0]) - A.aim[0])) <= (cfg.vision.fov_deg * Math.PI) / 360)) && world.clear(A.eye(), s.p, 3))
          .map((s, i) => ({ id: 300 + i, kind: "mortar", pos: [...s.p], vel: [...s.v] })),
        crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: A.events, drops: [], offer: null, zone,
      })
      A.events = []
      const t0 = performance.now()
      const act = JSON.parse(await next())
      slowest = Math.max(slowest, performance.now() - t0)
      A.move = act.move ?? [0, 0]
      A.boost = !!act.boost
      A.jump = !!act.jump
      if (act.aim) A.cmdAim = act.aim
      A.fire = !!act.fire?.[0]
      A.fire2 = !!act.fire?.[1]
      A.wantReload = !!act.reload
      for (const h of hunters) if (h.hp > 0) hunterThink(h, A, t)
    }
    // physics and weapons
    for (const m of [A, ...hunters]) {
      if (m.hp <= 0) continue
      physics(m, t)
      // gun
      m.cooldown -= dt
      if (m.reload > 0) {
        m.reload -= dt
        if (m.reload <= 0) m.ammo = W.gun.mag
      } else if (m.wantReload && m.ammo < W.gun.mag) {
        m.reload = W.gun.reload
        m.wantReload = false
      }
      if (m.fire && m.cooldown <= 0 && m.reload <= 0 && m.ammo > 0) {
        const sd = (W.gun.spread_deg * Math.PI) / 180
        const yaw = m.aim[0] + gauss() * sd
        const pit = m.aim[1] + gauss() * sd
        const d = [Math.cos(pit) * Math.cos(yaw), Math.cos(pit) * Math.sin(yaw), Math.sin(pit)]
        const mz = m.muzzle()
        bullets.push({ owner: m, p: [mz[0] + d[0] * 3, mz[1] + d[1] * 3, mz[2] + d[2] * 3], v: d.map((c) => c * W.gun.speed), trav: 0 })
        m.cooldown = W.gun.cooldown
        m.ammo--
        m.shots++
        if (m.ammo === 0) m.reload = W.gun.reload
      }
      // second weapons (ours: laser / mortar / lightning; hunters: mortar)
      m.cool2 -= dt
      const foes = m === A ? hunters.filter((h) => h.hp > 0) : [A]
      if (m.second === "laser") {
        let shoot = false
        if (m.charge > 0) {
          m.charge = Math.min(W.laser.charge, m.charge + dt)
          if (m.charge >= W.laser.charge) m.heldFull += dt
          if ((!m.fire2 && m.charge >= W.laser.min_charge) || m.heldFull >= W.laser.hold_s) shoot = true
        } else if (m.fire2 && m.cool2 <= 0) m.charge = dt
        if (shoot) {
          const frac = W.laser.min_frac + (1 - W.laser.min_frac) * Math.min(1, m.charge / W.laser.charge)
          const d = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
          const o = m.muzzle()
          m.shots++
          for (let s = 0; s < W.laser.range; s += 2) {
            const a = [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s]
            const b = [o[0] + d[0] * (s + 2), o[1] + d[1] * (s + 2), o[2] + d[2] * (s + 2)]
            if (world.solid(b[0], b[1], b[2])) break
            const hit = foes.find((f) => segHits(a, b, f, M.radius))
            if (hit) {
              damage(hit, m, W.laser.damage * frac, "laser", o, t)
              break
            }
          }
          m.charge = 0
          m.heldFull = 0
          m.cool2 = W.laser.cooldown
        }
      } else if (m.second === "lightning") {
        if (m.fire2 && m.cool2 <= 0 && m.energy >= W.lightning.energy) {
          m.cool2 = W.lightning.cooldown
          m.energy -= W.lightning.energy
          m.lastSpend = t
          m.shots++
          const target = foes
            .filter((f) => hyp2(f.pos, m.pos) <= W.lightning.range + M.radius && Math.abs(wrap(Math.atan2(f.pos[1] - m.pos[1], f.pos[0] - m.pos[0]) - m.aim[0])) <= (W.lightning.cone_deg * Math.PI) / 360 && world.clear(m.muzzle(), f.center(), 2))
            .sort((a, b) => hyp2(a.pos, m.pos) - hyp2(b.pos, m.pos))[0]
          if (target) damage(target, m, W.lightning.damage, "lightning", m.pos, t)
        }
      } else if (m.second === "mortar" && m.fire2 && m.cool2 <= 0) {
        m.cool2 = W.mortar.cooldown
        m.shots++
        let [yaw, pit] = m.aim
        if (m !== A) {
          // hunters lob: solve the pitch for the distance (low arc)
          const d = hyp2(A.pos, m.pos)
          const v = W.mortar.speed
          const g = W.mortar.gravity
          const disc = v ** 4 - g * (g * d * d)
          pit = disc > 0 ? Math.atan((v * v - Math.sqrt(disc)) / (g * d)) : 0.78
          yaw = Math.atan2(A.pos[1] - m.pos[1], A.pos[0] - m.pos[0]) + gauss() * 0.03
        }
        const d = [Math.cos(pit) * Math.cos(yaw), Math.cos(pit) * Math.sin(yaw), Math.sin(pit)]
        const o = [m.pos[0] + d[0] * 3, m.pos[1] + d[1] * 3, m.pos[2] + M.height + 0.5 + d[2] * 3]
        shells.push({ owner: m, p: o, v: d.map((c) => c * W.mortar.speed), age: 0 })
      }
    }
    // bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i]
      const q = [b.p[0] + b.v[0] * dt, b.p[1] + b.v[1] * dt, b.p[2] + b.v[2] * dt]
      const foes = b.owner === A ? hunters.filter((h) => h.hp > 0) : A.hp > 0 ? [A] : []
      const hit = foes.find((f) => segHits(b.p, q, f))
      let blocked = false
      if (!hit) {
        const n = 13
        for (let s = 1; s <= n && !blocked; s++) {
          const f = s / n
          if (world.solid(b.p[0] + (q[0] - b.p[0]) * f, b.p[1] + (q[1] - b.p[1]) * f, b.p[2] + (q[2] - b.p[2]) * f)) blocked = true
        }
      }
      b.trav += W.gun.speed * dt
      if (hit) damage(hit, b.owner, W.gun.damage, "gun", b.p, t)
      if (hit || blocked || b.trav > W.gun.range) bullets.splice(i, 1)
      else b.p = q
    }
    // shells
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i]
      s.v[2] -= W.mortar.gravity * dt
      const q = [s.p[0] + s.v[0] * dt, s.p[1] + s.v[1] * dt, s.p[2] + s.v[2] * dt]
      const foes = s.owner === A ? hunters.filter((h) => h.hp > 0) : A.hp > 0 ? [A] : []
      const direct = foes.find((f) => segHits(s.p, q, f))
      s.age += dt
      if (direct || world.solid(q[0], q[1], q[2]) || s.age > W.mortar.ttl) {
        for (const v of [A, ...hunters]) {
          if (v.hp <= 0) continue
          const dd = Math.max(0, Math.hypot(v.pos[0] - q[0], v.pos[1] - q[1]) - M.radius)
          const dz = Math.max(0, v.pos[2] - q[2], q[2] - (v.pos[2] + M.height))
          const dist = Math.hypot(dd, dz)
          let dmg = v === direct ? W.mortar.damage : 0
          if (dist <= W.mortar.splash_radius) dmg += W.mortar.splash * (1 - (1 - W.mortar.splash_edge) * (dist / W.mortar.splash_radius))
          if (dmg <= 0) continue
          if (v === s.owner) dmg *= M.self_damage_mult
          else if ((s.owner === A) === (v === A)) continue // hunters never hurt each other
          damage(v, s.owner, dmg, "mortar", q, t)
          v.energy = Math.max(0, v.energy - W.mortar.drain * (dmg / (W.mortar.damage + W.mortar.splash)))
        }
        shells.splice(i, 1)
      } else s.p = q
    }
    // deaths
    for (const h of hunters)
      if (h.hp <= 0 && !(h as any).counted) {
        ;(h as any).counted = true
        kills++
        A.events.push({ type: "kill", target: h.id })
        if (VERBOSE) console.log(`  t=${t.toFixed(1)} killed ${h.type!.name} #${h.id}; A hp ${A.hp.toFixed(0)}`)
      }
    t += dt
    tick++
  }
  send({ type: "end", place: 1, kills })
  bot.kill()
  const hShots = hunters.reduce((a, h) => a + h.shots, 0)
  const hHits = hunters.reduce((a, h) => a + h.hits, 0)
  return { kills, time: t, taken: A.taken, aHit: A.hits / Math.max(1, A.shots), hHit: hHits / Math.max(1, hShots), aShots: A.shots, hShots, slowest }
}

const results: Result[] = []
for (let r = 0; r < RUNS; r++) {
  const res = await run(SEED * 1000 + r)
  results.push(res)
  console.log(`run ${r + 1}: ${res.kills} kills, died at ${res.time.toFixed(0)} s, our hit% ${(res.aHit * 100).toFixed(0)}, hunters' hit% ${(res.hHit * 100).toFixed(0)}, slowest answer ${res.slowest.toFixed(0)} ms`)
}
const mean = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0) / results.length
console.log(`ARENA ${WEAPON || "gun"} ${ENV}: kills mean ${mean((r) => r.kills).toFixed(2)} (min ${Math.min(...results.map((r) => r.kills))}, max ${Math.max(...results.map((r) => r.kills))}), survived ${mean((r) => r.time).toFixed(0)} s, our hit% ${(mean((r) => r.aHit) * 100).toFixed(0)}, hunters' hit% ${(mean((r) => r.hHit) * 100).toFixed(0)}`)
