# Official 7.11.4-alpine image, pinned after the approved download.
ARG CHHOTO_BASE_IMAGE=sintan1729/chhoto-url@sha256:c68314649b6bfc18dcb376842175e07161ef052b86af98c7fb4a6a6a46d69613
FROM ${CHHOTO_BASE_IMAGE}
COPY start.sh /usr/local/bin/chhoto-start
ENTRYPOINT ["/bin/sh", "/usr/local/bin/chhoto-start"]
