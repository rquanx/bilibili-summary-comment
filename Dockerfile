FROM node:24-bookworm-slim

ARG TORCH_VERSION=2.11.0+cpu
ARG TORCHAUDIO_VERSION=2.11.0+cpu
ARG PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    VENV_PATH=/app/.3.11 \
    PATH=/app/.3.11/bin:${PATH} \
    WORK_ROOT=work \
    PIPELINE_DB_PATH=work/pipeline.sqlite3 \
    BILI_AUTH_FILE=.auth/bili-auth.json \
    MODELSCOPE_CACHE=/opt/funasr/modelscope \
    FUNASR_MODEL=paraformer-zh \
    FUNASR_VAD_MODEL=fsmn-vad \
    FUNASR_PUNC_MODEL=ct-punc \
    FUNASR_DEVICE=auto \
    FUNASR_LANGUAGE=zh

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
  && ./.3.11/bin/python -m pip install \
    "torch==${TORCH_VERSION}" \
    "torchaudio==${TORCHAUDIO_VERSION}" \
    --index-url "${PYTORCH_INDEX_URL}" \
  && ./.3.11/bin/python -m pip install -r requirements.txt

COPY . .

RUN mkdir -p /app/work /app/.auth /opt/funasr/modelscope

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/work", "/app/.auth"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
