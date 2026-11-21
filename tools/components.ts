import { World } from "../world.ts"
const w = new World("kit/arena")
const comp = new Int32Array(w.gx * w.gy).fill(-1); const sizes: number[] = []
for (let s = 0; s < comp.length; s++) {
  if (!w.walk[s] || comp[s] >= 0) continue
  const id = sizes.length; let n = 0; const st = [s]; comp[s] = id
  while (st.length) { const k = st.pop()!; n++; const i = k % w.gx, j = (k - i) / w.gx
    for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) { const a = i + di, b = j + dj; if (w.walkable(a, b)) { const q = b * w.gx + a; if (comp[q] < 0) { comp[q] = id; st.push(q) } } } }
  sizes.push(n)
}
const order = sizes.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0])
const tot = sizes.reduce((a, b) => a + b, 0)
console.log(`components ${sizes.length}; largest ${order.slice(0, 5).map(([n]) => `${n} (${(n / tot * 100).toFixed(1)}%)`).join(", ")}`)
// where is the zone start center in which component?
for (const [x, y, name] of [[41.3, -72.8, "zone start"], [-23.72, 2.21, "example next center"]] as const) { const [gi, gj] = w.navOf(x, y); console.log(name, "walkable", w.walkable(gi, gj), "comp", comp[gj * w.gx + gi], "ground", w.groundAt(x, y).toFixed(1)) }
const [tx,ty]=[-461,-55]; console.log("short line through tower blocked:", !w.clear([tx-25,ty,8],[tx+25,ty,8]), " above clear:", w.clear([tx-25,ty,80],[tx+25,ty,80]))
let rnd = 12345; const r = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
let worstT = 0; let same = 0, sameFail = 0, diff = 0
for (let n = 0; n < 200; n++) {
  const a = [w.minX + r() * w.nx, w.minY + r() * w.ny], b = [w.minX + r() * w.nx, w.minY + r() * w.ny]
  const s = w.nearestWalkable(...w.navOf(a[0], a[1]))!, t = w.nearestWalkable(...w.navOf(b[0], b[1]))!
  const cs = comp[s[1] * w.gx + s[0]], ct = comp[t[1] * w.gx + t[0]]
  const t0 = performance.now(); const p = w.path(a[0], a[1], b[0], b[1], 1e9); worstT = Math.max(worstT, performance.now() - t0); const ok = p && Math.hypot(p.at(-1)![0] - b[0], p.at(-1)![1] - b[1]) < 1
  if (cs === ct) { same++; if (!ok) sameFail++ } else diff++
}
console.log(`same component ${same} (failed ${sameFail}), different components ${diff}, worst ${worstT.toFixed(1)} ms`)
