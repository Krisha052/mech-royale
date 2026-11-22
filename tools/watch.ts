// Record a public spectator stream (what play.joinbuilders.org/?watch shows) to a JSONL file.
const [room, seconds, out] = [process.argv[2], Number(process.argv[3] ?? 60), process.argv[4]]
const pick = room || (await (await fetch("https://play.joinbuilders.org/mm/pick?watch=1")).json()).room
const url = `wss://play.joinbuilders.org/r/${pick}/live`
const file = Bun.file(out ?? `rec-${pick}.jsonl`).writer()
let frames = 0
const ws = new WebSocket(url)
ws.onopen = () => console.error(`connected to room ${pick}`)
ws.onmessage = (e) => { const s = String(e.data); file.write(s.endsWith("\n") ? s : s + "\n"); frames += s.split("\n").filter(Boolean).length }
ws.onclose = () => console.error("closed")
setTimeout(() => { ws.close(); file.end(); console.error(`room ${pick}: ${frames} lines in ${seconds} s`); process.exit(0) }, seconds * 1000)
