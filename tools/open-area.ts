import { World } from "../world.ts"
const w = new World("kit/arena")
// find centers where a 200 m x 60 m box has no solid in body space and gentle terrain
let best: [number, number, number] | null = null
for (let y = w.minY + 60; y < w.minY + w.ny - 60; y += 10)
  for (let x = w.minX + 120; x < w.minX + w.nx - 120; x += 10) {
    let ok = true, zmin = Infinity, zmax = -Infinity
    for (let dy = -30; ok && dy <= 30; dy += 3) for (let dx = -100; dx <= 100; dx += 3) {
      const g = w.groundAt(x + dx, y + dy); zmin = Math.min(zmin, g); zmax = Math.max(zmax, g)
      if (w.solid(x + dx, y + dy, g + 4) || w.solid(x + dx, y + dy, g + 8)) { ok = false; break }
    }
    if (ok && (!best || zmax - zmin < best[2])) best = [x, y, zmax - zmin]
  }
console.log("open 200x60 box center", best)
