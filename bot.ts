/**
 * Survivor bot for mechfight/1.
 *
 * Priorities, in order:
 *  1. Stay safe from the zone: always head for a spot well inside the *next* circle.
 *  2. Fight what can hurt you: face attackers (rear hits cost x1.5), lead shots, strafe.
 *  3. Back off to cover when hurt or outnumbered, and let regen work.
 *  4. When nothing threatens: collect cubes and weapons, break crates, farm NPC drones.
 */
import { type ActorObs, type BotAction, draw, type Hello, log, type Observation, run, type Vec3 } from "./mechfight.ts"
import { World } from "./world.ts"

type P2 = [number, number]
const TAU = Math.PI * 2
const wrap = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI
const d2 = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1])
const yawTo = (a: number[], b: number[]) => Math.atan2(b[1] - a[1], b[0] - a[0])

// Upgrade preference without a laser: survival first, then gun, then the rest.
// (Gauntlet sim: without a laser the order makes no measurable difference.)
const UPGRADE_ORDER = [
  "plating", "armor", "nanites", "gun_damage", "gun_rate",
  "laser_damage", "laser_charge", "lightning_efficiency", "lightning_range", "mortar_reload",
  "gun_mag", "servos", "gyros", "sensors", "gun_velocity", "capacitor", "reactor", "jets",
  "mortar_splash", "mortar_velocity", "lightning_chain", "laser_pierce",
]
// With a laser, damage first: gauntlet sim (16 runs) kills before death: no upgrade 5.19,
// laser_damage 8.00, laser_charge 6.00, armor 5.50, plating 5.19.
const LASER_UPGRADE_ORDER = ["laser_damage", "laser_charge", ...UPGRADE_ORDER.filter((u) => u !== "laser_damage" && u !== "laser_charge")]
// Weapon preference for the second slot.
const WEAPON_RANK: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }

type Threat = { bearing: number; by: number | null; t: number }

// Fighting knobs. Defaults are the submitted behavior; tools/duel.py overrides them with env vars to compare.
const knob = (name: string, dflt: number) => {
  const v = Number(process.env[`BOT_${name}`])
  return Number.isFinite(v) && process.env[`BOT_${name}`] !== undefined ? v : dflt
}
const K = {
  want: knob("WANT", 90), // preferred fight distance with the gun alone, m
  band: knob("BAND", 30), // no radial movement within want +- band
  wantLaser: knob("WANT_LASER", 90), // ... when holding a laser (hitscan, 280 m)
  wantLightning: knob("WANT_LIGHTNING", 90), // ... with lightning (45 m reach). Duel sim: closing in to 20-30 m loses (opponents back off; we take fire chasing)
  bandLightning: knob("BAND_LIGHTNING", 8),
  wantMortar: knob("WANT_MORTAR", 120), // ... with a mortar (lobbed, splash hurts us up close)
  radial: knob("RADIAL", 0.8), // weight of closing/opening distance vs sideways
  flipMin: knob("FLIP_MIN", 0.8), // strafe direction lasts flipMin + rand * flipRand s
  flipRand: knob("FLIP_RAND", 1.4),
  flipOnHit: knob("FLIP_ON_HIT", 1), // reverse strafe when hit
  retreatHp: knob("RETREAT_HP", 0.3), // retreat below this HP fraction if the target is not weaker
  boostFight: knob("BOOST_FIGHT", 40), // boost while strafing when energy is above this (0 = never); duel sim: -30% damage taken
}

run((hello: Hello) => {
  const cfg = hello.config
  const t0 = performance.now()
  const world = new World(hello.map.dir)
  // Warm up the JIT on the hot paths now (hello allows 20 s), so the first decisions are not late.
  for (let i = 0; i < 30; i++) {
    world.path(-200 + i * 7, -100, 150, 120 - i * 5, 20000)
    world.clear([0, 0, 5], [150 - i, 90, 12], 1.5)
  }
  log(`map loaded and warmed up in ${(performance.now() - t0).toFixed(0)} ms`)

  let rng = hello.seed >>> 0 || 1
  const rand = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296)

  // navigation state
  let path: P2[] = []
  let pathGoal: P2 | null = null
  let lastPlan = -999
  // stuck detection
  const hist: P2[] = []
  let unstickUntil = 0
  // combat state
  let strafeSign = 1
  let nextStrafeFlip = 0
  let lastThreat: Threat | null = null
  let scanYaw = 0
  // Weapons on the ground never despawn: remember every one we have seen.
  const knownPickups = new Map<number, { kind: string; pos: Vec3 }>()

  function planTo(me: Vec3, goal: P2, tick: number) {
    const moved = !pathGoal || d2(pathGoal, goal) > 6
    if (moved || tick - lastPlan > 20 || path.length === 0) {
      path = world.path(me[0], me[1], goal[0], goal[1], 6000) ?? [goal]
      pathGoal = goal
      lastPlan = tick
    }
    // drop waypoints already reached
    while (path.length > 1 && d2(me, path[0]) < 2.5) path.shift()
    if (path.length > 1 && world.walkLine([me[0], me[1]], path[1])) path.shift()
    const wp = path[0] ?? goal
    const yaw = yawTo(me, wp)
    const dist = d2(me, goal)
    const speed = dist < 1.5 ? 0 : dist < 6 ? 0.5 : 1
    return { move: [Math.cos(yaw) * speed, Math.sin(yaw) * speed] as P2, yaw, wp }
  }

  /** The safe anchor: inside the next circle with a margin, moving as little as possible. */
  function zoneAnchor(obs: Observation): P2 {
    const me = obs.self.pos
    const z = obs.zone
    // during a shrink, the circle that matters soonest is somewhere between current and next
    const c = z.next_center
    const safeR = Math.max(0, z.next_radius * 0.6)
    const d = d2(me, c)
    if (d <= safeR) return [me[0], me[1]]
    const yaw = yawTo(c, me)
    return [c[0] + Math.cos(yaw) * safeR, c[1] + Math.sin(yaw) * safeR]
  }

  /**
   * Seconds to spare before we must start walking to the anchor: the next circle is final at
   * shrink_end, and we need dist / walk_speed (with a margin for detours) to get there.
   */
  const zoneSlack = (obs: Observation, anchor: P2) => {
    const speed = obs.self.stats.walk_speed ?? cfg.mech.walk_speed
    return obs.zone.shrink_end - obs.t - (d2(obs.self.pos, anchor) / speed) * 1.5
  }

  /** Enemy body center, scaled by its cubes. */
  const center = (m: ActorObs): Vec3 => {
    const s = 1 + (cfg.cubes.size_per_cube as number) * (m.cubes ?? 0)
    const h = m.kind === "npc" ? cfg.npc.height : cfg.mech.height
    return [m.pos[0], m.pos[1], m.pos[2] + (h * s) / 2]
  }

  function leadPoint(from: Vec3, m: ActorObs, speed: number): Vec3 {
    const c = center(m)
    let t = Math.hypot(c[0] - from[0], c[1] - from[1], c[2] - from[2]) / speed
    for (let i = 0; i < 2; i++) {
      const p = [c[0] + m.vel[0] * t, c[1] + m.vel[1] * t, c[2] + m.vel[2] * t]
      t = Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]) / speed
    }
    return [c[0] + m.vel[0] * t, c[1] + m.vel[1] * t, c[2] + Math.max(0, m.vel[2]) * t]
  }

  /** Mortar pitch to hit a point dx away horizontally and dz above; null if out of range. */
  function mortarPitch(dx: number, dz: number, v: number, g: number, high: boolean) {
    const disc = v ** 4 - g * (g * dx * dx + 2 * dz * v * v)
    if (disc < 0) return null
    const r = Math.sqrt(disc)
    return Math.atan((v * v + (high ? r : -r)) / (g * dx))
  }

  return {
    name: "survivor",
    act(obs: Observation): BotAction {
      const me = obs.self
      const pos = me.pos
      const tick = obs.tick
      const t = obs.t
      const muzzle: Vec3 = [pos[0], pos[1], pos[2] + (me.stats.muzzle_height ?? cfg.mech.muzzle_height)]
      const eye: Vec3 = [pos[0], pos[1], pos[2] + (me.stats.eye_height ?? cfg.mech.eye_height)]
      const act: BotAction = {}

      // ---- events ----
      for (const e of obs.events) {
        if (e.type === "damaged" && e.weapon !== "zone" && e.bearing !== null) {
          lastThreat = { bearing: e.bearing, by: e.by, t }
          // their aim has caught up with our current path: change direction now
          if (K.flipOnHit && t > nextStrafeFlip - 1.5) {
            strafeSign = -strafeSign
            nextStrafeFlip = t + 0.6 + rand() * 1.2
          }
        }
      }

      // ---- upgrades ----
      if (obs.offer) {
        let best = 0
        let bestRank = Infinity
        const order = me.weapons.some((w) => w?.kind === "laser") ? LASER_UPGRADE_ORDER : UPGRADE_ORDER
        obs.offer.choices.forEach((c, i) => {
          const r = order.indexOf(c.id)
          const rank = r < 0 ? 99 : r
          if (rank < bestRank) {
            bestRank = rank
            best = i
          }
        })
        act.pick = best
      }

      // ---- weapon memory ----
      for (const p of obs.pickups) knownPickups.set(p.id, { kind: p.kind, pos: p.pos })
      const seenIds = new Set(obs.pickups.map((p) => p.id))
      for (const [id, p] of knownPickups) {
        // close enough that our proximity sensors would show it, but it is gone: someone took it
        if (!seenIds.has(id) && d2(p.pos, pos) < 35) knownPickups.delete(id)
      }
      for (const e of obs.events) if (e.type === "take_failed" && e.reason !== "range" && e.reason !== "busy") knownPickups.delete(e.id)

      // ---- what we see ----
      const mechs = obs.mechs.filter((m) => m.kind === "mech")
      const npcs = obs.mechs.filter((m) => m.kind === "npc")
      const hpFrac = me.hp / me.max_hp
      const near = mechs.filter((m) => d2(m.pos, pos) < 120)
      const shootable = (m: ActorObs) => world.clear(muzzle, center(m), 1.5)

      // target: the attacker if visible, else the visible mech we can hit that is closest / weakest
      let target: ActorObs | null = null
      let targetClear = false
      const attacker = lastThreat && t - lastThreat.t < 3 ? mechs.find((m) => m.id === lastThreat!.by) : undefined
      const ranked = [...mechs].sort((a, b) => d2(a.pos, pos) + (a.hp ?? 0) / 20 - (d2(b.pos, pos) + (b.hp ?? 0) / 20))
      for (const m of attacker ? [attacker, ...ranked] : ranked) {
        if (d2(m.pos, pos) > (me.weapons[0]?.stats.range ?? 230) + 60) continue
        const c = shootable(m)
        if (c || !target) {
          target = m
          targetClear = c
        }
        if (c) break
      }

      // ---- movement goal ----
      const anchor = zoneAnchor(obs)
      let goal: P2 = anchor
      let mode = "hold"
      const outside = !me.in_zone
      const slack = zoneSlack(obs, anchor)
      const urgent = d2(pos, anchor) > 1 && (outside || slack < 12)
      const threatened = mechs.length > 0 || (lastThreat !== null && t - lastThreat.t < 4)
      // Retreat only when it pays: low and the fight is not going our way, or badly outnumbered.
      // Backing away from a single attacker mostly hands it free shots.
      const targetFrac = target && target.hp !== undefined && target.max_hp ? target.hp / target.max_hp : 1
      const retreat = threatened && ((hpFrac < K.retreatHp && targetFrac >= hpFrac) || near.length >= 3)
      const safeR = obs.zone.next_radius * 0.6
      const insideSafe = (p: number[]) => d2(p, obs.zone.next_center) <= Math.max(safeR, 15)

      if (urgent) {
        mode = outside ? "zone!" : "to zone"
      } else if (retreat) {
        // move away from threats, staying inside the safe circle; prefer points threats can't see
        mode = "retreat"
        const threats = mechs.length ? mechs.map((m) => m.pos) : lastThreat ? [[pos[0] + Math.cos(lastThreat.bearing) * 80, pos[1] + Math.sin(lastThreat.bearing) * 80, pos[2]]] : []
        let best: P2 = anchor
        let bestScore = -Infinity
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU
          for (const r of [15, 30, 45]) {
            const p: P2 = [pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r]
            const [gi, gj] = world.navOf(p[0], p[1])
            if (!world.walkable(gi, gj) || !insideSafe(p)) continue
            const pz = world.groundAt(p[0], p[1])
            let score = -r * 0.3
            for (const th of threats) {
              score += Math.min(d2(th, p), 200) * 0.2
              if (!world.clear([th[0], th[1], th[2] + 8], [p[0], p[1], pz + 7], 2)) score += 60
            }
            if (score > bestScore) {
              bestScore = score
              best = p
            }
          }
        }
        goal = best
      } else if (target) {
        // fight: hold a mid-range distance and strafe
        mode = "fight"
        if (t > nextStrafeFlip) {
          strafeSign = rand() < 0.5 ? -1 : 1
          nextStrafeFlip = t + K.flipMin + rand() * K.flipRand
        }
        const dist = d2(target.pos, pos)
        const toT = yawTo(pos, target.pos)
        // preferred distance depends on what the second slot can reach
        const kind2 = me.weapons[1]?.kind
        const want = kind2 === "lightning" ? K.wantLightning : kind2 === "laser" ? K.wantLaser : kind2 === "mortar" ? K.wantMortar : K.want
        const band = kind2 === "lightning" ? K.bandLightning : K.band
        const radial = dist > want + band ? 1 : dist < want - band ? -1 : 0
        const side = toT + (strafeSign * Math.PI) / 2
        const mx = Math.cos(side) + radial * Math.cos(toT) * K.radial
        const my = Math.sin(side) + radial * Math.sin(toT) * K.radial
        const p: P2 = [pos[0] + mx * 12, pos[1] + my * 12]
        goal = insideSafe(p) ? p : anchor
      } else {
        // free time: loot inside the safe area
        const inReach = (p: number[], r: number) => d2(p, pos) < r && insideSafe(p)
        const cube = obs.cubes.filter((c) => inReach(c.pos, 70)).sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0]
        const want2 = !me.weapons[1]
        // Any remembered weapon better than what we hold. A laser is worth a long walk (duel sim:
        // gun + laser wins 6/6 against gun only), the others less so. Roof pickups are skipped:
        // the walk grid is ground-only.
        const reachKm = (kind: string) => (kind === "laser" ? 250 : 100)
        let pick: { id: number; kind: string; pos: Vec3 } | undefined
        let pickCost = Infinity
        for (const [id, p] of knownPickups) {
          const better = want2 || WEAPON_RANK[p.kind] > WEAPON_RANK[me.weapons[1]!.kind]
          if (!better || me.weapons.some((w) => w?.kind === p.kind)) continue
          if (p.pos[2] > world.groundAt(p.pos[0], p.pos[1]) + 3) continue
          const dist = d2(p.pos, pos)
          // outside the safe circle is fine while there is time to come back afterwards
          const detour = (dist / (me.stats.walk_speed ?? cfg.mech.walk_speed)) * 2
          if (dist > reachKm(p.kind) || (!insideSafe(p.pos) && slack - detour < 20) || (dist > 80 && slack < 25)) continue
          const cost = dist - WEAPON_RANK[p.kind] * 40
          if (cost < pickCost) {
            pickCost = cost
            pick = { id, ...p }
          }
        }
        const drop = (obs.drops ?? []).find((d) => d.lands_in <= 3 && inReach(d.pos, 90) && hpFrac > 0.3)
        if (cube) {
          goal = [cube.pos[0], cube.pos[1]]
          mode = "cube"
        } else if (pick) {
          goal = [pick.pos[0], pick.pos[1]]
          mode = `get ${pick.kind}`
          if (d2(pick.pos, pos) < cfg.loot.pickup_radius - 0.3) {
            act.take = pick.id
            if (!want2) act.drop = 1
          }
        } else if (drop) {
          goal = [drop.pos[0], drop.pos[1]]
          mode = "drop"
        } else if (Math.hypot(...[0, 1].map((i) => pos[i] - anchor[i])) > 2) {
          mode = "to zone"
        }
      }

      // ---- movement ----
      const nav = planTo(pos, goal, tick)
      act.move = nav.move
      // stuck: commanded to move but barely moved for ~1 s -> jump and jet, then replan
      hist.push([pos[0], pos[1]])
      if (hist.length > 10) hist.shift()
      const moving = Math.hypot(...nav.move) > 0.4
      if (moving && hist.length === 10 && d2(hist[0], hist[9]) < 2 && t > unstickUntil) {
        unstickUntil = t + 0.8
        lastPlan = -999
      }
      if (t < unstickUntil) {
        act.jump = me.grounded
        act.boost = !me.grounded && me.energy > 10
      } else {
        act.boost = me.energy > 30 && (mode === "zone!" || mode === "retreat" || (mode === "to zone" && d2(pos, goal) > 60) || (K.boostFight > 0 && mode === "fight" && me.energy > K.boostFight))
      }

      // ---- aim and fire ----
      const gun = me.weapons[0]
      const second = me.weapons[1]
      let aimYaw = nav.yaw
      let aimPitch = 0
      const fire: [boolean, boolean] = [false, false]

      const crate = !target ? obs.crates.filter((c) => d2(c.pos, pos) < 60 && world.clear(muzzle, [c.pos[0], c.pos[1], c.pos[2] + 1.2], 1.5)).sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0] : undefined
      const npc = !target && hpFrac > 0.6 && t < 330 ? npcs.filter((n) => d2(n.pos, pos) < 70 && shootable(n)).sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0] : undefined
      const shootAt: ActorObs | null = target ?? npc ?? null

      if (shootAt) {
        const dist = d2(shootAt.pos, pos)
        const useMortar = second?.kind === "mortar" && second.cooldown <= 0 && shootAt.kind === "mech" && dist > 30 && dist < 230
        if (useMortar) {
          const m = cfg.weapons.mortar
          const v = second.stats.speed ?? m.speed
          const g = m.gravity
          const c = center(shootAt)
          const lowClear = targetClear
          let pitch = mortarPitch(dist, c[2] - (pos[2] + me.stats.height + 0.5), v, g, !lowClear)
          if (pitch !== null) {
            const tof = dist / (v * Math.cos(pitch))
            const lp: P2 = [shootAt.pos[0] + shootAt.vel[0] * tof, shootAt.pos[1] + shootAt.vel[1] * tof]
            pitch = mortarPitch(d2(lp, pos), c[2] - (pos[2] + me.stats.height + 0.5), v, g, !lowClear) ?? pitch
            aimYaw = yawTo(pos, lp)
            aimPitch = pitch
            const err = Math.abs(wrap(me.aim[0] - aimYaw)) + Math.abs(me.aim[1] - aimPitch)
            fire[1] = err < 0.04
          }
        } else {
          const speed = gun?.stats.speed ?? cfg.weapons.gun.speed
          const laser = second?.kind === "laser" && shootAt.kind === "mech" ? second : null
          const laserFull = laser ? (laser.stats.charge ?? cfg.weapons.laser.charge) : 0
          const laserCharge = laser?.charge ?? 0
          // The laser is hitscan: once it is nearly charged, aim at where the target is (plus one
          // decision of travel), not at the gun's bullet lead point, which is metres ahead.
          const c = center(shootAt)
          const lp: Vec3 = laser && laserCharge >= laserFull * 0.6
            ? [c[0] + shootAt.vel[0] * 0.1, c[1] + shootAt.vel[1] * 0.1, c[2]]
            : leadPoint(muzzle, shootAt, speed)
          aimYaw = yawTo(pos, lp)
          aimPitch = Math.atan2(lp[2] - muzzle[2], d2(lp, pos))
          const tol = Math.atan2(cfg.mech.radius * 0.8, Math.max(dist, 1)) + 0.01
          const err = Math.max(Math.abs(wrap(me.aim[0] - aimYaw)), Math.abs(me.aim[1] - aimPitch))
          const clear = shootAt === target ? targetClear : true
          const range = gun?.stats.range ?? 230
          if (gun && clear && dist < range && err < tol) {
            if ((gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0) fire[0] = true
          }
          if (second?.kind === "lightning" && clear && dist < (second.stats.range ?? 45) - 2 && Math.abs(wrap(me.aim[0] - aimYaw)) < 0.2 && me.energy > 10) fire[1] = true
          if (laser) {
            const inRange = dist < (laser.stats.range ?? 280) - 10
            if (laserCharge > 0) {
              // keep holding until fully charged, the shot is clear and the torso is on target;
              // letting go fires the beam (a full charge also fires on its own after hold_s)
              const ready = laserCharge >= laserFull * 0.97 && clear && inRange && err < tol
              fire[1] = !ready
            } else if (laser.cooldown <= 0 && clear && inRange) {
              fire[1] = true
            }
          }
        }
      } else if (crate) {
        aimYaw = yawTo(pos, crate.pos)
        aimPitch = Math.atan2(crate.pos[2] + 1.2 - muzzle[2], d2(crate.pos, pos))
        const err = Math.max(Math.abs(wrap(me.aim[0] - aimYaw)), Math.abs(me.aim[1] - aimPitch))
        if (err < 0.05 && gun && (gun.ammo ?? 1) > 0) fire[0] = true
      } else if (lastThreat && t - lastThreat.t < 4) {
        // turn toward an unseen attacker: protects the rear and brings it into view
        aimYaw = lastThreat.bearing
      } else {
        // nothing to shoot: sweep the whole circle to spot weapons, cubes and enemies
        // (vision is a 120 deg wedge out to 200 m; proximity sensors only reach 45 m)
        scanYaw = wrap(scanYaw + 0.12)
        aimYaw = scanYaw
      }
      // reload while nothing to shoot
      if (gun && !shootAt && (gun.ammo ?? 12) < (gun.stats.mag ?? 12) * 0.5 && (gun.reload ?? 0) <= 0) act.reload = true

      act.aim = [wrap(aimYaw), Math.max(cfg.mech.min_pitch, Math.min(cfg.mech.max_pitch, aimPitch))]
      act.fire = fire

      // ---- debug ----
      draw.label(`${mode} hp${Math.round(hpFrac * 100)} s${Math.round(slack)} ${target ? `T${target.id}${targetClear ? "" : "?"}` : ""}`)
      if (path.length) draw.line([pos[0], pos[1], pos[2] + 1], [nav.wp[0], nav.wp[1], pos[2] + 1], "#40c0ff")
      return act
    },
  }
})
