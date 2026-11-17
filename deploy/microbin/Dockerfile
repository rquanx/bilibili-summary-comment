# Official MicroBin 2.1.4, pinned to the reviewed linux/amd64 image.
FROM danielszabo99/microbin@sha256:e66131ff155fcf37d7daa64ec0a457d22d44f0057e5422efb6f085c0967700fc

ENV MICROBIN_BIND=0.0.0.0 \
    MICROBIN_PORT=8080 \
    MICROBIN_DATA_DIR=/app/microbin_data \
    MICROBIN_JSON_DB=true \
    MICROBIN_READONLY=true \
    MICROBIN_NO_LISTING=true \
    MICROBIN_DEFAULT_PRIVACY=unlisted \
    MICROBIN_EDITABLE=false \
    MICROBIN_ETERNAL_PASTA=true \
    MICROBIN_DEFAULT_EXPIRY=never \
    MICROBIN_MAX_EXPIRY=never \
    MICROBIN_GC_DAYS=0 \
    MICROBIN_ENABLE_BURN_AFTER=false \
    MICROBIN_DEFAULT_BURN_AFTER=0 \
    MICROBIN_NO_FILE_UPLOAD=true \
    MICROBIN_THREADS=1 \
    MICROBIN_DISABLE_TELEMETRY=true \
    MICROBIN_DISABLE_UPDATE_CHECKING=true

COPY start.sh /app/start.sh
ENTRYPOINT ["/bin/sh", "/app/start.sh"]
