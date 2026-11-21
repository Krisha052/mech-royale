#!/bin/bash
# Compare settings in the real-map arena. Usage: tools/arena-sweep.sh RUNS "name:BOT_X=1,BOT_Y=2|--weapon laser" ...
runs=$1; shift
for spec in "$@"; do
  name=${spec%%:*}; rest=${spec#*:}; envs=${rest%%|*}; extra=""; [[ "$rest" == *"|"* ]] && extra=${rest#*|}
  ( printf "%-14s %s\n" "$name" "$(bun tools/arena-sim.ts --runs "$runs" --seed 3 --env "$envs" $extra | tail -1 | sed 's/^ARENA [^:]*: //')" ) &
done
wait
