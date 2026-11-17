#!/bin/sh
set -eu
# Keep the upstream binary as PID 1, without a resident launcher process.
exec /app/chhoto-url
