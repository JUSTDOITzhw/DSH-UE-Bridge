#!/usr/bin/env sh
# dsh-ue-bridge installer (macOS / Linux / Git Bash).
set -e

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required but was not found on PATH." >&2
  exit 127
fi

exec node "$DIR/install.mjs" "$@"
