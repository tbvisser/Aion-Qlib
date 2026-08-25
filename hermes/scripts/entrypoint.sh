#!/bin/sh
# Seed Aion config, then hand off to official s6 entrypoint (must run as root).
set -eu

DATA="${HERMES_HOME:-/hermes-data}"
export HERMES_HOME="$DATA"

/opt/aion/seed.sh
chown -R hermes:hermes "${DATA}"

exec /opt/hermes/docker/entrypoint-dispatch.sh "$@"
