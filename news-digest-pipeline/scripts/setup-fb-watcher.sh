#!/bin/bash
# Setup launchd job for Facebook profile watcher
# Runs every 5 minutes, checks for new published digests and posts to FB profile

PLIST_NAME="com.newsdigest.fb-profile-watcher"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"

mkdir -p "$LOG_DIR"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>${SCRIPT_DIR}/fb-profile-watcher.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}/..</string>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/fb-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/fb-watcher-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$(dirname $(which node))</string>
    </dict>
</dict>
</plist>
EOF

# Load the job
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo "✅ Facebook profile watcher installed"
echo "   Runs every 5 minutes"
echo "   Logs: $LOG_DIR/fb-watcher.log"
echo ""
echo "   To stop:  launchctl unload $PLIST_PATH"
echo "   To start: launchctl load $PLIST_PATH"
echo "   To test:  node $SCRIPT_DIR/fb-profile-watcher.js --force"
