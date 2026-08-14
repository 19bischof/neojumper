#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.user.neojumper.plist"
LABEL="com.user.neojumper"
LOG_DIR="$SCRIPT_DIR/logs"
BOOTSTRAP_ERROR_LOG="$LOG_DIR/neojumper-launchd-bootstrap.err.log"

if [[ -z "$ACTION" ]]; then
  echo "Neojumper LaunchAgent Manager"
  echo "1) load"
  echo "2) unload"
  echo "3) restart"
  echo -n "> "
  read -r ACTION

  case "$ACTION" in
    1)
      ACTION="load"
      ;;
    2)
      ACTION="unload"
      ;;
    3)
      ACTION="restart"
      ;;
    *)
      echo "Invalid choice. Use load, unload, or restart."
      exit 1
      ;;
  esac
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR"

render_plist() {
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${SCRIPT_DIR}/run.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/neojumper.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/neojumper.err.log</string>
  </dict>
</plist>
EOF
}

load_agent() {
  render_plist
  : > "$BOOTSTRAP_ERROR_LOG"

  if launchctl bootstrap "gui/$UID" "$PLIST_PATH" 2> "$BOOTSTRAP_ERROR_LOG"; then
    echo "Neojumper loaded at http://localhost:8766"
    return
  fi

  if launchctl load "$PLIST_PATH" 2>> "$BOOTSTRAP_ERROR_LOG"; then
    echo "Neojumper loaded using legacy launchctl compatibility."
    return
  fi

  echo "Could not load Neojumper. See: $BOOTSTRAP_ERROR_LOG" >&2
  /bin/cat "$BOOTSTRAP_ERROR_LOG" >&2
  exit 1
}

unload_agent() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  echo "Neojumper unloaded."
}

case "$ACTION" in
  load)
    load_agent
    ;;
  unload)
    unload_agent
    ;;
  restart)
    unload_agent
    load_agent
    ;;
  *)
    echo "Usage: $0 [load|unload|restart]"
    exit 1
    ;;
esac
