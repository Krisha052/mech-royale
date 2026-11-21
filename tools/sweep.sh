#!/bin/bash
# Compare fight settings for bot A against two opponents. Usage: tools/sweep.sh OUTDIR GAMES "name:BOT_X=1,BOT_Y=2" ...
out=$1; games=$2; shift 2; mkdir -p "$out"
for spec in "$@"; do
  name=${spec%%:*}; envs=${spec#*:}; [ "$envs" = "$spec" ] && envs=""
  for opp in example mirror; do
    oc="bun example.ts"; [ $opp = mirror ] && oc="bun bot.ts"
    python3 tools/duel.py --games "$games" --seed 7 --envA "$envs" -- "bun bot.ts" "$oc" 2>&1 | tail -3 > "$out/$name-$opp.txt" &
  done
done
wait
printf "%-12s %-8s %-6s %-8s %-7s %s\n" variant opponent wins taken speed opp_hit%
for f in $(ls "$out"/*.txt | sort); do
  n=$(basename "$f" .txt); a=$(grep "^A " "$f"); b=$(grep "^B " "$f")
  printf "%-12s %-8s %-6s %-8s %-7s %s\n" "${n%-*}" "${n##*-}" "$(grep -o 'wins [0-9]*/[0-9]*' <<<"$a" | cut -d' ' -f2)" "$(grep -o 'taken/game [0-9]*' <<<"$a" | cut -d' ' -f2)" "$(grep -o 'speed [0-9.]*' <<<"$a" | cut -d' ' -f2)" "$(grep -o 'hit% [0-9.]*' <<<"$b" | cut -d' ' -f2)"
done
