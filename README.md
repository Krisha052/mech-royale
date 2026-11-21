# mech-royale

A bot for the Builders Mech Royale track (16-mech battle royale, `mechfight/1` protocol).

- `Dockerfile`, `mechfight.ts`, `*.ts`: the bot (TypeScript, runs with bun).
- `kit/`: the organizers' kit, kept for local testing (`check.py`, map, `protocol.md`). Not copied into the image.

## Check locally

```sh
python3 kit/check/check.py -- bun example.ts
docker build -t mech-royale .
python3 kit/check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/kit/arena:/arena:ro" mech-royale
```
