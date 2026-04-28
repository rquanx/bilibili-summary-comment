FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    VENV_PATH=/app/.3.11 \
    PATH=/app/.3.11/bin:${PATH} \
    WORK_ROOT=work \
    PIPELINE_DB_PATH=work/pipeline.sqlite3 \
    BILI_AUTH_FILE=.auth/bili-auth.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json requirements.txt ./

RUN npm ci \
  && python3 -m venv .3.11 \
  && ./.3.11/bin/python -m pip install --upgrade pip \
  && ./.3.11/bin/python -m pip install -r requirements.txt

COPY . .

RUN mkdir -p /app/work /app/.auth

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/work", "/app/.auth"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
