#!/bin/sh
set -eu
# Docker on this host creates root-owned log pipes. PHP-FPM reopens stderr
# after the upstream entrypoint drops privileges, so give its UID access first.
chown 65534:82 /proc/self/fd/1 /proc/self/fd/2
exec /bin/sh /usr/local/bin/privatebin-start
