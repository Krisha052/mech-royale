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
const REAL_WINNER_ORDER = ["armor", "nanites", "plating", "gun_damage", "gun_rate", "gun_mag", "laser_damage", "laser_charge", "servos",
  ...UPGRADE_ORDER.filter((u) => !["armor", "nanites", "plating", "gun_damage", "gun_rate", "gun_mag", "laser_damage", "laser_charge", "servos"].includes(u))]
// Weapon preference for the second slot.
// Real-map arena sim (30 runs, kills before death): laser 4.13, mortar 3.30, lightning 1.75, none 1.6.
const WEAPON_RANK: Record<string, number> = { laser: 3, mortar: 2, lightning: 1, gun: 0 }

type Threat = { bearing: number; by: number | null; t: number }

// Fighting knobs. Defaults are the submitted behavior; tools/duel.py overrides them with env vars to compare.
const knob = (name: string, dflt: number) => {
  const v = Number(process.env[`BOT_${name}`])
  return Number.isFinite(v) && process.env[`BOT_${name}`] !== undefined ? v : dflt
}
const K = {
  // Preferred fight distances. Real-map arena sim (30 runs, kills before death): gun 140 m 2.00 vs
  // 90 m 1.63; laser 180 m 4.13 vs 140 m 3.60 vs 90 m 3.25; mortar 120-160 m ~3.3. House bots
  // fight at ~55 m and miss more with range, while our led shots stay accurate.
  want: knob("WANT", 75), // preferred fight distance with the gun alone, m
  band: knob("BAND", 30), // no radial movement within want +- band
  wantLaser: knob("WANT_LASER", 110), // ... when holding a laser (hitscan, 280 m)
  wantLightning: knob("WANT_LIGHTNING", 140), // ... with lightning (45 m reach): fight like the gun; closing in loses in both sims
  bandLightning: knob("BAND_LIGHTNING", 8),
  wantMortar: knob("WANT_MORTAR", 100), // ... with a mortar (lobbed; splash hurts us up close)
  radial: knob("RADIAL", 0.8), // weight of closing/opening distance vs sideways
  flipMin: knob("FLIP_MIN", 0.8), // strafe direction lasts flipMin + rand * flipRand s
  flipRand: knob("FLIP_RAND", 1.4),
  flipOnHit: knob("FLIP_ON_HIT", 1), // reverse strafe when hit
  retreatHp: knob("RETREAT_HP", 0.3), // retreat below this HP fraction if the target is not weaker
  retreatN: knob("RETREAT_N", 3), // retreat when this many enemies are within 120 m
  fightPos: knob("FIGHT_POS", 0), // with 2+ enemies around, pick spots that keep our target in sight and hide us from the others
  fightPosEvery: knob("FIGHT_POS_EVERY", 5), // decisions between spot choices
  // Farming power cubes (+4% max HP and damage each, up to 10; upgrade offers at 1, 3, 6, 10).
  // Arena sim with a cube head start: 0 cubes 2.85 kills, 6 cubes 3.55, 10 cubes 4.95.
  farm: knob("FARM", 1), // in free time, go and shoot drones and ground crates for cubes (arena: 2.17 -> 2.73 kills, cubes at death 3.0 -> 6.1)
  farmUntil: knob("FARM_UNTIL", 420), // match time after which we stop farming, s
  farmRange: knob("FARM_RANGE", 250), // how far we walk for a drone or crate, m
  farmMinHp: knob("FARM_MIN_HP", 0.6), // arena (4 seeds x 30): 0.85 -> 2.72 kills vs 0.70 -> 2.52 // do not farm below this HP fraction
  npcStandoff: knob("NPC_STANDOFF", 70), // shoot drones from here (their aggro range is 45 m)
  cubeRange: knob("CUBE_RANGE", 200), // walk this far for a visible cube
  shootNpc: knob("SHOOT_NPC", 1), // shoot drones we happen to pass (when not farming)
  shootCrate: knob("SHOOT_CRATE", 1), // shoot crates we happen to pass (when not farming)
  grabInFight: knob("GRAB_IN_FIGHT", 80), // unarmed in a fight: move to a known laser/mortar within this many m (0 = off). Arena: armed 63% -> 92% of runs, kills 2.21 -> 2.60
  explore: knob("EXPLORE", 1), // unarmed and no weapon known: walk to unexplored ground to find one
  exploreUntil: knob("EXPLORE_UNTIL", 240), // stop exploring after this match time, s
  turtleT: knob("TURTLE_T", 100), // before this match time: avoid fights and let the house bots thin each other out (placement scoring)
  turtleR: knob("TURTLE_R", 180), // ... back away from any enemy closer than this
  turtleCorner: knob("TURTLE_CORNER", 35), // ... unless one is this close (then fight)
  turtleFireR: knob("TURTLE_FIRE_R", 50), // ... and hold fire unless hit in the last 3 s or an enemy is this close
  faceS: knob("FACE_S", 0), // after an enemy leaves our 5 s memory, keep the torso toward where it was for this long
  arcW: knob("ARC_W", 0), // target ranking: + this many metres per other enemy that would be behind us while we aim at it
  targetHpW: knob("TARGET_HP_W", 0.05), // target ranking = distance + hp * this (higher: finish wounded ones first)
  upgMode: knob("UPG_MODE", 7), // 0: laser damage first when holding a laser; 1 plating first; 2 armor first; 3 nanites first
  // Kite with a laser: hold a long distance (their accuracy falls with range, our led shots do
  // not) and back off firmly, boosting, when they close in. Vision ends at 200 m (+25 with sensors).
  kite: knob("KITE", 0),
  kiteDist: knob("KITE_DIST", 190),
  kiteBand: knob("KITE_BAND", 10),
  kiteRadial: knob("KITE_RADIAL", 2), // weight of backing off vs strafing
  kiteBoost: knob("KITE_BOOST", 15), // boost while backing off if energy is above this
  // Mortar from cover: with a mortar, stand where no enemy can see us and lob shells over the cover.
  mortarCover: knob("MORTAR_COVER", 0),
  mortarMin: knob("MORTAR_MIN", 80), // preferred lobbing distance band, m
  mortarMax: knob("MORTAR_MAX", 180),
  // Bullet dodging (Robocode-style): visible enemy bullets come with position and velocity;
  // sidestep the ones that would hit us within the next second.
  bulletDodge: knob("BULLET_DODGE", 1), // arena (4 seeds x 30): 2.94 -> 3.65 kills with margin 1, better on every seed
  bulletMargin: knob("BULLET_MARGIN", 1), // extra metres beyond our radius that count as a hit
  bulletHorizon: knob("BULLET_HORIZON", 1), // react to bullets arriving within this many seconds
  gravityLead: knob("GRAVITY_LEAD", 1), // lead airborne targets along a falling arc (not a straight line)
  // Threat-first targeting: count dangerous enemies as if they were this many metres closer.
  threat: knob("THREAT", 0),
  threatLaser: knob("THREAT_LASER", 80),
  threatCharging: knob("THREAT_CHARGING", 150),
  threatMortar: knob("THREAT_MORTAR", 30),
  // Split the pack: with 2+ enemies around, also move away from their centre while fighting.
  pack: knob("PACK", 0), // weight of the away-from-centre pull (0 = off)
  packRange: knob("PACK_RANGE", 250), // enemies within this count toward the centre
  npcFix: knob("NPC_FIX", 0), // shoot drones that are hurting us at any HP; no drone farming with hunters about
  roofSafe: knob("ROOF_SAFE", 0), // no roof climbing while under fire or below 60% HP
  // Supply drops: full heal + 3 cubes after standing in the ring alone for capture_s. Go for one
  // even during a fight (we keep shooting on the way), if it lands soon and is not too far.
  dropRush: knob("DROP_RUSH", 1),
  dropRange: knob("DROP_RANGE", 400), // m
  dropLead: knob("DROP_LEAD", 10), // start moving this many seconds before it lands
  dropMaxHp: knob("DROP_MAX_HP", 1.01), // only if our HP fraction is below this
  // Collect cubes during fights (killed mechs drop all their cubes + 2; each cube heals ~56 HP and adds
  // 4% damage). Public matches: the winner picks up kill cubes within seconds, mid-fight.
  cubeFight: knob("CUBE_FIGHT", 200), // real: 3.67 -> 4.10 with 120 m
  cubeMemory: knob("CUBE_MEMORY", 1), // remember cubes we have seen and where our kills died (their cubes drop there) // walk over visible cubes within this many m while fighting (0 = off)
  timing: knob("TIMING", 1), // timing safeguard (do less work when slow); simulations turn it off so CPU load does not change behaviour
  // Hit from behind by someone we cannot see: turn to face the shot for a moment so the attacker comes
  // into view (and our front armor faces it). Arena: ~83% of rear damage comes from unseen attackers.
  rearTurn: knob("REAR_TURN", 1),
  rearTurnS: knob("REAR_TURN_S", 1.0), // seconds to keep facing the shot
  // Back to the wall: while fighting, prefer nearby spots from which we can still hit the target but
  // where buildings block the directions behind us. Arena: most damage from behind comes from unseen
  // hunters 60-200 m away.
  backWall: knob("BACK_WALL", 0), // weight of rear cover (0 = off)
  backWallEvery: knob("BACK_WALL_EVERY", 5), // decisions between spot choices
  // Hearing (protocol §8): sounds give a bearing to unseen mechs. Idle: look toward the latest unexplained
  // sound. Fighting: glance toward unexplained gunfire / laser charging from behind, before it hits us.
  hear: knob("HEAR", 0),
  hearGlanceS: knob("HEAR_GLANCE_S", 0.6),
  hearRearDeg: knob("HEAR_REAR_DEG", 100), // only glance at sounds this far from where we are aiming
  // Laser peeking: start charging while the target is briefly out of sight (seen in the last few s),
  // so the beam fires the moment it reappears. Arena: a hunter is shootable only ~24 s per life.
  precharge: knob("PRECHARGE", 0),
  prechargeWindow: knob("PRECHARGE_WINDOW", 2), // s since the target was last in line of sight
  // Laser counter-play: a visible mech charging a laser at us (charging flag + its aim) will fire a
  // hitscan beam in under a second; step behind cover until it fires or stops charging.
  laserDodge: knob("LASER_DODGE", 0),
  laserDodgeAim: knob("LASER_DODGE_AIM", 0.1), // rad: how closely its aim must point at us
  // Check six during reloads: the gun cannot fire for 2.4 s anyway, so swing the turret to look behind and
  // back. Recorded matches: the best bot strikes first in 98% of its kills; ours ~41% (arena).
  glance: knob("GLANCE", 0),
  glanceSpread: knob("GLANCE_SPREAD", 2.6), // rad away from the target to look (pi = straight behind)
  // Engage by time-to-kill vs time-to-die (utility-AI / RTS micro practice): keep fighting only if we
  // would kill the target before the enemies that can see us kill us; otherwise disengage early.
  ttk: knob("TTK", 0),
  ttkMargin: knob("TTK_MARGIN", 1.0), // fight while ttk < ttd * margin
  enemyHit: knob("ENEMY_HIT", 0.35), // assumed enemy gun hit rate (house bots: ~35-60%)
  // Minimum-risk movement (Robocode melee): in fights, move to the nearby point with the lowest
  // risk = sum(enemy strength / distance^2, reduced if it cannot see the point) + penalties.
  minRisk: knob("MIN_RISK", 0),
  minRiskShoot: knob("MIN_RISK_SHOOT", 1.0), // penalty weight if we could not shoot our target from the point
  minRiskEvery: knob("MIN_RISK_EVERY", 5), // decisions between re-evaluations
  // Cube discipline: above stat_cap (10) cubes add nothing but size (5% each, uncapped).
  cubeMax: knob("CUBE_MAX", 999), // stop collecting cubes at this many
  cubeFightMinHp: knob("CUBE_FIGHT_MIN_HP", 0), // no mid-fight cube runs below this HP fraction
  dropMinHp: knob("DROP_MIN_HP", 0), // no drop rush below this HP fraction while an enemy is within 150 m
  dodge: knob("DODGE", 1), // move away from where an incoming mortar shell will land (arena: 0.93 -> 1.23 vs mortar hunters)
  dodgeMargin: knob("DODGE_MARGIN", 2), // extra metres beyond splash + our radius
  recoverHp: knob("RECOVER_HP", 0), // between fights: below this HP fraction, stay out of sight to regen (0 = off)
  recoverTo: knob("RECOVER_TO", 0.85), // ... until back above this
  recoverRange: knob("RECOVER_RANGE", 100), // ... unless an enemy is closer than this (then fight)
  boostFight: knob("BOOST_FIGHT", 40),
  // DIAGNOSTIC: never fire, always back away from threats. Its score = points earned without kills.
  pacifist: knob("PACIFIST", 0),
  maxClimb: knob("MAX_CLIMB", 45), // highest roof (m above the ground) we climb for a weapon; 0 = never // boost while strafing when energy is above this (0 = never); duel sim: -30% damage taken
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
  let recovering = false
  let unseenHit: { bearing: number; until: number } | null = null
  let lastGlance = -99
  let reloadGlance: { start: number; side: number } | null = null
  let laserHide: { from: number; spot: P2; until: number } | null = null
  let lastClearT = -99
  let fullSince: number | null = null
  let heardBearing: { bearing: number; t: number } | null = null
  // where cubes are: ones we have seen (they never move) and the spots where our kills died
  const knownCubes = new Map<number, Vec3>()
  const lastSeenAt = new Map<number, Vec3>()
  const lastSeenT = new Map<number, number>()
  let lootSpots: { pos: Vec3; until: number }[] = []
  let lastNpcHit: { id: number; t: number } | null = null
  let lastHunterSeen = -999
  let coverSpot: P2 | null = null
  let wallSpot: P2 | null = null
  let riskSpot: P2 | null = null
  let riskTick = -999
  let wallTick = -999
  let coverTick = -999
  let fightSpot: P2 | null = null
  let fightSpotTick = -999
  // Weapons on the ground never despawn: remember every one we have seen.
  const knownPickups = new Map<number, { kind: string; pos: Vec3 }>()
  // drones and crates we have seen (crates never move; drones stay near home)
  const knownNpcs = new Map<number, Vec3>()
  const knownCrates = new Map<number, Vec3>()
  // Coarse record of ground we have looked over (50 m squares), for exploring when unarmed.
  const SEEN_CELL = 50
  const seenCells = new Set<string>()
  const cellKey = (x: number, y: number) => `${Math.floor(x / SEEN_CELL)},${Math.floor(y / SEEN_CELL)}`
  // roof pickups we failed to reach: not retried
  const skipPickup = new Set<number>()
  let climbFor: { id: number; since: number } | null = null
  // Timing safeguard: a late answer drops that decision's shots (protocol §2). The observation
  // tick jumps by more than decide_every when we missed answers; then do less work for a while.
  let prevTick = -1
  let lightUntil = -1

  function planTo(me: Vec3, goal: P2, tick: number, cheap: boolean) {
    const moved = !pathGoal || d2(pathGoal, goal) > 6
    // when short on time, keep following the old route unless there is none
    if (path.length === 0 || (!cheap && (moved || tick - lastPlan > 20)) || (cheap && tick - lastPlan > 40)) {
      path = world.path(me[0], me[1], goal[0], goal[1], cheap ? 1500 : 6000) ?? [goal]
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

  /**
   * Where the target's body centre will be when our bullet arrives. Horizontal motion is held
   * constant; vertical motion follows gravity while the target is in the air (house bots jump and
   * jet onto roofs a lot), and never goes below the surface under its predicted position.
   */
  function predictCenter(m: ActorObs, t: number): Vec3 {
    const c = center(m)
    const x = c[0] + m.vel[0] * t
    const y = c[1] + m.vel[1] * t
    if (K.gravityLead <= 0) return [x, y, c[2] + Math.max(0, m.vel[2]) * t]
    const half = c[2] - m.pos[2]
    const floorNow = world.standZ(m.pos[0], m.pos[1], m.pos[2] + 0.5)
    const airborne = m.pos[2] > floorNow + 0.3 || Math.abs(m.vel[2]) > 0.5
    if (!airborne) return [x, y, c[2]]
    const g = cfg.mech.gravity
    const feet = m.pos[2] + m.vel[2] * t - 0.5 * g * t * t
    const floor = world.standZ(x, y, Math.max(m.pos[2], feet) + 0.5)
    return [x, y, Math.max(floor, feet) + half]
  }
  function leadPoint(from: Vec3, m: ActorObs, speed: number): Vec3 {
    let p = center(m)
    let t = 0
    for (let i = 0; i < 3; i++) {
      t = Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]) / speed
      p = predictCenter(m, t)
    }
    return p
  }

  /** Mortar pitch to hit a point dx away horizontally and dz above; null if out of range. */
  function mortarPitch(dx: number, dz: number, v: number, g: number, high: boolean) {
    const disc = v ** 4 - g * (g * dx * dx + 2 * dz * v * v)
    if (disc < 0) return null
    const r = Math.sqrt(disc)
    return Math.atan((v * v + (high ? r : -r)) / (g * dx))
  }

  return {
    name: K.pacifist > 0 ? "pacifist" : "survivor",
    act(obs: Observation): BotAction {
      const me = obs.self
      const pos = me.pos
      const tick = obs.tick
      const t = obs.t
      const muzzle: Vec3 = [pos[0], pos[1], pos[2] + (me.stats.muzzle_height ?? cfg.mech.muzzle_height)]
      const eye: Vec3 = [pos[0], pos[1], pos[2] + (me.stats.eye_height ?? cfg.mech.eye_height)]
      const act: BotAction = {}
      const started = performance.now()
      const elapsed = () => (K.timing > 0 ? performance.now() - started : 0)
      if (prevTick >= 0 && tick - prevTick > cfg.match.decide_every) lightUntil = t + 10
      prevTick = tick
      const light = K.timing > 0 && t < lightUntil

      // ---- events ----
      for (const e of obs.events) {
        if (e.type === "kill") lastSeenT.delete(e.target)
        if (e.type === "kill" && K.cubeMemory > 0) {
          const at = lastSeenAt.get(e.target)
          if (at) lootSpots.push({ pos: at, until: t + 25 })
        }
        if (e.type === "damaged" && e.weapon !== "zone" && e.bearing !== null) {
          lastThreat = { bearing: e.bearing, by: e.by, t }
          if (e.by !== null && e.by >= 100 && e.by < 1000) lastNpcHit = { id: e.by, t }
          if (e.rear && e.by !== null && e.by < 100 && !obs.mechs.some((m) => m.id === e.by)) unseenHit = { bearing: e.bearing, until: t + K.rearTurnS }
          if (e.by !== null && e.by < 100) lastHunterSeen = t
          // their aim has caught up with our current path: change direction now
          if (K.flipOnHit && t > nextStrafeFlip - 1.5) {
            strafeSign = -strafeSign
            nextStrafeFlip = t + 0.6 + rand() * 1.2
          }
        }
      }

      // ---- hearing ----
      if (K.hear > 0) {
        const threatKinds = new Set(["gun", "laser_charge", "laser", "mortar", "lightning", "step", "boost", "jet"])
        const visibleYaws = obs.mechs.filter((m) => m.kind === "mech").map((m) => yawTo(pos, m.pos))
        for (const snd of obs.sounds ?? []) {
          if (!threatKinds.has(snd.kind)) continue
          if (visibleYaws.some((y) => Math.abs(wrap(y - snd.bearing)) < 0.3)) continue // a mech we already see
          heardBearing = { bearing: snd.bearing, t: t - (snd.age ?? 0) }
          const shooting = snd.kind === "gun" || snd.kind === "laser_charge" || snd.kind === "laser"
          const behind = Math.abs(wrap(snd.bearing - me.aim[0])) > (K.hearRearDeg * Math.PI) / 180
          if (shooting && behind && snd.dist !== "far" && t - lastGlance > 2) {
            unseenHit = { bearing: snd.bearing, until: t + K.hearGlanceS }
            lastGlance = t
          }
        }
      }

      // ---- cube memory ----
      for (const m of obs.mechs) if (m.kind === "mech") {
        lastSeenAt.set(m.id, m.pos)
        lastSeenT.set(m.id, t)
      }
      if (K.cubeMemory > 0) {
        for (const c of obs.cubes) knownCubes.set(c.id, c.pos)
        const visibleIds = new Set(obs.cubes.map((c) => c.id))
        for (const [id, c] of knownCubes) if (d2(c, pos) < 3 || (!visibleIds.has(id) && d2(c, pos) < 35)) knownCubes.delete(id)
        lootSpots = lootSpots.filter((l) => t < l.until && d2(l.pos, pos) > 5)
      }
      /** Places with cubes: visible ones, remembered ones and our kill spots. */
      const cubePlaces = (): Vec3[] => me.cubes >= K.cubeMax ? [] : K.cubeMemory > 0 ? [...obs.cubes.map((c) => c.pos), ...knownCubes.values(), ...lootSpots.map((l) => l.pos)] : obs.cubes.map((c) => c.pos)

      // ---- upgrades ----
      if (obs.offer) {
        let best = 0
        let bestRank = Infinity
        const first = ["", "plating", "armor", "nanites", "", "sensors"][K.upgMode] ?? ""
        const base = me.weapons.some((w) => w?.kind === "laser") ? LASER_UPGRADE_ORDER : UPGRADE_ORDER
        // mode 4: what top-4 finishers chose most in recorded public matches (22 matches)
        // mode 6: sensors second (+15 m all-round sensing: hunters like to sit at ~55 m, just outside 45 m)
        // mode 7: laser_charge first when holding a laser (the strongest team bot's favourite pick)
        // mode 8: gun mechanics early (faster bullets hit dodging targets, bigger magazine, shorter reload)
        const GUN_EARLY = ["gun_velocity", "gun_mag"]
        const order = K.upgMode === 8 ? [base[0], ...GUN_EARLY, ...base.slice(1).filter((u) => !GUN_EARLY.includes(u))]
          : K.upgMode === 7 ? (me.weapons.some((w) => w?.kind === "laser") ? ["laser_charge", ...base.filter((u) => u !== "laser_charge")] : base)
          : K.upgMode === 4 ? REAL_WINNER_ORDER
          : K.upgMode === 6 ? [base[0], "sensors", ...base.slice(1).filter((u) => u !== "sensors")]
          : first ? [first, ...base.filter((u) => u !== first)] : base
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

      // ---- drone and crate memory ----
      for (const m of obs.mechs) if (m.kind === "npc") knownNpcs.set(m.id, m.pos)
      for (const c of obs.crates) knownCrates.set(c.id, c.pos)
      const seenNow = new Set([...obs.mechs.map((m) => m.id), ...obs.crates.map((c) => c.id)])
      for (const [id, p] of knownNpcs) if (!seenNow.has(id) && d2(p, pos) < 35) knownNpcs.delete(id)
      for (const [id, p] of knownCrates) if (!seenNow.has(id) && d2(p, pos) < 30) knownCrates.delete(id)

      // mark the squares around us as looked over (vision reaches far, but buildings hide a lot)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) seenCells.add(cellKey(pos[0] + dx * SEEN_CELL, pos[1] + dy * SEEN_CELL))
      const armed = me.weapons[1]?.kind === "laser" || me.weapons[1]?.kind === "mortar"

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
      const danger = (m: ActorObs) => !K.threat ? 0
        : (m.charging ? K.threatCharging : 0) + (m.weapons?.includes("laser") ? K.threatLaser : 0) + (m.weapons?.includes("mortar") ? K.threatMortar : 0)
      // enemies outside the front half (centred on our aim) hit our rear for 1.5x: prefer a target that keeps the others in front
      const behind = (m: ActorObs) => {
        if (!K.arcW) return 0
        const y = yawTo(pos, m.pos)
        let n = 0
        for (const o of mechs) if (o !== m && d2(o.pos, pos) < 200 && Math.abs(wrap(yawTo(pos, o.pos) - y)) > Math.PI / 2 - 0.15) n++
        return n
      }
      const rank = (m: ActorObs) => d2(m.pos, pos) + (m.hp ?? 0) * K.targetHpW - danger(m) + K.arcW * behind(m)
      const ranked = [...mechs].sort((a, b) => rank(a) - rank(b))
      // line-of-sight checks cost time: only the nearest few candidates
      for (const m of (attacker ? [attacker, ...ranked] : ranked).slice(0, light ? 2 : 4)) {
        if (d2(m.pos, pos) > (me.weapons[0]?.stats.range ?? 230) + 60) continue
        const c = shootable(m)
        if (c || !target) {
          target = m
          targetClear = c
        }
        if (c) break
      }

      /** Centre of the nearest unexplored 50 m square that is walkable and inside the safe circle. */
      const exploreTarget = (insideSafe: (p: number[]) => boolean): P2 | null => {
        const ci = Math.floor(pos[0] / SEEN_CELL)
        const cj = Math.floor(pos[1] / SEEN_CELL)
        for (let r = 1; r <= 8; r++) {
          let best: P2 | null = null
          let bestD = Infinity
          for (let i = ci - r; i <= ci + r; i++)
            for (let j = cj - r; j <= cj + r; j++) {
              if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || seenCells.has(`${i},${j}`)) continue
              const c: P2 = [(i + 0.5) * SEEN_CELL, (j + 0.5) * SEEN_CELL]
              const w = world.nearestWalkable(...world.navOf(c[0], c[1]), 6)
              if (!w || !insideSafe(c)) continue
              const p = world.navCenter(w[0], w[1])
              const dd = d2(p, pos)
              if (dd < bestD) {
                bestD = dd
                best = p
              }
            }
          if (best) return best
        }
        return null
      }

      /** Nearest remembered drone or ground crate worth farming. */
      if (obs.mechs.some((m) => m.kind === "mech")) lastHunterSeen = t
      const farmTarget = (inReach: (p: number[], r: number) => boolean) => {
        let best: { pos: Vec3; npc: boolean } | null = null
        let bestD = Infinity
        for (const p of K.npcFix > 0 && t - lastHunterSeen < 10 ? [] : knownNpcs.values()) {
          const dd = d2(p, pos)
          if (dd < bestD && inReach(p, K.farmRange)) {
            bestD = dd
            best = { pos: p, npc: true }
          }
        }
        for (const p of knownCrates.values()) {
          // drones give 2 cubes, crates 1; but while unarmed a crate is also a 50% chance of a weapon
          const dd = d2(p, pos) + (armed ? 20 : -40)
          if (dd < bestD && inReach(p, K.farmRange) && p[2] <= world.groundAt(p[0], p[1]) + 3) {
            bestD = dd
            best = { pos: p, npc: false }
          }
        }
        return best
      }

      // ---- movement goal ----
      const anchor = zoneAnchor(obs)
      let goal: P2 = anchor
      let mode = "hold"
      let goingFor: { id: number; kind: string; pos: Vec3 } | undefined // weapon pickup we are walking to
      const outside = !me.in_zone
      const slack = zoneSlack(obs, anchor)
      const urgent = d2(pos, anchor) > 1 && (outside || slack < 12)
      const threatened = mechs.length > 0 || (lastThreat !== null && t - lastThreat.t < 4)
      const turtling = t < K.turtleT
      const turtleFlee = turtling && mechs.some((m) => d2(m.pos, pos) < K.turtleR) && !mechs.some((m) => d2(m.pos, pos) < K.turtleCorner)
      // Retreat only when it pays: low and the fight is not going our way, or badly outnumbered.
      // Backing away from a single attacker mostly hands it free shots.
      const targetFrac = target && target.hp !== undefined && target.max_hp ? target.hp / target.max_hp : 1
      // Between fights, heal: regen needs 5 s without dealing or taking damage, so stay out of
      // sight until HP is back up, unless someone is already close (then running hands them free shots).
      const closest = mechs.reduce((m, e) => Math.min(m, d2(e.pos, pos)), Infinity)
      if (K.recoverHp > 0) {
        if (hpFrac < K.recoverHp) recovering = true
        if (hpFrac >= K.recoverTo) recovering = false
      }
      const recover = recovering && closest > K.recoverRange
      // time-to-kill vs time-to-die
      let losingTrade = false
      if (K.ttk > 0 && target) {
        const cubeMul = 1 + (cfg.cubes.damage_per_cube as number) * Math.min(me.cubes, cfg.cubes.stat_cap as number)
        const g = me.weapons[0]?.stats ?? cfg.weapons.gun
        const gunDps = ((g.damage ?? 45) / (g.cooldown ?? 0.24)) * 0.8 * ((g.mag ?? 12) * (g.cooldown ?? 0.24)) / ((g.mag ?? 12) * (g.cooldown ?? 0.24) + (g.reload ?? 2.4))
        const L = me.weapons[1]?.kind === "laser" ? me.weapons[1].stats : null
        const laserDps = L ? (L.damage ?? 315) / ((L.charge ?? 0.75) + (L.cooldown ?? 1.65)) : 0
        const ourDps = (gunDps + laserDps) * cubeMul
        const ttkS = (target.hp ?? 1400) / Math.max(1, ourDps)
        let inDps = 0
        for (const m of mechs) {
          if (d2(m.pos, pos) > 260) continue
          const em = 1 + (cfg.cubes.damage_per_cube as number) * Math.min(m.cubes ?? 0, cfg.cubes.stat_cap as number)
          let dps = (45 / 0.24) * 0.7 * K.enemyHit
          if (m.weapons?.includes("laser")) dps += (315 / 2.4) * 0.9
          if (m.weapons?.includes("mortar")) dps += 40
          inDps += dps * em
        }
        const armor = 1 - (me.stats.armor ?? 0)
        const ttdS = me.hp / Math.max(1, inDps * armor)
        losingTrade = ttkS > ttdS * K.ttkMargin
      }
      const retreat = turtleFlee || (threatened || recover) && (K.pacifist > 0 || recover || (K.ttk > 0 ? losingTrade : (hpFrac < K.retreatHp && targetFrac >= hpFrac) || near.length >= K.retreatN))
      const safeR = obs.zone.next_radius * 0.6
      const insideSafe = (p: number[]) => d2(p, obs.zone.next_center) <= Math.max(safeR, 15)

      // a supply drop worth rushing: landing soon, close enough, nobody else capturing it
      const enemyClose = obs.mechs.some((m) => m.kind === "mech" && d2(m.pos, pos) < 150)
      const rushDrop = K.dropRush > 0 && hpFrac < K.dropMaxHp && !(enemyClose && hpFrac < K.dropMinHp)
        ? (obs.drops ?? []).filter((d) => d.lands_in <= K.dropLead && d2(d.pos, pos) < K.dropRange && (d.holder === null || d.holder === me.id))
            .sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0]
        : undefined
      if (urgent) {
        mode = outside ? "zone!" : "to zone"
      } else if (rushDrop) {
        // stand near the middle of the ring (radius 8 m); move there while still fighting
        const dd = d2(rushDrop.pos, pos)
        goal = dd > 2 ? [rushDrop.pos[0], rushDrop.pos[1]] : [pos[0], pos[1]]
        mode = rushDrop.lands_in > 0 ? "drop wait" : dd < (rushDrop.radius ?? 8) ? "drop capture" : "drop rush"
      } else if (retreat) {
        // move away from threats, staying inside the safe circle; prefer points threats can't see
        mode = "retreat"
        const threats = (mechs.length ? [...mechs].sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos)).slice(0, 3).map((m) => m.pos) : lastThreat ? [[pos[0] + Math.cos(lastThreat.bearing) * 80, pos[1] + Math.sin(lastThreat.bearing) * 80, pos[2]]] : [])
        let best: P2 = anchor
        let bestScore = -Infinity
        // 48 candidate spots normally; 8 when short on time
        const cheapSearch = light || elapsed() > 15
        for (let k = 0; k < 16; k += cheapSearch ? 2 : 1) {
          const a = (k / 16) * TAU
          for (const r of cheapSearch ? [30] : [15, 30, 45]) {
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
        const kiting = K.kite > 0 && kind2 === "laser"
        const sensors = (me.upgrades ?? []).filter((u) => u === "sensors").length * 25
        const want = kiting ? Math.min(K.kiteDist, cfg.vision.range + sensors - 5) : kind2 === "lightning" ? K.wantLightning : kind2 === "laser" ? K.wantLaser : kind2 === "mortar" ? K.wantMortar : K.want
        const band = kiting ? K.kiteBand : kind2 === "lightning" ? K.bandLightning : K.band
        const radial = dist > want + band ? 1 : dist < want - band ? -1 : 0
        const side = toT + (strafeSign * Math.PI) / 2
        const rw = kiting ? K.kiteRadial : K.radial
        let mx = Math.cos(side) + radial * Math.cos(toT) * rw
        let my = Math.sin(side) + radial * Math.sin(toT) * rw
        if (kiting && radial < 0) {
          // backing off: if straight back is blocked, swing the escape direction until it is walkable
          const base = Math.atan2(my, mx)
          for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
            const a = base + off
            const [gi, gj] = world.navOf(pos[0] + Math.cos(a) * 12, pos[1] + Math.sin(a) * 12)
            if (world.walkable(gi, gj) && insideSafe([pos[0] + Math.cos(a) * 12, pos[1] + Math.sin(a) * 12])) {
              mx = Math.cos(a)
              my = Math.sin(a)
              break
            }
          }
          mode = "kite"
        }
        // Several enemies: pull away from their centre so they string out and arrive one at a time.
        const pack = mechs.filter((m) => d2(m.pos, pos) < K.packRange)
        if (K.pack > 0 && pack.length >= 2) {
          const cx = pack.reduce((a, m) => a + m.pos[0], 0) / pack.length
          const cy = pack.reduce((a, m) => a + m.pos[1], 0) / pack.length
          const away = Math.atan2(pos[1] - cy, pos[0] - cx)
          mx += Math.cos(away) * K.pack
          my += Math.sin(away) * K.pack
          const base = Math.atan2(my, mx)
          for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
            const a = base + off
            const q: P2 = [pos[0] + Math.cos(a) * 12, pos[1] + Math.sin(a) * 12]
            const [gi, gj] = world.navOf(q[0], q[1])
            if (world.walkable(gi, gj) && insideSafe(q)) {
              mx = Math.cos(a)
              my = Math.sin(a)
              break
            }
          }
          mode = "split pack"
        }
        const p: P2 = [pos[0] + mx * 12, pos[1] + my * 12]
        goal = insideSafe(p) ? p : anchor
        if (K.mortarCover > 0 && kind2 === "mortar" && !light) {
          // re-pick a hidden lobbing spot about twice a second
          if (!coverSpot || tick - coverTick >= 5 * cfg.match.decide_every) {
            let best: P2 | null = null
            let bestScore = -Infinity
            const foes = mechs.slice(0, 4)
            for (let k = 0; k < 16; k++) {
              const a = (k / 16) * TAU
              for (const r of [0, 10, 20, 35]) {
                if (r === 0 && k > 0) continue
                const c: P2 = [pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r]
                const [gi, gj] = world.navOf(c[0], c[1])
                if (!world.walkable(gi, gj) || !insideSafe(c)) continue
                const gz = world.groundAt(c[0], c[1])
                const dT = d2(c, target!.pos)
                let score = -r * 0.4 - (dT < K.mortarMin ? (K.mortarMin - dT) * 0.6 : dT > K.mortarMax ? (dT - K.mortarMax) * 0.6 : 0)
                for (const o of foes) if (!world.clear([o.pos[0], o.pos[1], o.pos[2] + 8], [c[0], c[1], gz + 6], 2)) score += 50 / foes.length
                if (score > bestScore) {
                  bestScore = score
                  best = c
                }
              }
            }
            coverSpot = best
            coverTick = tick
          }
          if (coverSpot) {
            goal = coverSpot
            mode = "mortar cover"
          }
        } else coverSpot = null
        if (K.minRisk > 0 && !light && elapsed() < 12 && mode !== "mortar cover" && mode !== "fight→cube") {
          if (!riskSpot || tick - riskTick >= K.minRiskEvery * cfg.match.decide_every || d2(pos, riskSpot) < 2) {
            const tc = center(target!)
            const foes = [...mechs].sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos)).filter((m) => d2(m.pos, pos) < 300).slice(0, 4)
            const strength = (m: ActorObs) => (1 + (cfg.cubes.damage_per_cube as number) * Math.min(m.cubes ?? 0, 10)) *
              (1 + (m.weapons?.includes("laser") ? 0.7 : 0) + (m.weapons?.includes("mortar") ? 0.3 : 0)) * Math.max(0.2, (m.hp ?? 1400) / Math.max(1, m.max_hp ?? 1400))
            const risk = (c: P2, r: number) => {
              const gz = world.groundAt(c[0], c[1])
              const body: Vec3 = [c[0], c[1], gz + 4.5]
              let v = 0
              for (const m of foes) {
                const dd = Math.max(20, d2(m.pos, c))
                const sees = world.clear([m.pos[0], m.pos[1], m.pos[2] + 8], body, 5)
                v += (strength(m) * (sees ? 1 : 0.3) * 10000) / (dd * dd)
              }
              if (!world.clear([c[0], c[1], gz + 7], tc, 4)) v += K.minRiskShoot
              if (r === 0) v += 0.3 // standing still is risky too
              return v + rand() * 0.15
            }
            let best: P2 | null = null
            let bestV = Infinity
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * TAU
              for (const r of [0, 15, 30]) {
                if (r === 0 && k > 0) continue
                const c: P2 = [pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r]
                const [gi, gj] = world.navOf(c[0], c[1])
                if (!world.walkable(gi, gj) || !insideSafe(c)) continue
                const v = risk(c, r)
                if (v < bestV) {
                  bestV = v
                  best = c
                }
              }
            }
            riskSpot = best
            riskTick = tick
          }
          if (riskSpot) {
            goal = riskSpot
            mode = "min risk"
          }
        } else riskSpot = null
        if (K.backWall > 0 && !light && mode !== "mortar cover") {
          if (!wallSpot || tick - wallTick >= K.backWallEvery * cfg.match.decide_every || d2(pos, wallSpot) < 2) {
            const tc = center(target!)
            const toT2 = yawTo(pos, target!.pos)
            let best: P2 | null = null
            let bestScore = -Infinity
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * TAU
              for (const r of [0, 8, 16]) {
                if (r === 0 && k > 0) continue
                const c: P2 = [pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r]
                const [gi, gj] = world.navOf(c[0], c[1])
                if (!world.walkable(gi, gj) || !insideSafe(c)) continue
                const gz = world.groundAt(c[0], c[1])
                const body: Vec3 = [c[0], c[1], gz + 5]
                if (!world.clear([c[0], c[1], gz + 7], tc, 2)) continue // must still be able to shoot the target
                let covered = 0
                for (const off of [-1.05, -0.52, 0, 0.52, 1.05]) {
                  const ra = toT2 + Math.PI + off
                  const from: Vec3 = [c[0] + Math.cos(ra) * 120, c[1] + Math.sin(ra) * 120, gz + 8]
                  if (!world.clear(from, body, 3)) covered++
                }
                const score = covered * K.backWall - r * 0.3 - Math.abs(d2(c, target!.pos) - want) * 0.05
                if (score > bestScore) {
                  bestScore = score
                  best = c
                }
              }
            }
            wallSpot = best
            wallTick = tick
          }
          if (wallSpot && d2(wallSpot, pos) > 1.5) {
            goal = wallSpot
            mode = "back to wall"
          }
        } else wallSpot = null
        // Unarmed: a laser or mortar on the ground nearby is worth more than strafing in place
        // (arena: about a quarter of runs end with only the gun, the weakest setup by far).
        // cubes lying near us (usually from the kill we just made): grab them while still fighting
        if (K.cubeFight > 0 && hpFrac >= K.cubeFightMinHp) {
          const c = cubePlaces().filter((q) => d2(q, pos) < K.cubeFight && Math.abs(q[2] - pos[2]) < 4).sort((a, b) => d2(a, pos) - d2(b, pos))[0]
          if (c) {
            goal = [c[0], c[1]]
            mode = "fight→cube"
          }
        }
        if (K.grabInFight > 0 && !armed) {
          let near: { id: number; kind: string; pos: Vec3 } | undefined
          for (const [id, w] of knownPickups) {
            if ((w.kind !== "laser" && w.kind !== "mortar") || w.pos[2] > world.groundAt(w.pos[0], w.pos[1]) + 3) continue
            if (d2(w.pos, pos) < K.grabInFight && (!near || d2(w.pos, pos) < d2(near.pos, pos))) near = { id, ...w }
          }
          if (near) {
            goal = [near.pos[0], near.pos[1]]
            mode = `fight→${near.kind}`
            if (d2(near.pos, pos) < cfg.loot.pickup_radius - 0.3) {
              act.take = near.id
              if (me.weapons[1]) act.drop = 1
            }
          }
        }
        // Several enemies: the arena sim shows we lose when two or more shoot at once. Choose a
        // nearby spot from which we can still shoot our target but the others cannot see us.
        const others = mechs.filter((m) => m.id !== target!.id && d2(m.pos, pos) < 250)
        if (K.fightPos > 0 && others.length >= 1 && !light) {
          if (!fightSpot || tick - fightSpotTick >= K.fightPosEvery * cfg.match.decide_every || d2(pos, fightSpot) < 2) {
            const tc = center(target!)
            let bestScore = -Infinity
            let best: P2 | null = null
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * TAU + rand() * 0.3
              for (const r of [8, 16]) {
                const c: P2 = [pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r]
                const [gi, gj] = world.navOf(c[0], c[1])
                if (!world.walkable(gi, gj) || !insideSafe(c)) continue
                const gz = world.groundAt(c[0], c[1])
                let score = -r * 0.15 - Math.abs(d2(c, target!.pos) - want) * 0.15 + rand() * 4
                if (world.clear([c[0], c[1], gz + 7], tc, 2)) score += 40
                for (const o of others.slice(0, 3)) if (world.clear([o.pos[0], o.pos[1], o.pos[2] + 8], [c[0], c[1], gz + 6], 2)) score -= 30
                if (score > bestScore) {
                  bestScore = score
                  best = c
                }
              }
            }
            fightSpot = best
            fightSpotTick = tick
          }
          if (fightSpot) goal = fightSpot
        } else fightSpot = null
      } else {
        // free time: loot inside the safe area
        const inReach = (p: number[], r: number) => d2(p, pos) < r && insideSafe(p)
        const cube = cubePlaces().filter((c) => inReach(c, K.cubeRange)).sort((a, b) => d2(a, pos) - d2(b, pos)).map((c) => ({ pos: c }))[0]
        const want2 = !me.weapons[1]
        // Any remembered weapon better than what we hold. A laser is worth a long walk (duel sim:
        // gun + laser wins 6/6 against gun only), the others less so. Roof pickups count if the
        // roof is low enough to climb (jump, then jet) and we have not failed to reach it before.
        const reachKm = (kind: string) => (kind === "laser" ? 250 : 100)
        let pick: { id: number; kind: string; pos: Vec3 } | undefined
        let pickCost = Infinity
        for (const [id, p] of knownPickups) {
          const better = want2 || WEAPON_RANK[p.kind] > WEAPON_RANK[me.weapons[1]!.kind]
          if (!better || me.weapons.some((w) => w?.kind === p.kind)) continue
          const roofH = p.pos[2] - world.groundAt(p.pos[0], p.pos[1])
          if (skipPickup.has(id) || (roofH > 3 && roofH > K.maxClimb)) continue
          if (K.roofSafe > 0 && roofH > 3 && ((lastThreat !== null && t - lastThreat.t < 8) || hpFrac < 0.6)) continue
          const dist = d2(p.pos, pos)
          // outside the safe circle is fine while there is time to come back afterwards
          const detour = (dist / (me.stats.walk_speed ?? cfg.mech.walk_speed)) * 2
          if (dist > reachKm(p.kind) || (!insideSafe(p.pos) && slack - detour < 20) || (dist > 80 && slack < 25)) continue
          // metres of walking each kind is worth: house bots grab weapons within seconds, and in the
          // arena sim a mortar is nearly as good as a laser, so take whichever of the two is closer
          const cost = dist - (p.kind === "laser" ? 150 : p.kind === "mortar" ? 120 : 10)
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
          goingFor = pick
          goal = [pick.pos[0], pick.pos[1]]
          mode = `get ${pick.kind}`
          if (d2(pick.pos, pos) < cfg.loot.pickup_radius - 0.3) {
            act.take = pick.id
            if (!want2) act.drop = 1
          }
        } else if (K.explore > 0 && !armed && t < K.exploreUntil && !farmTarget(inReach) && exploreTarget(insideSafe)) {
          goal = exploreTarget(insideSafe)!
          mode = "explore"
        } else if (!turtling && K.farm > 0 && t < K.farmUntil && hpFrac > K.farmMinHp && farmTarget(inReach)) {
          const f = farmTarget(inReach)!
          // stand off: drones from beyond their aggro range, crates from close enough to hit
          const stand = f.npc ? K.npcStandoff : 30
          const dd = d2(f.pos, pos)
          if (dd > stand) {
            const back = yawTo(f.pos, pos)
            goal = [f.pos[0] + Math.cos(back) * stand, f.pos[1] + Math.sin(back) * stand]
          } else goal = [pos[0], pos[1]]
          mode = f.npc ? "farm drone" : "farm crate"
        } else if (drop) {
          goal = [drop.pos[0], drop.pos[1]]
          mode = "drop"
        } else if (Math.hypot(...[0, 1].map((i) => pos[i] - anchor[i])) > 2) {
          mode = "to zone"
        }
      }

      // ---- movement ----
      const nav = planTo(pos, goal, tick, light || elapsed() > 20)
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
        // Race for a laser on the ground (a roof one needs the energy for the climb).
        const rushLaser = goingFor?.kind === "laser" && goingFor.pos[2] <= world.groundAt(goingFor.pos[0], goingFor.pos[1]) + 3 && d2(pos, goal) > 8
        act.boost = (me.energy > 30 && (mode === "zone!" || mode === "retreat" || (mode === "to zone" && d2(pos, goal) > 60) || (K.boostFight > 0 && mode === "fight" && me.energy > K.boostFight) || (mode === "kite" && me.energy > K.kiteBoost) || (mode === "split pack" && me.energy > K.boostFight) || (mode === "min risk" && me.energy > K.boostFight) || (mode === "drop rush" && me.energy > 30))) || (rushLaser && me.energy > 15)
      }

      // turtling with nobody around: no boosting (90 m sound) except to the zone or for a weapon
      if (turtling && !urgent && mode !== "retreat" && !mode.startsWith("get") && !mode.startsWith("drop") && mechs.length === 0) act.boost = false

      // ---- climbing to a roof weapon (protocol.md §7: jump, jet until the feet clear the edge) ----
      if (goingFor && goingFor.pos[2] > world.groundAt(goingFor.pos[0], goingFor.pos[1]) + 3) {
        const p = goingFor
        const id = p.id
        const roofZ = p.pos[2]
        const dh = d2(p.pos, pos)
        const toP = yawTo(pos, p.pos)
        const straight: P2 = [Math.cos(toP), Math.sin(toP)]
        if (pos[2] >= roofZ - 0.6) {
          // at roof level: walk straight to it (the walk grid does not cover roofs)
          act.move = dh < 1.5 ? [0, 0] : straight
          act.boost = false
          mode = `roof ${p.kind}`
          climbFor = null
        } else if (dh < 22 || path.length <= 1) {
          if (!climbFor || climbFor.id !== id) climbFor = { id, since: t }
          const need = (roofZ - pos[2]) * 1.6 + 8
          if (t - climbFor.since > 12) {
            skipPickup.add(id) // could not get up there: forget it
            climbFor = null
          } else if (me.grounded && me.energy < Math.min(need, me.max_energy * 0.95)) {
            act.move = [0, 0] // wait at the wall for enough energy to make the climb in one go
            act.boost = false
            mode = "charge climb"
          } else {
            act.move = straight
            act.jump = me.grounded
            act.boost = !me.grounded && me.energy > 0
            mode = "climb"
          }
        }
      } else if (climbFor && !goingFor) climbFor = null

      // ---- laser counter-play: hide from a beam that is about to be fired at us ----
      if (K.laserDodge > 0 && !light) {
        const myBody: Vec3 = [pos[0], pos[1], pos[2] + (me.stats.height ?? cfg.mech.height) / 2]
        const shooter = obs.mechs.find((m) => m.kind === "mech" && m.charging && d2(m.pos, pos) < (cfg.weapons.laser.range ?? 280)
          && Math.abs(wrap(m.aim[0] - yawTo(m.pos, pos))) < K.laserDodgeAim
          && world.clear([m.pos[0], m.pos[1], m.pos[2] + cfg.mech.muzzle_height], myBody, 2))
        if (shooter && (!laserHide || laserHide.from !== shooter.id)) {
          const eyeS: Vec3 = [shooter.pos[0], shooter.pos[1], shooter.pos[2] + cfg.mech.muzzle_height]
          let best: P2 | null = null
          let bestD = Infinity
          for (const r of [6, 10, 14]) {
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * TAU
              const c: P2 = [pos[0] + Math.cos(a) * r, pos[1] + Math.sin(a) * r]
              const [gi, gj] = world.navOf(c[0], c[1])
              if (!world.walkable(gi, gj) || !world.walkLine([pos[0], pos[1]], c)) continue
              const gz = world.groundAt(c[0], c[1])
              if (world.clear(eyeS, [c[0], c[1], gz + 4.5], 2)) continue // still exposed
              if (r < bestD) {
                bestD = r
                best = c
              }
            }
            if (best) break
          }
          laserHide = best ? { from: shooter.id, spot: best, until: t + 1.5 } : null
        }
        const stillCharging = laserHide && obs.mechs.some((m) => m.id === laserHide!.from && m.charging)
        if (laserHide && (t > laserHide.until || (!stillCharging && t > laserHide.until - 1.2))) laserHide = null
        if (laserHide) {
          const yaw = yawTo(pos, laserHide.spot)
          act.move = d2(pos, laserHide.spot) > 1 ? [Math.cos(yaw), Math.sin(yaw)] : [0, 0]
          act.boost = me.energy > 5
          mode = "laser cover"
        }
      }

      // ---- dodge bullets: sidestep any visible bullet that would pass through us soon ----
      if (K.bulletDodge > 0) {
        const r = (me.stats.radius ?? cfg.mech.radius) + K.bulletMargin
        const h = me.stats.height ?? cfg.mech.height
        let dx = 0
        let dy = 0
        let threats = 0
        for (const pr of obs.projectiles) {
          if (pr.kind !== "gun" && pr.kind !== "npc") continue
          const v = pr.vel
          const bl = Math.hypot(v[0], v[1])
          if (bl < 1) continue
          // bullet relative to us, assuming we keep our current velocity
          const rx = pr.pos[0] - pos[0]
          const ry = pr.pos[1] - pos[1]
          const rvx = v[0] - me.vel[0]
          const rvy = v[1] - me.vel[1]
          const tca = -(rx * rvx + ry * rvy) / (rvx * rvx + rvy * rvy)
          if (tca < 0.02 || tca > K.bulletHorizon) continue
          const cx = rx + rvx * tca
          const cy = ry + rvy * tca
          const bz = pr.pos[2] + v[2] * tca
          if (Math.hypot(cx, cy) > r || bz < pos[2] - 0.5 || bz > pos[2] + h + 0.5) continue
          // move perpendicular to the bullet's path, to the side that grows the miss distance
          const px = -v[1] / bl
          const py = v[0] / bl
          let side = -(cx * px + cy * py)
          if (Math.abs(side) < 0.3) side = me.vel[0] * px + me.vel[1] * py || strafeSign
          const sgn = side >= 0 ? 1 : -1
          const w = 1 / Math.max(tca, 0.1)
          dx += px * sgn * w
          dy += py * sgn * w
          threats++
        }
        if (threats) {
          let dir = Math.atan2(dy, dx)
          for (const off of [0, Math.PI]) {
            // the chosen side, or the other one if a wall is in the way
            const a = dir + off
            const [gi, gj] = world.navOf(pos[0] + Math.cos(a) * 6, pos[1] + Math.sin(a) * 6)
            if (world.walkable(gi, gj)) {
              dir = a
              break
            }
          }
          act.move = [Math.cos(dir), Math.sin(dir)]
          act.boost = me.energy > 10
          mode = "dodge bullet"
        }
      }

      // ---- dodge mortar shells: predict where each lands and get out of the splash ----
      if (K.dodge > 0) {
        const g = cfg.weapons.mortar.gravity
        const reach = (cfg.weapons.mortar.splash_radius ?? 7) + (me.stats.radius ?? cfg.mech.radius) + K.dodgeMargin
        let impact: P2 | null = null
        let soonest = Infinity
        for (const pr of obs.projectiles) {
          if (pr.kind !== "mortar") continue
          // time until it falls to our feet height: z + vz t - g t^2 / 2 = our z
          const dz = pr.pos[2] - pos[2]
          const disc = pr.vel[2] * pr.vel[2] + 2 * g * dz
          if (disc < 0) continue
          const tl = (pr.vel[2] + Math.sqrt(disc)) / g
          if (tl <= 0 || tl > 6) continue
          const land: P2 = [pr.pos[0] + pr.vel[0] * tl, pr.pos[1] + pr.vel[1] * tl]
          const meAt: P2 = [pos[0] + me.vel[0] * tl, pos[1] + me.vel[1] * tl]
          if (d2(land, meAt) < reach && tl < soonest) {
            soonest = tl
            impact = land
          }
        }
        if (impact) {
          const away = d2(impact, pos) < 0.5 ? yawTo(pos, goal) + Math.PI / 2 : yawTo(impact, pos)
          let dir = away
          for (const off of [0, 0.7, -0.7, 1.4, -1.4]) {
            const a = away + off
            const [gi, gj] = world.navOf(pos[0] + Math.cos(a) * 8, pos[1] + Math.sin(a) * 8)
            if (world.walkable(gi, gj)) {
              dir = a
              break
            }
          }
          act.move = [Math.cos(dir), Math.sin(dir)]
          act.boost = me.energy > 5
          mode = "dodge"
        }
      }

      // ---- aim and fire ----
      const gun = me.weapons[0]
      const second = me.weapons[1]
      let aimYaw = nav.yaw
      let aimPitch = 0
      const fire: [boolean, boolean] = [false, false]

      const farming = !turtling && K.farm > 0 && t < K.farmUntil && hpFrac > K.farmMinHp
      const crateRange = turtling ? 0 : farming ? 100 : K.shootCrate > 0 ? 60 : 0
      const npcRange = turtling ? 0 : farming ? 130 : K.shootNpc > 0 && hpFrac > 0.6 && t < 330 ? 70 : 0
      const crate = !target ? obs.crates.filter((c) => d2(c.pos, pos) < crateRange && world.clear(muzzle, [c.pos[0], c.pos[1], c.pos[2] + 1.2], 1.5)).sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0] : undefined
      // a drone that is shooting us gets shot back at any HP (otherwise it keeps chipping at us)
      const attackingNpc = K.npcFix > 0 && lastNpcHit && t - lastNpcHit.t < 3 ? npcs.find((n) => n.id === lastNpcHit!.id && shootable(n)) : undefined
      const npc = !target ? attackingNpc ?? npcs.filter((n) => d2(n.pos, pos) < npcRange && shootable(n)).sort((a, b) => d2(a.pos, pos) - d2(b.pos, pos))[0] : undefined
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
            if (clear) lastClearT = t
            if (laserCharge > 0) {
              // keep holding until fully charged, the shot is clear and the torso is on target;
              // letting go fires the beam (a full charge also fires on its own after hold_s)
              if (laserCharge >= laserFull * 0.97) fullSince ??= t
              else fullSince = null
              const ready = laserCharge >= laserFull * 0.97 && clear && inRange && err < tol
              const expiring = fullSince !== null && t - fullSince > (laser.stats.hold_s ?? cfg.weapons.laser.hold_s) - 0.25
              fire[1] = !(ready || (K.precharge > 0 && expiring))
            } else if (laser.cooldown <= 0 && inRange && (clear || (K.precharge > 0 && t - lastClearT < K.prechargeWindow))) {
              fullSince = null
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
      } else if (K.faceS > 0 && (() => {
        // an enemy we lost track of recently: keep our front toward where it was (it is probably still coming)
        let bestP: Vec3 | null = null
        let bestD = 250
        for (const [id, st] of lastSeenT) {
          if (t - st > K.faceS) continue
          const p = lastSeenAt.get(id)
          if (p && d2(p, pos) < bestD) { bestD = d2(p, pos); bestP = p }
        }
        if (bestP) aimYaw = yawTo(pos, bestP)
        return bestP !== null
      })()) {
        // aim set above
      } else {
        // heard something we cannot see: look there first
        if (K.hear > 0 && heardBearing && t - heardBearing.t < 1.5) {
          aimYaw = heardBearing.bearing
          scanYaw = heardBearing.bearing
        } else {
        // nothing to shoot: sweep the whole circle to spot weapons, cubes and enemies
        // (vision is a 120 deg wedge out to 200 m; proximity sensors only reach 45 m)
        // House bots take nearby weapons within 2-11 s of spawning (house replay), so look around
        // fast at the start: a full circle in about 2 s for the first 20 s, then every ~4 s.
        scanYaw = wrap(scanYaw + (t < 20 ? 0.35 : 0.16))
        aimYaw = scanYaw
        }
      }
      // reload while nothing to shoot
      if (gun && !shootAt && (gun.ammo ?? 12) < (gun.stats.mag ?? 12) * 0.5 && (gun.reload ?? 0) <= 0) act.reload = true

      // check six while the gun reloads (unless a laser charge needs the turret on target)
      if (K.glance > 0 && target && gun && (gun.reload ?? 0) > 0 && !((second?.kind === "laser") && (second.charge ?? 0) > 0)) {
        if (!reloadGlance) reloadGlance = { start: t, side: rand() < 0.5 ? 1 : -1 }
        const el = t - reloadGlance.start
        const reloadLeft = gun.reload ?? 0
        // out, hold briefly, and be back on target by the time the reload ends
        if (reloadLeft > 0.9 && el < 1.4) {
          aimYaw = yawTo(pos, target.pos) + reloadGlance.side * K.glanceSpread
          aimPitch = 0
          fire[0] = false
        }
      } else if (reloadGlance && (gun?.reload ?? 0) <= 0) reloadGlance = null

      // an unseen attacker is shooting our back: look at it (gun holds fire while we turn; a laser charge is kept)
      if (K.rearTurn > 0 && unseenHit && t < unseenHit.until) {
        if (obs.mechs.some((m) => m.kind === "mech" && Math.abs(wrap(yawTo(pos, m.pos) - unseenHit!.bearing)) < 0.4)) unseenHit = null
        else {
          aimYaw = unseenHit.bearing
          aimPitch = 0
          fire[0] = false
        }
      }
      act.aim = [wrap(aimYaw), Math.max(cfg.mech.min_pitch, Math.min(cfg.mech.max_pitch, aimPitch))]
      act.fire = K.pacifist > 0 ? [false, false] : fire
      // turtling: gunfire carries 320 m; shoot only when already found (hit recently) or an enemy is close
      if (turtling && !(lastThreat !== null && t - lastThreat.t < 3) && !mechs.some((m) => d2(m.pos, pos) < K.turtleFireR)) act.fire = [false, false]

      // ---- debug ----
      draw.label(`${mode}${light ? " L" : ""} hp${Math.round(hpFrac * 100)} s${Math.round(slack)} ${target ? `T${target.id}${targetClear ? "" : "?"}` : ""}`)
      if (path.length) draw.line([pos[0], pos[1], pos[2] + 1], [nav.wp[0], nav.wp[1], pos[2] + 1], "#40c0ff")
      return act
    },
  }
})
