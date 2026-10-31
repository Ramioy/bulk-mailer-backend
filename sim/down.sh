#!/usr/bin/env bash
# Stops the simulated environment and deletes its database and volumes (sim/out stays).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f sim/docker-compose.yml --env-file sim/out/sim.env down -v --remove-orphans
