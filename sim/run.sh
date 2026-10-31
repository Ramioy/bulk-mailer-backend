#!/usr/bin/env bash
# Runs the simulated month against the environment started by sim/up.sh and keeps the logs next to the report.
# While the runner works, this script plays the deployment team: the runner leaves a request in sim/out/control
# (stop-app, start-app, start-app2, stop-app2) and this loop runs the matching `docker compose` command, then marks it done.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=sim/out
COMPOSE=(docker compose -f sim/docker-compose.yml --env-file "$OUT/sim.env")
mkdir -p "$OUT/control"
rm -f "$OUT"/control/*

control_loop() {
  while true; do
    for request in "$OUT"/control/*.request; do
      [ -e "$request" ] || continue
      name=$(basename "$request" .request)
      action=$(cat "$request")
      echo "[control] $name: $action" >> "$OUT/control.log"
      case "$action" in
        stop-app) "${COMPOSE[@]}" stop app ;;
        start-app) "${COMPOSE[@]}" start app ;;
        start-app2) "${COMPOSE[@]}" --profile two up -d --no-deps app2 ;;
        stop-app2) "${COMPOSE[@]}" --profile two rm -sf app2 ;;
        *) echo "unknown action: $action" ;;
      esac >> "$OUT/control.log" 2>&1
      echo "$?" > "$OUT/control/$name.done"
      rm -f "$request"
    done
    sleep 1
  done
}
control_loop &
control_pid=$!
trap 'kill "$control_pid" 2>/dev/null' EXIT

"${COMPOSE[@]}" --profile run run --rm runner 2>&1 | tee "$OUT/run.log"
status=${PIPESTATUS[0]}
for service in app zeptomail tayrona sap; do "${COMPOSE[@]}" logs --no-color "$service" > "$OUT/$service.log" 2>&1; done
echo "Report: $OUT/report.md · logs: $OUT/*.log"
exit "$status"
