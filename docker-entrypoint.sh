#!/usr/bin/env sh
set -eu

mkdir -p /app/work /app/.auth

exec "$@"
