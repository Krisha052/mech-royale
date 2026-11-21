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
const CUBES_A = Number(opt("cubes", "0")) // our starting power cubes: +4% max HP and damage each (up to 10)
const DROPS = !argv.includes("--no-drops") // supply drops: stand in the ring alone for capture_s -> cubes + full repair
const FARM = !argv.includes("--no-farm") // drones, crates, power cubes and upgrade offers
const PICKUPS = !argv.includes("--no-pickups") // floor weapons and hunter death drops (protocol §7 Weapon loot)
const HUNTER_MORTAR = Number(opt("hunter-mortar", "0.5")) // fraction of hunters carrying a mortar (when --hunter-weapon is not given)

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
  takenBy: Record<string, number> = {}
  dealtBy: Record<string, number> = {}
  dmgMult = 1
  shotsBy: Record<string, number> = {}
  // body and role
  radius = M.radius
  height = M.height
  kind: "mech" | "npc" | "crate" = "mech"
  home: number[] = [0, 0]
  aggroUntil = -99
  wanderTo: number[] | null = null
  // power cubes and upgrades (ours)
  cubes = 0
  hpMul = 1
  armor = 0
  regenMul = 1
  regenDelayAdd = 0
  laserMul = 1
  chargeMul = 1
  gunDmgMul = 1
  gunCdMul = 1
  upgrades: string[] = []
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
    return [this.pos[0], this.pos[1], this.pos[2] + this.height / 2]
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
  if (t - m.lastCombat > M.regen_delay + m.regenDelayAdd) m.hp = Math.min(m.maxHp, m.hp + M.regen_per_s * m.regenMul * dt)
}

/** Does segment p->q pass through mech m's cylinder? */
function segHits(p: number[], q: number[], m: Mech, r = m.radius + cfg.projectile.gun_radius) {
  const n = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / 1))
  for (let s = 1; s <= n; s++) {
    const f = s / n
    const x = p[0] + (q[0] - p[0]) * f
    const y = p[1] + (q[1] - p[1]) * f
    const z = p[2] + (q[2] - p[2]) * f
    if (Math.hypot(x - m.pos[0], y - m.pos[1]) <= r && z >= m.pos[2] && z <= m.pos[2] + m.height) return true
  }
  return false
}

function damage(target: Mech, shooter: Mech, amount: number, weapon: string, from: number[], t: number) {
  const inc = Math.atan2(from[1] - target.pos[1], from[0] - target.pos[0])
  const rear = target.kind === "mech" && Math.abs(wrap(inc - target.aim[0])) > (M.front_arc_deg * Math.PI) / 360
  const dmg = amount * shooter.dmgMult * (rear ? M.rear_mult : 1) * (1 - target.armor)
  if (target.kind === "npc") target.aggroUntil = t + 10
  target.hp -= dmg
  target.lastCombat = t
  shooter.lastCombat = t
  target.taken += dmg
  target.takenBy[weapon] = (target.takenBy[weapon] ?? 0) + dmg
  shooter.dealt += dmg
  shooter.dealtBy[weapon] = (shooter.dealtBy[weapon] ?? 0) + dmg
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
type Result = { dropsCaptured: number; cubes: number; upgrades: string[]; dealtBy: Record<string, number>; shotsBy: Record<string, number>; takenBy: Record<string, number>; activeAtDeath: number; mortarAtDeath: number; hpAtFightStart: number[]; kills: number; time: number; taken: number; aHit: number; hHit: number; aShots: number; hShots: number; slowest: number; armedAt: number | null; armedWith: string }

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
  const cubeMult = 1 + cfg.cubes.hp_per_cube * Math.min(CUBES_A, cfg.cubes.stat_cap)
  A.hp = A.maxHp = M.hp * cubeMult
  A.dmgMult = 1 + cfg.cubes.damage_per_cube * Math.min(CUBES_A, cfg.cubes.stat_cap)
  type Pickup = { id: number; kind: Weapon2; pos: number[] }
  const pickups: Pickup[] = []
  let pickupId = 8000
  let armedAt: number | null = WEAPON ? 0 : null
  if (PICKUPS) {
    const kinds: Weapon2[] = ["mortar", "laser", "lightning"]
    for (let n = 0; n < cfg.loot.floor_count; n++) {
      const kind = kinds[Math.floor(rand() * 3)]
      if (rand() < cfg.loot.floor_roof_fraction) {
        // on a roof: a building cell whose top is 5-45 m above the ground
        for (let tries = 0; tries < 200; tries++) {
          const x = world.minX + 30 + rand() * (world.nx - 60)
          const y = world.minY + 30 + rand() * (world.ny - 60)
          const k = world.cell(x, y)
          const top = world.t1[k]
          const g = world.groundAt(x, y)
          if (k >= 0 && !Number.isNaN(top) && top - g > 5 && top - g < 45 && world.b1[k] <= g + 1) {
            pickups.push({ id: pickupId++, kind, pos: [x, y, top] })
            break
          }
        }
      } else {
        const [x, y] = pick(0, 0, 0, 500)
        pickups.push({ id: pickupId++, kind, pos: [x, y, world.groundAt(x, y)] })
      }
    }
  }
  A.aim = [rand() * TAU - Math.PI, 0]
  // ---- drones, crates, power cubes, upgrade offers ----
  const npcs: Mech[] = []
  const crates: Mech[] = []
  const cubes: { id: number; pos: number[] }[] = []
  let cubeId = 5000
  const dropCubes = (at: number[], n: number) => {
    for (let i = 0; i < n; i++) cubes.push({ id: cubeId++, pos: [at[0] + (rand() - 0.5) * 2, at[1] + (rand() - 0.5) * 2, at[2]] })
  }
  if (FARM) {
    for (let i = 0; i < cfg.npc.count; i++) {
      const [x, y] = pick(0, 0, 0, 480)
      const n = new Mech(100 + i, x, y, "")
      n.kind = "npc"
      n.radius = cfg.npc.radius
      n.height = cfg.npc.height
      n.hp = n.maxHp = cfg.npc.hp
      n.home = [x, y]
      npcs.push(n)
    }
    for (let i = 0; i < cfg.crates.count; i++) {
      let x = 0
      let y = 0
      let z = 0
      if (rand() < cfg.crates.roof_fraction) {
        for (let tries = 0; tries < 200; tries++) {
          x = world.minX + 30 + rand() * (world.nx - 60)
          y = world.minY + 30 + rand() * (world.ny - 60)
          const k = world.cell(x, y)
          const top = world.t1[k]
          const g = world.groundAt(x, y)
          if (k >= 0 && !Number.isNaN(top) && top - g > 5 && top - g < 45 && world.b1[k] <= g + 1) {
            z = top
            break
          }
        }
      } else {
        ;[x, y] = pick(0, 0, 0, 480)
        z = world.groundAt(x, y)
      }
      const c = new Mech(1000 + i, x, y, "")
      c.pos[2] = z
      c.kind = "crate"
      c.radius = cfg.crates.radius
      c.height = cfg.crates.height
      c.hp = c.maxHp = cfg.crates.hp
      crates.push(c)
    }
  }
  A.cubes = CUBES_A
  const applyCubes = () => {
    const c = Math.min(A.cubes, cfg.cubes.stat_cap)
    const newMax = M.hp * (1 + cfg.cubes.hp_per_cube * c) * A.hpMul
    A.hp += Math.max(0, newMax - A.maxHp)
    A.maxHp = newMax
    A.dmgMult = 1 + cfg.cubes.damage_per_cube * c
  }
  applyCubes()
  const gainCubes = (n: number, t: number) => {
    for (let i = 0; i < n; i++) {
      A.cubes++
      applyCubes()
      if ((cfg.cubes.upgrade_thresholds as number[]).includes(A.cubes)) makeOffer(t)
    }
  }
  type Drop = { id: number; pos: number[]; callT: number; landT: number; progress: number; holder: number | null; taken: boolean }
  const drops: Drop[] = []
  let dropsCaptured = 0
  const offers: { id: number; expires: number; choices: { id: string; name: string; desc: string }[] }[] = []
  let offerId = 1
  const makeOffer = (t: number) => {
    const held = new Set(["gun", A.second].filter(Boolean))
    const pool = (cfg.upgrades as { id: string; name: string; desc: string; requires?: string; max: number }[])
      .filter((u) => (!u.requires || held.has(u.requires)) && A.upgrades.filter((x) => x === u.id).length < u.max)
    const choices: typeof pool = []
    while (choices.length < 3 && pool.length) choices.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
    offers.push({ id: offerId++, expires: t + cfg.bot.offer_timeout_s, choices: choices.map((u) => ({ id: u.id, name: u.name, desc: u.desc })) })
  }
  const applyUpgrade = (id: string) => {
    A.upgrades.push(id)
    if (id === "plating") A.hpMul *= 1.15
    else if (id === "armor") A.armor += 0.08
    else if (id === "nanites") {
      A.regenMul *= 1.6
      A.regenDelayAdd -= 1.5
    } else if (id === "laser_damage") A.laserMul *= 1.18
    else if (id === "laser_charge") A.chargeMul *= 0.75
    else if (id === "gun_damage") A.gunDmgMul *= 1.15
    else if (id === "gun_rate") A.gunCdMul *= 0.87
    applyCubes()
    A.events.push({ type: "upgrade", id })
  }
  const inView = (pt: number[], lift: number) => {
    const d = hyp2(pt, A.pos)
    const ok = d <= cfg.vision.near_range || (d <= cfg.vision.range && Math.abs(wrap(Math.atan2(pt[1] - A.pos[1], pt[0] - A.pos[0]) - A.aim[0])) <= (cfg.vision.fov_deg * Math.PI) / 360)
    return ok && world.clear(A.eye(), [pt[0], pt[1], pt[2] + lift], 2)
  }
  const hunters: Mech[] = []
  let sent = 0
  let lastSpawn = -99
  let kills = 0
  send({ ...hello, slot: 0, seed: runSeed })
  await next()
  const bullets: { owner: Mech; p: number[]; v: number[]; trav: number; dmg: number; speed: number; range: number }[] = []
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
      if (!HUNTER_WEAPON && rand() < HUNTER_MORTAR) h.second = "mortar"
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
      const visNpcs = npcs.filter((n) => n.hp > 0 && inView(n.pos, n.height / 2))
      const offer = offers[0] ?? null
      const second =
        A.second === "laser" ? { kind: "laser", cooldown: Math.max(0, A.cool2), charge: A.charge, stats: { ...W.laser, charge: W.laser.charge * A.chargeMul, damage: W.laser.damage * A.laserMul } }
        : A.second === "mortar" ? { kind: "mortar", cooldown: Math.max(0, A.cool2), stats: W.mortar }
        : A.second === "lightning" ? { kind: "lightning", cooldown: Math.max(0, A.cool2), stats: W.lightning }
        : null
      send({
        type: "obs", tick, t: +t.toFixed(2), alive: 1 + hunters.filter((h) => h.hp > 0).length + (TYPES.length - sent),
        self: { id: 0, pos: [...A.pos], vel: [...A.vel], aim: [...A.aim], hp: A.hp, max_hp: A.maxHp, energy: A.energy, max_energy: M.energy, grounded: A.grounded,
          cubes: A.cubes, upgrades: [...A.upgrades], weapons: [{ kind: "gun", cooldown: Math.max(0, A.cooldown), ammo: A.ammo, reload: Math.max(0, A.reload), stats: { ...W.gun, damage: W.gun.damage * A.gunDmgMul, cooldown: W.gun.cooldown * A.gunCdMul } }, second],
          in_zone: true, stats: { radius: M.radius, height: M.height, eye_height: M.eye_height, muzzle_height: M.muzzle_height, walk_speed: M.walk_speed, boost_speed: M.boost_speed, turn_rate: M.turn_rate, hp: A.maxHp } },
        mechs: [
          ...visible.map((h) => ({ id: h.id, kind: "mech", pos: [...h.pos], vel: [...h.vel], aim: [...h.aim], hp: h.hp, max_hp: h.maxHp, cubes: 0, weapons: ["gun", ...(h.second ? [h.second] : [])], charging: false })),
          ...visNpcs.map((n) => ({ id: n.id, kind: "npc", pos: [...n.pos], vel: [...n.vel], aim: [...n.aim], hp: n.hp, max_hp: n.maxHp })),
        ],
        projectiles: shells.filter((s) => s.owner !== A && (hyp2(s.p, A.pos) <= cfg.vision.near_range || (hyp2(s.p, A.pos) <= cfg.vision.range && Math.abs(wrap(Math.atan2(s.p[1] - A.pos[1], s.p[0] - A.pos[0]) - A.aim[0])) <= (cfg.vision.fov_deg * Math.PI) / 360)) && world.clear(A.eye(), s.p, 3))
          .map((s, i) => ({ id: 300 + i, kind: "mortar", pos: [...s.p], vel: [...s.v] })),
        crates: crates.filter((c) => c.hp > 0 && inView(c.pos, 1.2)).map((c) => ({ id: c.id, pos: [...c.pos], hp: c.hp })),
        cubes: cubes.filter((c) => inView(c.pos, 0.5)).map((c) => ({ id: c.id, pos: [...c.pos] })),
        pickups: pickups.filter((p) => {
          const d = hyp2(p.pos, A.pos)
          const inView = d <= cfg.vision.near_range || (d <= cfg.vision.range && Math.abs(wrap(Math.atan2(p.pos[1] - A.pos[1], p.pos[0] - A.pos[0]) - A.aim[0])) <= (cfg.vision.fov_deg * Math.PI) / 360)
          return inView && world.clear(A.eye(), [p.pos[0], p.pos[1], p.pos[2] + 1], 2)
        }).map((p) => ({ id: p.id, kind: p.kind, pos: [...p.pos] })),
        sounds: [], beams: [], events: A.events, offer, zone,
        drops: drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: [...d.pos], radius: cfg.drops.radius, lands_in: Math.max(0, d.landT - t), capture_s: cfg.drops.capture_s, progress: d.progress, holder: d.holder })),
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
      if (offers[0] && (act.pick !== undefined || t > offers[0].expires)) {
        const o = offers.shift()!
        const i = act.pick !== undefined && o.choices[act.pick] ? act.pick : 0
        if (o.choices[i]) applyUpgrade(o.choices[i].id)
      }
      // take a weapon (protocol: within pickup_radius horizontally and 4 m vertically)
      if (act.take !== undefined) {
        const i = pickups.findIndex((p) => p.id === act.take)
        const p = pickups[i]
        if (!p) A.events.push({ type: "take_failed", id: act.take, reason: "gone" })
        else if (hyp2(p.pos, A.pos) > cfg.loot.pickup_radius || Math.abs(p.pos[2] - A.pos[2]) > 4) A.events.push({ type: "take_failed", id: p.id, reason: "range" })
        else if (A.second === p.kind) A.events.push({ type: "take_failed", id: p.id, reason: "have" })
        else if (A.second && act.drop !== 1) A.events.push({ type: "take_failed", id: p.id, reason: "full" })
        else {
          pickups.splice(i, 1)
          if (A.second) {
            const old = { id: pickupId++, kind: A.second, pos: [...A.pos] }
            pickups.push(old)
            A.events.push({ type: "dropped", id: old.id, kind: old.kind, slot: 1 })
          }
          A.second = p.kind
          A.charge = 0
          A.cool2 = Math.max(cfg.loot.equip_s, 0)
          A.events.push({ type: "took", id: p.id, kind: p.kind, slot: 1 })
          if (armedAt === null && (p.kind === "laser" || p.kind === "mortar")) armedAt = t
          if (VERBOSE) console.log(`  t=${t.toFixed(1)} took ${p.kind}`)
        }
      }
      for (const h of hunters) if (h.hp > 0) hunterThink(h, A, t)
      // drones (protocol §7): shoot whoever attacks them, or mechs within aggro range while near home;
      // chase until the target is 90 m away or the drone is 60 m from home
      for (const n of npcs) {
        if (n.hp <= 0) continue
        const d = hyp2(n.pos, A.pos)
        const fromHome = hyp2(n.pos, n.home)
        const los = world.clear([n.pos[0], n.pos[1], n.pos[2] + 3], A.center(), 2)
        if (d <= cfg.npc.aggro_range && fromHome <= cfg.npc.leash && los) n.aggroUntil = Math.max(n.aggroUntil, t + 3)
        const engaged = t < n.aggroUntil && d < cfg.npc.deaggro_range && fromHome < cfg.npc.chase_leash
        let goal = n.home
        if (engaged) goal = d > 25 ? A.pos : n.pos
        else if (fromHome < 5) {
          if (!n.wanderTo || hyp2(n.pos, n.wanderTo) < 2) n.wanderTo = [n.home[0] + (rand() - 0.5) * cfg.npc.leash, n.home[1] + (rand() - 0.5) * cfg.npc.leash]
          goal = n.wanderTo
        }
        const gy = Math.atan2(goal[1] - n.pos[1], goal[0] - n.pos[0])
        n.move = hyp2(goal, n.pos) > 1 ? [Math.cos(gy), Math.sin(gy)] : [0, 0]
        n.cmdAim = [Math.atan2(A.pos[1] - n.pos[1], A.pos[0] - n.pos[0]), 0]
        n.fire = engaged && los
      }
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
        bullets.push({ owner: m, p: [mz[0] + d[0] * 3, mz[1] + d[1] * 3, mz[2] + d[2] * 3], v: d.map((c) => c * W.gun.speed), trav: 0, dmg: W.gun.damage * m.gunDmgMul, speed: W.gun.speed, range: W.gun.range })
        m.cooldown = W.gun.cooldown * m.gunCdMul
        m.ammo--
        m.shots++
        m.shotsBy.gun = (m.shotsBy.gun ?? 0) + 1
        if (m.ammo === 0) m.reload = W.gun.reload
      }
      // second weapons (ours: laser / mortar / lightning; hunters: mortar)
      m.cool2 -= dt
      const foes = m === A ? [...hunters, ...npcs, ...crates].filter((h) => h.hp > 0) : [A]
      if (m.second === "laser") {
        let shoot = false
        if (m.charge > 0) {
          m.charge = Math.min(W.laser.charge * m.chargeMul, m.charge + dt)
          if (m.charge >= W.laser.charge * m.chargeMul) m.heldFull += dt
          if ((!m.fire2 && m.charge >= W.laser.min_charge) || m.heldFull >= W.laser.hold_s) shoot = true
        } else if (m.fire2 && m.cool2 <= 0) m.charge = dt
        if (shoot) {
          const frac = W.laser.min_frac + (1 - W.laser.min_frac) * Math.min(1, m.charge / (W.laser.charge * m.chargeMul))
          const d = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
          const o = m.muzzle()
          m.shots++
          m.shotsBy.laser = (m.shotsBy.laser ?? 0) + 1
          for (let s = 0; s < W.laser.range; s += 2) {
            const a = [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s]
            const b = [o[0] + d[0] * (s + 2), o[1] + d[1] * (s + 2), o[2] + d[2] * (s + 2)]
            if (world.solid(b[0], b[1], b[2])) break
            const hit = foes.find((f) => segHits(a, b, f, f.radius))
            if (hit) {
              damage(hit, m, W.laser.damage * m.laserMul * frac, "laser", o, t)
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
    // drones: walk at npc.speed on walkable ground, fire npc bullets (no lead, wide spread)
    for (const n of npcs) {
      if (n.hp <= 0) continue
      const nx = n.pos[0] + n.move[0] * cfg.npc.speed * dt
      const ny = n.pos[1] + n.move[1] * cfg.npc.speed * dt
      const [gi, gj] = world.navOf(nx, ny)
      if (world.walkable(gi, gj)) {
        n.vel = [(nx - n.pos[0]) / dt, (ny - n.pos[1]) / dt, 0]
        n.pos = [nx, ny, world.groundAt(nx, ny)]
      } else n.vel = [0, 0, 0]
      n.aim = [...n.cmdAim] as [number, number]
      n.cooldown -= dt
      if (n.fire && n.cooldown <= 0) {
        n.cooldown = cfg.npc.cooldown
        const o = [n.pos[0], n.pos[1], n.pos[2] + 3]
        const c = A.center()
        const sd = (cfg.npc.spread_deg * Math.PI) / 180
        const yaw = Math.atan2(c[1] - o[1], c[0] - o[0]) + gauss() * sd
        const pit = Math.atan2(c[2] - o[2], hyp2(c, o)) + gauss() * sd
        const d = [Math.cos(pit) * Math.cos(yaw), Math.cos(pit) * Math.sin(yaw), Math.sin(pit)]
        bullets.push({ owner: n, p: [o[0] + d[0] * 2, o[1] + d[1] * 2, o[2] + d[2] * 2], v: d.map((v) => v * cfg.npc.projectile_speed), trav: 0, dmg: cfg.npc.damage, speed: cfg.npc.projectile_speed, range: 150 })
      }
    }
    // bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i]
      const q = [b.p[0] + b.v[0] * dt, b.p[1] + b.v[1] * dt, b.p[2] + b.v[2] * dt]
      const foes = b.owner === A ? [...hunters, ...npcs, ...crates].filter((h) => h.hp > 0) : A.hp > 0 ? [A] : []
      const hit = foes.find((f) => segHits(b.p, q, f))
      let blocked = false
      if (!hit) {
        const n = 13
        for (let s = 1; s <= n && !blocked; s++) {
          const f = s / n
          if (world.solid(b.p[0] + (q[0] - b.p[0]) * f, b.p[1] + (q[1] - b.p[1]) * f, b.p[2] + (q[2] - b.p[2]) * f)) blocked = true
        }
      }
      b.trav += b.speed * dt
      if (hit) damage(hit, b.owner, b.dmg, b.owner.kind === "npc" ? "npc" : "gun", b.p, t)
      if (hit || blocked || b.trav > b.range) bullets.splice(i, 1)
      else b.p = q
    }
    // shells
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i]
      s.v[2] -= W.mortar.gravity * dt
      const q = [s.p[0] + s.v[0] * dt, s.p[1] + s.v[1] * dt, s.p[2] + s.v[2] * dt]
      const foes = s.owner === A ? [...hunters, ...npcs, ...crates].filter((h) => h.hp > 0) : A.hp > 0 ? [A] : []
      const direct = foes.find((f) => segHits(s.p, q, f))
      s.age += dt
      if (direct || world.solid(q[0], q[1], q[2]) || s.age > W.mortar.ttl) {
        for (const v of [A, ...hunters, ...(s.owner === A ? [...npcs, ...crates] : [])]) {
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
    // deaths: a dead mech drops every weapon except the gun
    for (const h of hunters)
      if (h.hp <= 0 && !(h as any).counted) {
        ;(h as any).counted = true
        if (PICKUPS && h.second) pickups.push({ id: pickupId++, kind: h.second, pos: [...h.pos] })
        if (FARM) dropCubes(h.pos, cfg.cubes.death_drop_extra)
        kills++
        A.events.push({ type: "kill", target: h.id })
        if (VERBOSE) console.log(`  t=${t.toFixed(1)} killed ${h.type!.name} #${h.id}; A hp ${A.hp.toFixed(0)}`)
      }
    for (const n of npcs)
      if (n.hp <= 0 && !(n as any).counted) {
        ;(n as any).counted = true
        dropCubes(n.pos, cfg.npc.cubes)
      }
    for (const c of crates)
      if (c.hp <= 0 && !(c as any).counted) {
        ;(c as any).counted = true
        dropCubes(c.pos, cfg.crates.cubes)
        if (PICKUPS && rand() < cfg.loot.crate_weapon_chance) pickups.push({ id: pickupId++, kind: (["mortar", "laser", "lightning"] as Weapon2[])[Math.floor(rand() * 3)], pos: [...c.pos] })
      }
    if (DROPS && cfg.drops) {
      for (const callT of cfg.drops.times as number[])
        if (t >= callT && !drops.some((d) => d.callT === callT)) {
          const [x, y] = pick(ax, ay, 0, 250)
          drops.push({ id: 20000 + drops.length, pos: [x, y, world.groundAt(x, y)], callT, landT: callT + cfg.drops.fall_s, progress: 0, holder: null, taken: false })
        }
      for (const d of drops) {
        if (d.taken || t < d.landT) continue
        const inRing = (m: Mech) => m.hp > 0 && hyp2(m.pos, d.pos) <= cfg.drops.radius
        const hunterIn = hunters.some(inRing)
        if (inRing(A) && !hunterIn) {
          if (d.holder !== 0) d.progress = 0
          d.holder = 0
          d.progress += dt
          if (d.progress >= cfg.drops.capture_s) {
            d.taken = true
            dropsCaptured++
            gainCubes(cfg.drops.cubes, t)
            A.hp = A.maxHp
            A.energy = M.energy
            A.events.push({ type: "drop", id: d.id, cubes: A.cubes })
            if (VERBOSE) console.log(`  t=${t.toFixed(1)} captured drop ${d.id}`)
          }
        } else if (!inRing(A) && !hunterIn) {
          d.progress = 0
          d.holder = null
        }
      }
    }
    for (let i = cubes.length - 1; i >= 0; i--) {
      const c = cubes[i]
      if (hyp2(c.pos, A.pos) <= cfg.cubes.pickup_radius && Math.abs(c.pos[2] - A.pos[2]) <= 4) {
        cubes.splice(i, 1)
        gainCubes(1, t)
        A.events.push({ type: "pickup", cubes: A.cubes })
      }
    }
    t += dt
    tick++
  }
  send({ type: "end", place: 1, kills })
  bot.kill()
  const hShots = hunters.reduce((a, h) => a + h.shots, 0)
  const hHits = hunters.reduce((a, h) => a + h.hits, 0)
  const activeH = hunters.filter((h) => h.hp > 0)
  return { dropsCaptured, cubes: A.cubes, upgrades: A.upgrades, dealtBy: A.dealtBy, shotsBy: A.shotsBy, takenBy: A.takenBy, activeAtDeath: A.hp <= 0 ? activeH.length : -1, mortarAtDeath: activeH.filter((h) => h.second === "mortar").length, hpAtFightStart: [], kills, time: t, taken: A.taken, aHit: A.hits / Math.max(1, A.shots), hHit: hHits / Math.max(1, hShots), aShots: A.shots, hShots, slowest, armedAt, armedWith: A.second }
}

const results: Result[] = []
for (let r = 0; r < RUNS; r++) {
  const res = await run(SEED * 1000 + r)
  results.push(res)
  console.log(`run ${r + 1}: ${res.kills} kills, died at ${res.time.toFixed(0)} s, our hit% ${(res.aHit * 100).toFixed(0)}, hunters' hit% ${(res.hHit * 100).toFixed(0)}, slowest answer ${res.slowest.toFixed(0)} ms`)
}
const mean = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0) / results.length
const db: Record<string, number> = {}
const sb: Record<string, number> = {}
for (const r of results) {
  for (const [k, v] of Object.entries(r.dealtBy)) db[k] = (db[k] ?? 0) + v / results.length
  for (const [k, v] of Object.entries(r.shotsBy)) sb[k] = (sb[k] ?? 0) + v / results.length
}
console.log(`our damage per run by weapon: ${JSON.stringify(Object.fromEntries(Object.entries(db).map(([k, v]) => [k, Math.round(v)])))}; shots per run: ${JSON.stringify(Object.fromEntries(Object.entries(sb).map(([k, v]) => [k, Math.round(v)])))}`)
const tb: Record<string, number> = {}
for (const r of results) for (const [k, v] of Object.entries(r.takenBy)) tb[k] = (tb[k] ?? 0) + v / results.length
const deaths = results.filter((r) => r.activeAtDeath >= 0)
const act: Record<number, number> = {}
for (const r of deaths) act[r.activeAtDeath] = (act[r.activeAtDeath] ?? 0) + 1
console.log(`damage taken per run by weapon: ${JSON.stringify(Object.fromEntries(Object.entries(tb).map(([k, v]) => [k, Math.round(v)])))}; hunters alive when we died: ${JSON.stringify(act)}`)
console.log(`supply drops captured per run: ${(results.reduce((a, r) => a + r.dropsCaptured, 0) / results.length).toFixed(2)}; alive at 95 s (first drop lands): ${results.filter((r) => r.time > 95).length}/${results.length}`)
console.log(`cubes at death: mean ${(results.reduce((a, r) => a + r.cubes, 0) / results.length).toFixed(1)}; upgrades per run ${(results.reduce((a, r) => a + r.upgrades.length, 0) / results.length).toFixed(1)}`)
const armed = results.filter((r) => r.armedAt !== null)
console.log(`armed (laser or mortar) in ${armed.length}/${results.length} runs, median at ${armed.length ? armed.map((r) => r.armedAt!).sort((a, b) => a - b)[Math.floor(armed.length / 2)].toFixed(0) : "-"} s; holding at death: ${JSON.stringify(results.reduce((c: Record<string, number>, r) => ((c[r.armedWith || "none"] = (c[r.armedWith || "none"] ?? 0) + 1), c), {}))}`)
console.log(`ARENA ${WEAPON || "gun"} ${ENV}: kills mean ${mean((r) => r.kills).toFixed(2)} (min ${Math.min(...results.map((r) => r.kills))}, max ${Math.max(...results.map((r) => r.kills))}), survived ${mean((r) => r.time).toFixed(0)} s, our hit% ${(mean((r) => r.aHit) * 100).toFixed(0)}, hunters' hit% ${(mean((r) => r.hHit) * 100).toFixed(0)}`)
