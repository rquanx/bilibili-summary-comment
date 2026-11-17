#!/bin/sh
set -eu
cd /kutt
# Preserve upstream's migration step without keeping an npm launcher resident.
node node_modules/knex/bin/cli.js migrate:latest
exec node server/server.js --production
