#!/bin/sh
set -eu
APP=/opt/tg-ai-messages
test -f "$APP/.env"
test -s "$APP/.data/telegram.session"
test -f "$APP/dist/index.html"
test -d "$APP/node_modules/teleproto"
chown 1000:1000 "$APP/.env" "$APP/.data" "$APP/.data/telegram.session"
chmod 600 "$APP/.env" "$APP/.data/telegram.session"
chmod 700 "$APP/.data"
docker run -d --name tg-ai-messages --restart unless-stopped \
  --network host --user 1000:1000 --memory=256m --pids-limit=128 \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --log-opt max-size=10m --log-opt max-file=3 \
  -e NODE_ENV=production -e NODE_OPTIONS=--max-old-space-size=160 \
  -e PUBLIC_ORIGIN=https://true.reserv-app.org:8443 \
  -e MCP_ORIGIN=https://true.reserv-app.org \
  -v "$APP:/app:ro" -w /app \
  node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee \
  node server/index.js
