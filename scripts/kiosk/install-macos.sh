#!/usr/bin/env bash
# Turn this Mac into a Stage Utility display.
#
#   curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh
#
# Best-effort, and honestly so: a Mac is a general-purpose machine that sleeps,
# locks and reboots for updates on its own schedule. For a permanent wall screen
# a purpose-built Pi is the right tool. This is for a laptop on a cart, or a Mac
# already sitting at FOH.
#
# What it needs from you, once, in System Settings:
#   • Users & Groups → automatic login for this account
#   • Lock Screen → never for display sleep and screen saver (this sets what it
#     can via pmset, but the screen saver is per-user and not scriptable)

set -eu

STATE_DIR="/Library/Application Support/StageUtility"
BIN=/usr/local/bin/stage-utility-kiosk
AGENT_DIR="/Library/LaunchAgents"
AGENT="$AGENT_DIR/com.stageutility.kiosk.plist"
PORT="${STAGE_KIOSK_PORT:-8789}"
SERVER="${STAGE_SERVER:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo — the device id lives outside your home directory so a" >&2
  echo "profile reset cannot cost you a claim." >&2
  exit 1
fi

echo "==> Installing the Stage Utility kiosk agent"

mkdir -p "$STATE_DIR"
# Generated ONCE: re-running must never mint a new id, or this screen's binding
# is orphaned and needs re-claiming.
[ -f "$STATE_DIR/device-id" ] || uuidgen | tr 'A-Z' 'a-z' > "$STATE_DIR/device-id"
# The device's own secret — pinned by the server the first time it is claimed.
[ -f "$STATE_DIR/token" ] || head -c 24 /dev/urandom | xxd -p | tr -d '\n' > "$STATE_DIR/token"
[ -n "$SERVER" ] && printf '%s' "$SERVER" > "$STATE_DIR/server" || true
chmod 644 "$STATE_DIR/device-id"
chmod 600 "$STATE_DIR/token"
echo "    device id: $(cat "$STATE_DIR/device-id")"

# ── The launcher ────────────────────────────────────────────────────────────
cat > "$BIN" <<LAUNCHER
#!/usr/bin/env bash
set -u
STATE_DIR="$STATE_DIR"
PORT=$PORT

ID="\$(cat "\$STATE_DIR/device-id")"
TOKEN="\$(cat "\$STATE_DIR/token" 2>/dev/null || true)"
BOUND_FILE="\$STATE_DIR/bound-to"

macs() {
  ifconfig 2>/dev/null | awk '/ether /{printf "\\"%s\\",", \$2}' | sed 's/,\$//'
}

# nc, not socat: it ships with macOS, so this adds no dependency. -w2 gives the
# server two seconds to answer before we try again.
discover() {
  bound="\$(cat "\$BOUND_FILE" 2>/dev/null || true)"
  probe="{\"stageUtility\":\"discover\",\"v\":1,\"id\":\"\$ID\",\"macs\":[\$(macs)],\"hostname\":\"\$(hostname -s)\",\"os\":\"macOS\""
  [ -n "\$bound" ] && probe="\$probe,\"boundTo\":\"\$bound\""
  probe="\$probe}"
  printf '%s' "\$probe" | nc -u -w2 -b 255.255.255.255 \$PORT 2>/dev/null | head -c 2048
}

if [ -r "\$STATE_DIR/server" ]; then
  URL="\$(cat "\$STATE_DIR/server")"
else
  URL=""; fails=0
  while [ -z "\$URL" ]; do
    reply="\$(discover)"
    URL="\$(printf '%s' "\$reply" | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p')"
    SRV="\$(printf '%s' "\$reply" | sed -n 's/.*"serverId":"\\([^"]*\\)".*/\\1/p')"
    [ -n "\$SRV" ] && printf '%s' "\$SRV" > "\$BOUND_FILE"
    if [ -z "\$URL" ]; then
      fails=\$((fails + 1))
      [ "\$fails" -lt 10 ] && sleep 2 || sleep 30
    fi
  done
fi

TARGET="\$URL/enroll?device=\$ID"
[ -n "\$TOKEN" ] && TARGET="\$TARGET&token=\$TOKEN"

# Chrome if it is here, Safari if not. Chrome has a real kiosk mode; Safari is
# opened fullscreen and is the fallback rather than the choice.
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
    --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
    --user-data-dir="\$STATE_DIR/chrome" "\$TARGET"
else
  exec open -a Safari "\$TARGET"
fi
LAUNCHER
chmod +x "$BIN"

# ── Survive a reboot, and a browser that dies ──────────────────────────────
# A LaunchAgent, not a Daemon: this needs a logged-in GUI session to put a window
# on a screen, which is also why automatic login is a prerequisite.
mkdir -p "$AGENT_DIR"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.stageutility.kiosk</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <!-- The browser exiting is the cue to re-discover, which is how a screen
       recovers when the server's address changed. -->
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
chmod 644 "$AGENT"

# Display sleep is the difference between a display and a black rectangle. The
# screen saver is per-user and not scriptable — see the note at the top.
pmset -a displaysleep 0 sleep 0 2>/dev/null || true

echo
echo "==> Done. This screen is device $(cat "$STATE_DIR/device-id")"
echo "    It starts at the next login. Open Kiosks in Stage Utility, press"
echo "    Scan for devices, and assign it an output."
echo
echo "    Still to do by hand, once: enable automatic login, and set the screen"
echo "    saver to Never. Neither can be set from a script."
