/**
 * Static map model built once at `hello` from /arena (protocol.md §11).
 *
 * - ground(x, y): terrain height, bilinear.
 * - Solids are rasterized onto the 1 m terrain grid as up to two [base, top] intervals per cell
 *   (a building, or a bridge over the ground). Lookups are then array reads.
 * - solid(x, y, z), clearShot(a, b): line-of-sight / shot tests against terrain and solids.
 * - A coarse walk grid (NAV m cells) for A* on the ground, with walls inflated by the mech radius.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Prism = { kind: string; base: number; top: number; ring: number[]; holes: number[][] }

export const NAV = 3 // walk grid cell size, meters
const BODY = 9 // mech height: solids lower than this over the ground block walking
const STEP_UP = 1.2

export class World {
  minX: number
  minY: number
  nx: number
  ny: number
  ground: Float32Array
  // up to two solid intervals per 1 m cell; NaN = none
  b1: Float32Array
  t1: Float32Array
  b2: Float32Array
  t2: Float32Array
  // walk grid
  gx: number
  gy: number
  walk: Uint8Array // 1 = walkable on the ground

  constructor(dir: string) {
    const meta = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
    const t = meta.terrain
    this.minX = t.minX
    this.minY = t.minY
    this.nx = t.nx
    this.ny = t.ny
    const raw = readFileSync(join(dir, "v2", t.file ?? "terrain.i16"))
    const cm = new Int16Array(raw.buffer, raw.byteOffset, this.nx * this.ny)
    this.ground = new Float32Array(this.nx * this.ny)
    const scale = t.scale ?? 0.01
    for (let i = 0; i < cm.length; i++) this.ground[i] = cm[i] * scale

    const n = this.nx * this.ny
    this.b1 = new Float32Array(n).fill(NaN)
    this.t1 = new Float32Array(n).fill(NaN)
    this.b2 = new Float32Array(n).fill(NaN)
    this.t2 = new Float32Array(n).fill(NaN)
    for (const p of meta.prisms as Prism[]) this.fill(p)

    this.gx = Math.ceil(this.nx / NAV)
    this.gy = Math.ceil(this.ny / NAV)
    this.walk = new Uint8Array(this.gx * this.gy)
    this.buildWalk()
  }

  // ---- terrain ----
  ground1(i: number, j: number) {
    i = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i
    j = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j
    return this.ground[j * this.nx + i]
  }
  groundAt(x: number, y: number) {
    const fx = x - this.minX
    const fy = y - this.minY
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const u = fx - i
    const v = fy - j
    const a = this.ground1(i, j)
    const b = this.ground1(i + 1, j)
    const c = this.ground1(i, j + 1)
    const d = this.ground1(i + 1, j + 1)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
  }
  cell(x: number, y: number) {
    const i = Math.round(x - this.minX)
    const j = Math.round(y - this.minY)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }

  // ---- solids ----
  private add(k: number, base: number, top: number) {
    if (Number.isNaN(this.b1[k])) {
      this.b1[k] = base
      this.t1[k] = top
    } else if (Number.isNaN(this.b2[k])) {
      this.b2[k] = base
      this.t2[k] = top
    } else {
      // a third interval: merge into the nearest one (rare)
      this.b2[k] = Math.min(this.b2[k], base)
      this.t2[k] = Math.max(this.t2[k], top)
    }
  }
  /** Scanline fill of a polygon with holes (even-odd), sampling 1 m cell centers. */
  private fill(p: Prism) {
    const rings = [p.ring, ...(p.holes ?? [])]
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 1; i < p.ring.length; i += 2) {
      y0 = Math.min(y0, p.ring[i])
      y1 = Math.max(y1, p.ring[i])
    }
    const j0 = Math.max(0, Math.ceil(y0 - this.minY))
    const j1 = Math.min(this.ny - 1, Math.floor(y1 - this.minY))
    const xs: number[] = []
    for (let j = j0; j <= j1; j++) {
      const y = this.minY + j
      xs.length = 0
      for (const r of rings) {
        const m = r.length / 2
        for (let a = 0, b = m - 1; a < m; b = a++) {
          const ya = r[a * 2 + 1]
          const yb = r[b * 2 + 1]
          if (ya > y !== yb > y) xs.push(r[a * 2] + ((y - ya) / (yb - ya)) * (r[b * 2] - r[a * 2]))
        }
      }
      xs.sort((a, b) => a - b)
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil(xs[q] - this.minX))
        const i1 = Math.min(this.nx - 1, Math.floor(xs[q + 1] - this.minX))
        for (let i = i0; i <= i1; i++) this.add(j * this.nx + i, p.base, p.top)
      }
    }
  }
  /** Is (x, y, z) inside terrain or a solid? Out of bounds counts as solid (the map edge is a wall). */
  solid(x: number, y: number, z: number) {
    const k = this.cell(x, y)
    if (k < 0) return true
    if (z < this.groundAt(x, y)) return true
    const b1 = this.b1[k]
    if (Number.isNaN(b1)) return false
    if (z >= b1 && z <= this.t1[k]) return true
    const b2 = this.b2[k]
    return !Number.isNaN(b2) && z >= b2 && z <= this.t2[k]
  }
  /** Highest surface a mech standing near height z would stand on at (x, y). */
  standZ(x: number, y: number, z: number) {
    const k = this.cell(x, y)
    let s = this.groundAt(x, y)
    if (k < 0) return s
    for (const [b, t] of [
      [this.b1[k], this.t1[k]],
      [this.b2[k], this.t2[k]],
    ])
      if (!Number.isNaN(b) && t > s && t <= z + STEP_UP) s = t
    return s
  }
  /** Straight segment free of terrain and solids (trees do not stop shots). Samples every `stepM` m. */
  clear(a: number[], b: number[], stepM = 1) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const len = Math.hypot(dx, dy, dz)
    const n = Math.max(1, Math.ceil(len / stepM))
    for (let s = 1; s < n; s++) {
      const f = s / n
      if (this.solid(a[0] + dx * f, a[1] + dy * f, a[2] + dz * f)) return false
    }
    return true
  }

  // ---- walk grid ----
  /** A ground cell is blocked if a solid occupies the body space above the ground there. */
  private blocked1(k: number) {
    const g = this.ground[k]
    const hit = (b: number, t: number) => !Number.isNaN(b) && t > g + STEP_UP && b < g + BODY
    return hit(this.b1[k], this.t1[k]) || hit(this.b2[k], this.t2[k])
  }
  private buildWalk() {
    const { nx, ny } = this
    const blocked = new Uint8Array(nx * ny)
    for (let k = 0; k < blocked.length; k++) blocked[k] = this.blocked1(k) ? 1 : 0
    // steep terrain blocks too
    const maxRise = Math.tan((50 * Math.PI) / 180) * 1
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i
        if (Math.abs(this.ground[k + 1] - this.ground[k]) > maxRise || Math.abs(this.ground[k + nx] - this.ground[k]) > maxRise) blocked[k] = 1
      }
    // a nav cell is walkable if no blocked 1 m cell lies within the mech radius (+margin) of its center
    const R = 3
    for (let gj = 0; gj < this.gy; gj++)
      for (let gi = 0; gi < this.gx; gi++) {
        const ci = gi * NAV + 1
        const cj = gj * NAV + 1
        let ok = ci < nx && cj < ny
        for (let dj = -R; ok && dj <= R; dj++)
          for (let di = -R; di <= R; di++) {
            if (di * di + dj * dj > R * R) continue
            const i = ci + di
            const j = cj + dj
            if (i < 0 || j < 0 || i >= nx || j >= ny || blocked[j * nx + i]) {
              ok = false
              break
            }
          }
        this.walk[gj * this.gx + gi] = ok ? 1 : 0
      }
  }
  navOf(x: number, y: number): [number, number] {
    return [Math.floor((x - this.minX) / NAV), Math.floor((y - this.minY) / NAV)]
  }
  navCenter(gi: number, gj: number): [number, number] {
    return [this.minX + gi * NAV + 1, this.minY + gj * NAV + 1]
  }
  walkable(gi: number, gj: number) {
    return gi >= 0 && gj >= 0 && gi < this.gx && gj < this.gy && this.walk[gj * this.gx + gi] === 1
  }
  /** Nearest walkable nav cell to (gi, gj), searching rings outward. */
  nearestWalkable(gi: number, gj: number, maxR = 30): [number, number] | null {
    if (this.walkable(gi, gj)) return [gi, gj]
    for (let r = 1; r <= maxR; r++)
      for (let d = -r; d <= r; d++)
        for (const [a, b] of [
          [gi + d, gj - r],
          [gi + d, gj + r],
          [gi - r, gj + d],
          [gi + r, gj + d],
        ])
          if (this.walkable(a, b)) return [a, b]
    return null
  }

  /**
   * A* on the walk grid from world (sx, sy) to (tx, ty). Returns world waypoints (cell centers,
   * simplified with line-of-walk), or null. `maxExpand` bounds the work.
   */
  path(sx: number, sy: number, tx: number, ty: number, maxExpand = 40000): [number, number][] | null {
    const s = this.nearestWalkable(...this.navOf(sx, sy))
    const t = this.nearestWalkable(...this.navOf(tx, ty))
    if (!s || !t) return null
    const W = this.gx
    const N = W * this.gy
    const start = s[1] * W + s[0]
    const goal = t[1] * W + t[0]
    const g = (this._g ??= new Float64Array(N))
    const from = (this._from ??= new Int32Array(N))
    const seen = (this._seen ??= new Uint32Array(N))
    const stamp = ++this._stamp
    const heap = new MinHeap()
    const h = (k: number) => {
      const dx = Math.abs((k % W) - t[0])
      const dy = Math.abs(Math.floor(k / W) - t[1])
      return Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy)
    }
    seen[start] = stamp
    g[start] = 0
    from[start] = -1
    heap.push(start, h(start))
    let expanded = 0
    let best = start
    let bestH = h(start)
    while (heap.size) {
      const k = heap.pop()
      if (k === goal) {
        best = goal
        break
      }
      if (++expanded > maxExpand) break
      const ki = k % W
      const kj = (k - ki) / W
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = ki + di
          const nj = kj + dj
          if (!this.walkable(ni, nj)) continue
          if (di && dj && (!this.walkable(ki + di, kj) || !this.walkable(ki, kj + dj))) continue
          const nk = nj * W + ni
          const ng = g[k] + (di && dj ? 1.41421356 : 1)
          if (seen[nk] === stamp && ng >= g[nk]) continue
          seen[nk] = stamp
          g[nk] = ng
          from[nk] = k
          const hn = h(nk)
          if (hn < bestH) {
            bestH = hn
            best = nk
          }
          heap.push(nk, ng + hn)
        }
    }
    const cells: number[] = []
    for (let k = best; k !== -1; k = from[k]) cells.push(k)
    cells.reverse()
    const pts = cells.map((k) => this.navCenter(k % W, Math.floor(k / W)))
    if (best === goal) pts.push([tx, ty])
    return this.simplify(pts)
  }
  private _g?: Float64Array
  private _from?: Int32Array
  private _seen?: Uint32Array
  private _stamp = 0

  /** Straight walk between two points stays on walkable nav cells. */
  walkLine(a: [number, number], b: [number, number]) {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.ceil(d / (NAV / 2)))
    for (let s = 0; s <= n; s++) {
      const f = s / n
      const [gi, gj] = this.navOf(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
      if (!this.walkable(gi, gj)) return false
    }
    return true
  }
  private simplify(pts: [number, number][]) {
    if (pts.length <= 2) return pts
    const out: [number, number][] = [pts[0]]
    let i = 0
    while (i < pts.length - 1) {
      let j = pts.length - 1
      while (j > i + 1 && !this.walkLine(pts[i], pts[j])) j--
      out.push(pts[j])
      i = j
    }
    return out
  }
}

class MinHeap {
  private k: number[] = []
  private p: number[] = []
  get size() {
    return this.k.length
  }
  push(key: number, pri: number) {
    const { k, p } = this
    let i = k.length
    k.push(key)
    p.push(pri)
    while (i > 0) {
      const up = (i - 1) >> 1
      if (p[up] <= pri) break
      k[i] = k[up]
      p[i] = p[up]
      i = up
    }
    k[i] = key
    p[i] = pri
  }
  pop() {
    const { k, p } = this
    const top = k[0]
    const lk = k.pop()!
    const lp = p.pop()!
    if (k.length) {
      let i = 0
      const n = k.length
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && p[c + 1] < p[c]) c++
        if (p[c] >= lp) break
        k[i] = k[c]
        p[i] = p[c]
        i = c
      }
      k[i] = lk
      p[i] = lp
    }
    return top
  }
}
