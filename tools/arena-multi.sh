#!/bin/bash
# Average kills over 4 seeds x RUNS for each setting. Usage: tools/arena-multi.sh RUNS "name:BOT_X=1,BOT_Y=2" ...
runs=$1; shift
tmp=$(mktemp -d)
for spec in "$@"; do
  name=${spec%%:*}; envs=${spec#*:}; [ "$envs" = "$spec" ] && envs=""
  for sd in 3 5 7 9; do
    ( bun tools/arena-sim.ts --runs "$runs" --seed $sd --env "$envs" | tail -1 | grep -oE 'kills mean [0-9.]+' | awk '{print $3}' > "$tmp/$name-$sd" ) &
  done
done
wait
for spec in "$@"; do
  name=${spec%%:*}
  vals=$(cat "$tmp/$name"-* | tr '\n' ' ')
  printf "%-14s mean %s   per seed: %s\n" "$name" "$(cat "$tmp/$name"-* | awk '{s+=$1} END {printf "%.2f", s/NR}')" "$vals"
done
