#!/bin/bash
# Gauntlet comparison: kills before death, one opponent at a time. Usage: tools/gauntlet.sh OUTDIR RUNS OPP "name:BOT_X=1|--weaponA laser" ...
out=$1; runs=$2; opp=$3; shift 3; mkdir -p "$out"
for spec in "$@"; do
  name=${spec%%:*}; rest=${spec#*:}; envs=${rest%%|*}; extra=""; [[ "$rest" == *"|"* ]] && extra=${rest#*|}
  python3 tools/duel.py --gauntlet --games "$runs" --time 300 --gap 10 --dist 150 --seed 11 --envA "$envs" $extra -- "bun bot.ts" "$opp" 2>&1 | tail -1 > "$out/$name.txt" &
done
wait
for f in $(ls "$out"/*.txt | sort); do printf "%-14s %s\n" "$(basename "$f" .txt)" "$(cat "$f")"; done
