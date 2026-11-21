import { World } from "../world.ts"
let t0 = performance.now()
const w = new World("kit/arena")
console.log(`load ${(performance.now() - t0).toFixed(0)} ms, walk grid ${w.gx}x${w.gy}, walkable ${(w.walk.reduce((a, b) => a + b, 0) / w.walk.length * 100).toFixed(1)}%`)
// a building cell: find the tallest solid
let best = -1, bt = -Infinity
for (let k = 0; k < w.t1.length; k++) if (w.t1[k] > bt) { bt = w.t1[k]; best = k }
const bx = w.minX + (best % w.nx), by = w.minY + Math.floor(best / w.nx)
console.log(`tallest solid top ${bt.toFixed(1)} m at (${bx}, ${by}); solid at z=10: ${w.solid(bx, by, 10)}; ground there ${w.groundAt(bx, by).toFixed(2)}`)
console.log(`line through it blocked: ${!w.clear([bx - 60, by, 8], [bx + 60, by, 8])}; line above it clear: ${w.clear([bx - 60, by, bt + 5], [bx + 60, by, bt + 5])}`)
// random paths
let rnd = 12345; const r = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
let found = 0, worst = 0, total = 0
for (let n = 0; n < 200; n++) {
  const a = [w.minX + r() * w.nx, w.minY + r() * w.ny], b = [w.minX + r() * w.nx, w.minY + r() * w.ny]
  t0 = performance.now(); const p = w.path(a[0], a[1], b[0], b[1]); const dt = performance.now() - t0
  worst = Math.max(worst, dt); total += dt
  if (p && Math.hypot(p.at(-1)![0] - b[0], p.at(-1)![1] - b[1]) < 1) found++
}
console.log(`200 random paths: reached ${found}, avg ${(total / 200).toFixed(2)} ms, worst ${worst.toFixed(2)} ms`)
