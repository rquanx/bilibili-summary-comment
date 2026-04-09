#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VENV_PATH="${VENV_PATH:-.3.11}"
PREFERRED_PYTHON="${PREFERRED_PYTHON:-python3.11}"
SKIP_NODE="${SKIP_NODE:-0}"
SKIP_PYTHON="${SKIP_PYTHON:-0}"

write_step() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

resolve_python() {
  if command -v "$PREFERRED_PYTHON" >/dev/null 2>&1; then
    printf '%s' "$PREFERRED_PYTHON"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "python3"
    return
  fi

  if command -v python >/dev/null 2>&1; then
    printf '%s' "python"
    return
  fi

  echo "Python is required but was not found." >&2
  exit 1
}

if [[ "$SKIP_NODE" != "1" ]]; then
  write_step "Installing Node.js dependencies"
  require_command node
  require_command npm

  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

if [[ "$SKIP_PYTHON" != "1" ]]; then
  write_step "Preparing Python virtual environment"
  PYTHON_CMD="$(resolve_python)"

  if [[ ! -d "$VENV_PATH" ]]; then
    "$PYTHON_CMD" -m venv "$VENV_PATH"
  fi

  VENV_PYTHON="$REPO_ROOT/$VENV_PATH/bin/python"
  if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "Virtual environment python not found: $VENV_PYTHON" >&2
    exit 1
  fi

  "$VENV_PYTHON" -m pip install --upgrade pip
  "$VENV_PYTHON" -m pip install -r requirements.txt

  write_step "Checking Python tools"
  "$VENV_PYTHON" -m yt_dlp --version
  "$VENV_PYTHON" -m videocaptioner --help >/dev/null
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  printf '\nWarning: ffmpeg was not found in PATH. Subtitle transcription may fail until ffmpeg is installed.\n' >&2
fi

printf '\nEnvironment setup completed.\n'
