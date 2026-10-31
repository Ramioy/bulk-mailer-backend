#!/usr/bin/env bash
# Runs the simulated month against the environment started by sim/up.sh and keeps the logs next to the report.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=sim/out
COMPOSE=(docker compose -f sim/docker-compose.yml --env-file "$OUT/sim.env")
"${COMPOSE[@]}" --profile run run --rm runner 2>&1 | tee "$OUT/run.log"
status=${PIPESTATUS[0]}
for service in app zeptomail tayrona sap; do "${COMPOSE[@]}" logs --no-color "$service" > "$OUT/$service.log" 2>&1; done
echo "Report: $OUT/report.md · logs: $OUT/*.log"
exit "$status"
