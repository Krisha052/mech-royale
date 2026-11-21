/**
 * Walking test on the real map: does bot.ts reach a far-away safe spot, or does it get stuck?
 *
 * Runs the real bot over the protocol with fake observations (no enemies). The physics is a
 * simplified version of protocol.md §7: acceleration toward the commanded velocity, walls stop
 * the part of a move that goes into them (sliding along), ledges up to step_up are walked up,
 * jump + jet (boost in the air), gravity, standing on roofs. Not the real server.
 *
 *   bun tools/walk-test.ts [trials=20] [seconds=60] [seed=1]
 *
 * Each trial: spawn at a random walkable spot, set the zone's next circle (radius 30) on a random
 * walkable spot 150-400 m away, and run until the bot is inside it or time runs out.
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { World } from "../world.ts"

const trials = Number(process.argv[2] ?? 20)
const seconds = Number(process.argv[3] ?? 60)
let seed = Number(process.argv[4] ?? 1)
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)

const stream = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n")
const hello = JSON.parse(stream[0])
hello.map.dir = "kit/arena"
const cfg = hello.config
const M = cfg.mech
const world = new World("kit/arena")

function randomWalkable(): [number, number] {
  for (;;) {
    const x = world.minX + 40 + rand() * (world.nx - 80)
    const y = world.minY + 40 + rand() * (world.ny - 80)
    const [gi, gj] = world.navOf(x, y)
    if (world.walkable(gi, gj)) return [x, y]
  }
}

/** Mech body overlaps a solid at (x, y) with feet at z? Samples the cylinder edge and center. */
function bodyBlocked(x: number, y: number, z: number) {
  const r = M.radius
  for (let k = 0; k <= 8; k++) {
    const px = k === 8 ? x : x + Math.cos((k / 8) * Math.PI * 2) * r
    const py = k === 8 ? y : y + Math.sin((k / 8) * Math.PI * 2) * r
    for (const h of [M.step_up + 0.1, 3, 5, 7, 8.9]) if (world.solid(px, py, z + h)) return true
  }
  return false
}

async function trial(n: number) {
  const bot = spawn("bun", ["bot.ts"], { stdio: ["pipe", "pipe", "ignore"] })
  const lines = createInterface({ input: bot.stdout! })
  const queue: string[] = []
  let waiting: ((s: string) => void) | null = null
  lines.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : queue.push(l)))
  const next = () => new Promise<string>((res) => (queue.length ? res(queue.shift()!) : (waiting = res)))
  const send = (o: unknown) => bot.stdin!.write(JSON.stringify(o) + "\n")

  const start = randomWalkable()
  let goal: [number, number]
  do goal = randomWalkable()
  while (Math.hypot(goal[0] - start[0], goal[1] - start[1]) < 150 || Math.hypot(goal[0] - start[0], goal[1] - start[1]) > 400)
  const pos = [start[0], start[1], world.groundAt(start[0], start[1])]
  const vel = [0, 0, 0]
  let aim: [number, number] = [0, 0]
  let energy = M.energy
  let lastSpend = -99
  let grounded = true
  let act: any = {}
  send({ ...hello, slot: 0, seed: 1000 + n })
  await next()
  const dt = 1 / cfg.match.tick_hz
  let t = 0
  let tick = 0
  let stuckTime = 0
  const R = 30
  let reached = -1
  while (t < seconds) {
    if (tick % cfg.match.decide_every === 0) {
      send({
        type: "obs", tick, t: +t.toFixed(2), alive: 16,
        self: { id: 0, pos: [...pos], vel: [...vel], aim, hp: 1400, max_hp: 1400, energy, max_energy: M.energy, grounded, cubes: 0, upgrades: [],
          weapons: [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: cfg.weapons.gun }, null], in_zone: true,
          stats: { radius: M.radius, height: M.height, eye_height: M.eye_height, muzzle_height: M.muzzle_height, walk_speed: M.walk_speed, boost_speed: M.boost_speed, turn_rate: M.turn_rate, hp: 1400 } },
        mechs: [], projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], drops: [], offer: null,
        // the next circle is the goal; shrinking soon so the bot must go now
        zone: { center: [goal[0], goal[1]], radius: 2000, next_center: goal, next_radius: R, shrink_start: t, shrink_end: t + 30, dps: 20 },
      })
      act = JSON.parse(await next())
      if (act.aim) aim = act.aim
    }
    // horizontal
    const mv = act.move ?? [0, 0]
    const L = Math.hypot(mv[0], mv[1])
    const m = L > 1 ? [mv[0] / L, mv[1] / L] : mv
    const boosting = !!act.boost && energy > 0
    const spd = boosting && grounded ? M.boost_speed : M.walk_speed
    const acc = (grounded ? M.ground_accel : M.air_accel) * dt
    for (const k of [0, 1]) {
      const dv = m[k] * spd - vel[k]
      vel[k] += Math.max(-acc, Math.min(acc, dv))
    }
    // vertical
    if (act.jump && grounded) {
      vel[2] = M.jump_speed
      grounded = false
    }
    if (boosting && !grounded) vel[2] = Math.min(M.max_rise_speed, vel[2] + M.jet_accel * dt)
    if (boosting) {
      energy = Math.max(0, energy - (grounded ? M.boost_drain : M.jet_drain) * dt)
      lastSpend = t
    } else if (t - lastSpend > M.energy_regen_delay) energy = Math.min(M.energy, energy + M.energy_regen * dt)
    vel[2] -= M.gravity * dt
    // move with wall sliding: try full move, then x only, then y only
    const before = [pos[0], pos[1]]
    const tryAt = (x: number, y: number) => {
      const stand = world.standZ(x, y, pos[2])
      const z = Math.max(pos[2], stand)
      if (stand - pos[2] > M.step_up + 0.01 && grounded) return false // a ledge too tall to walk up
      return !bodyBlocked(x, y, Math.max(z, stand))
    }
    const nx = pos[0] + vel[0] * dt
    const ny = pos[1] + vel[1] * dt
    if (tryAt(nx, ny)) {
      pos[0] = nx
      pos[1] = ny
    } else if (tryAt(nx, pos[1])) {
      pos[0] = nx
      vel[1] = 0
    } else if (tryAt(pos[0], ny)) {
      pos[1] = ny
      vel[0] = 0
    } else {
      vel[0] = 0
      vel[1] = 0
    }
    const floor = world.standZ(pos[0], pos[1], pos[2] + 0.01)
    pos[2] += vel[2] * dt
    if (pos[2] <= floor) {
      pos[2] = floor
      vel[2] = 0
      grounded = true
    } else if (pos[2] - floor > 0.05) grounded = false
    // bookkeeping
    const moved = Math.hypot(pos[0] - before[0], pos[1] - before[1])
    if (L > 0.4 && moved < 0.2 * M.walk_speed * dt) stuckTime += dt
    t += dt
    tick++
    if (Math.hypot(pos[0] - goal[0], pos[1] - goal[1]) <= R) {
      reached = t
      break
    }
  }
  send({ type: "end", place: 1, kills: 0 })
  bot.kill()
  const straight = Math.hypot(goal[0] - start[0], goal[1] - start[1]) - R
  const left = Math.hypot(pos[0] - goal[0], pos[1] - goal[1]) - R
  return { reached, straight, left, stuckTime, start, goal, end: [pos[0], pos[1]] }
}

let ok = 0
let stuckTotal = 0
const fails: string[] = []
for (let n = 0; n < trials; n++) {
  const r = await trial(n)
  stuckTotal += r.stuckTime
  if (r.reached >= 0) ok++
  else fails.push(`  trial ${n}: ${r.left.toFixed(0)} m short of ${r.straight.toFixed(0)} m; from (${r.start.map((v) => v.toFixed(0))}) to (${r.goal.map((v) => v.toFixed(0))}), ended at (${r.end.map((v) => v.toFixed(0))})`)
  console.log(`trial ${n}: ${r.reached >= 0 ? `arrived in ${r.reached.toFixed(1)} s` : "DID NOT ARRIVE"} (straight-line ${r.straight.toFixed(0)} m, ideal ${(r.straight / M.walk_speed).toFixed(1)} s walking), stuck ${r.stuckTime.toFixed(1)} s`)
}
console.log(`arrived ${ok}/${trials}, average stuck time ${(stuckTotal / trials).toFixed(1)} s per trial`)
if (fails.length) console.log("failures:\n" + fails.join("\n"))
