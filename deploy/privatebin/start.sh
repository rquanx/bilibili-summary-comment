#!/bin/sh
set -eu
# Railway mounts new volumes as root. Set ownership once, then run as upstream's
# unprivileged user; never recursively change existing paste files.
mkdir -p /srv/data
chown 65534:82 /srv/data
exec s6-applyuidgid -u 65534 -g 82 /etc/init.d/rc.local
