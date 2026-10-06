#!/usr/bin/env bash
# Deploy a built Node app to an exe.dev VM.
# Usage: deploy.sh <vm> <reports|server> [app-name]
#   APP_DIR    local app dir (default: blastradius)
#   START_CMD  server mode start command (default: node dist/server.js)
#   SCAN_TIME  reports mode systemd OnCalendar (default: *-*-* 02:00:00 UTC)
set -euo pipefail

VM="${1:?usage: deploy.sh <vm> <reports|server> [app-name]}"
MODE="${2:?mode must be reports or server}"
APP="${3:-blastradius}"
APP_DIR="${APP_DIR:-blastradius}"
START_CMD="${START_CMD:-node dist/server.js}"
SCAN_TIME="${SCAN_TIME:-*-*-* 02:00:00 UTC}"
PORT=8000

[[ "$VM" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "bad VM name: $VM" >&2; exit 2; }
[[ "$APP" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "bad app name: $APP" >&2; exit 2; }
[[ "$MODE" == reports || "$MODE" == server ]] || { echo "mode must be reports or server" >&2; exit 2; }
[[ -f "$APP_DIR/package.json" && -f "$APP_DIR/package-lock.json" && -d "$APP_DIR/dist" ]] || { echo "build first: need $APP_DIR/{package.json,package-lock.json,dist}" >&2; exit 2; }

HOST="$VM.exe.xyz"
SSH=(ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 "$HOST")
REL="$(date -u +%Y%m%d%H%M%S)"
BASE="/opt/$APP"

echo "==> Uploading release $REL to $HOST"
"${SSH[@]}" "sudo mkdir -p $BASE/releases/$REL && sudo chown \"\$(id -un)\" $BASE/releases/$REL"
tar -C "$APP_DIR" -czf - package.json package-lock.json dist $( [[ -d "$APP_DIR/kb" ]] && echo kb ) \
  | "${SSH[@]}" "tar -C $BASE/releases/$REL -xzf -"

echo "==> Installing runtime and production deps"
"${SSH[@]}" bash -s <<EOF
set -euo pipefail
if ! command -v node >/dev/null || [ "\$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
fi
cd $BASE/releases/$REL
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
sudo ln -sfn $BASE/releases/$REL $BASE/current
sudo mkdir -p /etc/$APP && sudo touch /etc/$APP/env && sudo chmod 600 /etc/$APP/env
EOF

if [[ "$MODE" == reports ]]; then
  echo "==> Installing nightly scan timer and report server"
  "${SSH[@]}" bash -s <<EOF
set -euo pipefail
sudo mkdir -p /srv/$APP/out
sudo touch /etc/$APP/targets
sudo tee /usr/local/bin/$APP-scan >/dev/null <<'SCAN'
#!/usr/bin/env bash
set -uo pipefail
out=/srv/$APP/out/\$(date -u +%F)
mkdir -p "\$out"
while IFS= read -r target; do
  [[ -z "\$target" || "\$target" == \#* ]] && continue
  name=\$(printf '%s' "\$target" | tr -c 'A-Za-z0-9._-' '_')
  node $BASE/current/dist/cli.js scan "\$target" --format json --out "\$out/\$name" || true
  node $BASE/current/dist/cli.js scan "\$target" --format sarif --out "\$out/\$name" || true
  node $BASE/current/dist/cli.js scan "\$target" --format html --out "\$out/\$name" || true
done < /etc/$APP/targets
ln -sfn "\$out" /srv/$APP/out/latest
SCAN
sudo chmod 755 /usr/local/bin/$APP-scan
sudo tee /etc/systemd/system/$APP-scan.service >/dev/null <<UNIT
[Unit]
Description=$APP nightly scan
[Service]
Type=oneshot
EnvironmentFile=-/etc/$APP/env
ExecStart=/usr/local/bin/$APP-scan
UNIT
sudo tee /etc/systemd/system/$APP-scan.timer >/dev/null <<UNIT
[Unit]
Description=Run $APP scan nightly
[Timer]
OnCalendar=$SCAN_TIME
Persistent=true
[Install]
WantedBy=timers.target
UNIT
sudo tee /etc/systemd/system/$APP.service >/dev/null <<UNIT
[Unit]
Description=$APP report server (read-only)
After=network.target
[Service]
WorkingDirectory=/srv/$APP/out
ExecStart=/usr/bin/python3 -m http.server $PORT --bind 127.0.0.1 --directory /srv/$APP/out
Restart=on-failure
DynamicUser=yes
ProtectSystem=strict
ReadOnlyPaths=/srv/$APP/out
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now $APP-scan.timer $APP.service
sudo systemctl restart $APP.service
EOF
else
  echo "==> Installing server unit"
  "${SSH[@]}" bash -s <<EOF
set -euo pipefail
sudo tee /etc/systemd/system/$APP.service >/dev/null <<UNIT
[Unit]
Description=$APP
After=network.target
[Service]
WorkingDirectory=$BASE/current
Environment=NODE_ENV=production PORT=$PORT
EnvironmentFile=-/etc/$APP/env
ExecStart=/usr/bin/env $START_CMD
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable $APP.service
sudo systemctl restart $APP.service
EOF
fi

echo "==> Health check"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "${SSH[@]}" "curl -fsS -o /dev/null http://127.0.0.1:$PORT/"; then ok=1; break; fi
  sleep 2
done
"${SSH[@]}" "cd $BASE/releases && ls -1t | tail -n +4 | xargs -r sudo rm -rf"

if [[ $ok == 1 ]]; then
  echo "OK  release $REL live on $HOST (port $PORT) -> https://$HOST/"
else
  echo "FAIL health check; logs: ssh $HOST journalctl -u $APP -n 100 --no-pager" >&2
  exit 1
fi
