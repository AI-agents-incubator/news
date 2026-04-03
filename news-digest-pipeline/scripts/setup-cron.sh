#!/bin/bash
#
# Setup launchd agent for News Digest local fetcher
#
# This creates a macOS LaunchAgent that runs local-fetcher.js periodically.
# The fetcher checks the server for articles without content, opens them
# in your real Chrome browser, extracts content, and sends it back.
#
# Usage:
#   bash scripts/setup-cron.sh          # Install and load the agent
#   bash scripts/setup-cron.sh unload   # Stop and remove the agent
#
# To change the interval:
#   Edit the StartInterval value in the plist (currently 30 seconds for testing).
#   For production, 300 (5 minutes) or 600 (10 minutes) is recommended.
#
# Requirements:
#   - macOS with Google Chrome
#   - Node.js 20+ via nvm
#   - Chrome must be running (the script will start it if not)
#   - Grant Terminal/iTerm "Accessibility" permission in System Preferences
#     (System Preferences > Privacy & Security > Accessibility)
#     This is required for AppleScript to control Chrome.
#

set -euo pipefail

PLIST_LABEL="com.newsdigest.fetcher"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"

# Unload if requested
if [ "${1:-}" = "unload" ]; then
  echo "Unloading ${PLIST_LABEL}..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Done. Agent removed."
  exit 0
fi

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Detect nvm path
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -f "$NVM_DIR/nvm.sh" ]; then
  echo "Error: nvm not found at $NVM_DIR/nvm.sh"
  echo "Set NVM_DIR if nvm is installed elsewhere."
  exit 1
fi

# Find Node.js 20 path via nvm
NODE_PATH=$(bash -c "source '$NVM_DIR/nvm.sh' && nvm use 20 >/dev/null 2>&1 && which node")
if [ -z "$NODE_PATH" ]; then
  echo "Error: Node.js 20 not found via nvm."
  echo "Install it with: nvm install 20"
  exit 1
fi

echo "Using Node.js: $NODE_PATH"
echo "Script: $SCRIPT_DIR/local-fetcher.js"
echo "Logs: $LOG_DIR/"

# Create wrapper script that sets up the environment
WRAPPER="$SCRIPT_DIR/run-fetcher.sh"
cat > "$WRAPPER" << WRAPPER_EOF
#!/bin/bash
# Auto-generated wrapper for launchd
# Sets up nvm environment before running the fetcher

export HOME="$HOME"
export NVM_DIR="$NVM_DIR"
source "\$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1

cd "$PROJECT_DIR"
exec node scripts/local-fetcher.js
WRAPPER_EOF
chmod +x "$WRAPPER"

# Create the plist
cat > "$PLIST_PATH" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WRAPPER}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <!-- Run every 30 seconds (for testing). Change to 300 for 5 min, 600 for 10 min -->
  <key>StartInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/fetcher-stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/fetcher-stderr.log</string>

  <!-- Don't run if user is not logged in -->
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>

  <!-- Restart on crash -->
  <key>KeepAlive</key>
  <false/>

  <!-- Environment -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

echo ""
echo "Plist created at: $PLIST_PATH"

# Load the agent
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "Agent loaded. It will run every 30 seconds."
echo ""
echo "Useful commands:"
echo "  launchctl list | grep newsdigest    # Check if running"
echo "  tail -f $LOG_DIR/fetcher-stdout.log # Watch output"
echo "  tail -f $LOG_DIR/fetcher-stderr.log # Watch errors"
echo "  launchctl unload '$PLIST_PATH'      # Stop"
echo "  launchctl load '$PLIST_PATH'        # Start"
echo "  bash scripts/setup-cron.sh unload   # Remove completely"
echo ""
echo "IMPORTANT: Grant Accessibility permission to your terminal app"
echo "  System Preferences > Privacy & Security > Accessibility"
echo "  Add: Terminal.app (or iTerm.app)"
echo ""
echo "To change interval: edit StartInterval in"
echo "  $PLIST_PATH"
echo "then run: launchctl unload/load the plist"
