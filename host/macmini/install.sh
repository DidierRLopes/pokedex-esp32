#!/usr/bin/env bash
# Run the PokeDex companion as an always-on service on this Mac (the Mac mini),
# for the Wi-Fi build of the board. Safe to re-run; the USB setup is untouched.
#   host/macmini/install.sh              # install / update and start
#   host/macmini/install.sh uninstall    # stop and remove the service
# Extra companion options go in POKEDEX_ARGS, e.g.
#   POKEDEX_ARGS="--website /Users/me/code/pokemon-website" host/macmini/install.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.pokedex.companion"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${POKEDEX_PORT:-8765}"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. (Turn Funnel off with: tailscale funnel --https=443 off)"
  exit 0
fi

PY="$ROOT/.voice-venv/bin/python"
[ -x "$PY" ] || { echo "Create the venv first: python3.12 -m venv .voice-venv && .voice-venv/bin/pip install -r requirements.txt" >&2; exit 1; }

# Shared secret the board must present (kept out of git and out of the plist).
TOKEN_FILE="$HOME/.pokedex-token"
if [ ! -s "$TOKEN_FILE" ]; then
  "$PY" -c "import secrets; print(secrets.token_urlsafe(32))" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "Created $TOKEN_FILE"
fi

EXTRA=""
for arg in ${POKEDEX_ARGS:-}; do EXTRA="$EXTRA    <string>$arg</string>
"; done

mkdir -p "$HOME/Library/Logs" "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-u</string>
    <string>$ROOT/host/pokemon_bridge.py</string>
    <string>--listen</string><string>127.0.0.1:$PORT</string>
    <string>--no-serial</string>
$EXTRA  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/pokedex-companion.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/pokedex-companion.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Started $LABEL (log: ~/Library/Logs/pokedex-companion.log)"

HOST=$(tailscale status --json 2>/dev/null | "$PY" -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null || echo "<this-mac>.<tailnet>.ts.net")
cat <<NEXT

Next:
  1. Publish it:   tailscale funnel --bg $PORT
  2. Board config (sdkconfig.defaults.wifi.local):
       CONFIG_POKEDEX_SERVER_URL="wss://$HOST/"
       CONFIG_POKEDEX_TOKEN="$(cat "$TOKEN_FILE")"
  3. Keep the Mac awake: System Settings > Energy > "Prevent automatic sleeping"
     and "Start up automatically after a power failure".
NEXT
