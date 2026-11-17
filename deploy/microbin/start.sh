#!/bin/sh
set -eu
: "${MICROBIN_UPLOADER_PASSWORD:?Set a random upload password in Railway variables}"
: "${MICROBIN_ADMIN_PASSWORD:?Set a different random admin password in Railway variables}"
# MicroBin 2.1.4's JSON backend hardcodes pasta_data/database.json.
# Run it inside the mounted volume and map that relative path into the volume.
mkdir -p "$MICROBIN_DATA_DIR"
cd "$MICROBIN_DATA_DIR"
if [ ! -e pasta_data ]; then
  ln -s . pasta_data
fi
exec microbin
