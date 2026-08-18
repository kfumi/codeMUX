#!/usr/bin/env bash
set -e

RELAY_DIR="${RELAY_DIR:-/opt/codemux-relay}"
REPO_RELAY="$(cd "$(dirname "$0")" && pwd)"

echo "==> 安装目录: $RELAY_DIR"
mkdir -p "$RELAY_DIR"
cp "$REPO_RELAY/companion-relay.mjs" "$RELAY_DIR/companion-relay.mjs"
cp "$REPO_RELAY/companion-relay-bridge.mjs" "$RELAY_DIR/companion-relay-bridge.mjs"
cp "$REPO_RELAY/package.json" "$RELAY_DIR/package.json"
cd "$RELAY_DIR"
npm install --omit=dev

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

pm2 delete codemux-relay 2>/dev/null || true
pm2 start companion-relay.mjs --name codemux-relay -- --port 8787
pm2 save

echo "==> Relay 已启动: curl http://127.0.0.1:8787"
