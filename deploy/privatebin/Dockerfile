# Official PrivateBin 2.1.1 linux/amd64 image, pinned for reproducible deployments.
ARG PRIVATEBIN_BASE_IMAGE=privatebin/nginx-fpm-alpine@sha256:9f808790567ef99454319cfd0e056a09c3aff1d496033d1d58fa07e5ad8a268e
FROM ${PRIVATEBIN_BASE_IMAGE}
USER root
COPY conf.php /srv/cfg/conf.php
COPY start.sh /usr/local/bin/privatebin-start
COPY manifest.json /var/www/manifest.json
COPY legacy-domain.conf /etc/nginx/http.d/legacy-domain.conf
COPY reader/reader.php /srv/tpl/reader.php
COPY reader/reader.css /var/www/css/reader.css
COPY reader/reader.js /var/www/js/reader.js
COPY reader/reader-boot.js /var/www/js/reader-boot.js
COPY patch-reader-core.php /tmp/patch-reader-core.php
RUN php /tmp/patch-reader-core.php && rm /tmp/patch-reader-core.php
# Shared Railway hosts expose many CPUs; this low-traffic service needs one worker.
RUN test "$(grep -c '^worker_processes auto;' /etc/nginx/nginx.conf)" = 1 \
    && sed -i 's/^worker_processes auto;/worker_processes 1;/' /etc/nginx/nginx.conf \
    && nginx -t \
    && rm -f /run/nginx.pid
RUN chmod 644 /srv/cfg/conf.php && chmod 755 /usr/local/bin/privatebin-start
ENTRYPOINT ["/bin/sh", "/usr/local/bin/privatebin-start"]
