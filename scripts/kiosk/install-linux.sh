#!/usr/bin/env bash
# Turn this machine into a Stage Utility display.
#
#   curl -fsSL http://<server>/kiosk/install-linux.sh | sudo sh
#
# What it sets up:
#   • a device id, generated once and kept OUTSIDE any browser profile, so
#     clearing browser data or resetting a user cannot cost you a claim
#   • a launcher that finds the server by UDP broadcast and opens a browser at
#     the one URL that never changes
#   • a systemd service so it survives a reboot, and relaunches if the browser
#     dies
#
# Nothing here knows which display this is. The server decides that, once, when
# somebody sets it up on the Screens page.

set -eu

STATE_DIR=/var/lib/stage-utility-display
BIN=/usr/local/bin/stage-utility-kiosk
UNIT=/etc/systemd/system/stage-utility-kiosk.service
PORT="${STAGE_KIOSK_PORT:-8789}"
# Optional: skip discovery entirely, for a network where broadcast does not cross
# a VLAN.  sudo STAGE_SERVER=http://192.168.16.61 sh install-linux.sh
SERVER="${STAGE_SERVER:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo — the device id and the service both live outside your home directory." >&2
  exit 1
fi

echo "==> Installing the Stage Utility kiosk agent"

# ── Identity ────────────────────────────────────────────────────────────────
# Generated ONCE. Re-running the installer must never mint a new id, or an
# upgrade would silently orphan this screen's binding and need re-claiming.
mkdir -p "$STATE_DIR"
if [ ! -f "$STATE_DIR/device-id" ]; then
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid > "$STATE_DIR/device-id"
  else
    od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$STATE_DIR/device-id"
  fi
  echo "    new device id: $(cat "$STATE_DIR/device-id")"
else
  echo "    keeping existing device id: $(cat "$STATE_DIR/device-id")"
fi
# The device's own secret. Generated here, presented on every enrolment, and
# pinned by the server the first time this screen is claimed. It is the device's
# to keep: there is no channel from a claim — which happens in somebody else's
# browser — back to a shell script on a wall.
if [ ! -f "$STATE_DIR/token" ]; then
  od -An -tx1 -N24 /dev/urandom | tr -d ' \n' > "$STATE_DIR/token"
fi
[ -n "$SERVER" ] && echo "$SERVER" > "$STATE_DIR/server" || true
chmod 644 "$STATE_DIR/device-id"
# Readable only by root and the kiosk user: it is the one thing standing between
# this screen and anything else on the network.
chmod 600 "$STATE_DIR/token"

# ── Dependencies ────────────────────────────────────────────────────────────
# A browser, and socat for the discovery exchange. Both are in every Debian and
# Raspberry Pi OS repo; nothing is fetched from anywhere else.
if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  echo "==> Installing chromium"
  apt-get update -qq && apt-get install -y -qq chromium-browser || apt-get install -y -qq chromium
fi
command -v socat >/dev/null 2>&1 || { echo "==> Installing socat"; apt-get install -y -qq socat; }
command -v unclutter >/dev/null 2>&1 || apt-get install -y -qq unclutter || true

# ── The launcher ────────────────────────────────────────────────────────────
cat > "$BIN" <<LAUNCHER
#!/usr/bin/env bash
# Find the server, show the display, and never give up.
set -u
STATE_DIR=$STATE_DIR
PORT=$PORT

ID="\$(cat "\$STATE_DIR/device-id")"
BOUND_FILE="\$STATE_DIR/bound-to"
TOKEN_FILE="\$STATE_DIR/token"
# The last server that answered. A screen with no server on the network - taken
# offsite, or booting first - launches at this rather than never launching at all.
LAST_SERVER_FILE="\$STATE_DIR/last-server"

macs() {
  for f in /sys/class/net/*/address; do
    a="\$(cat "\$f" 2>/dev/null)"
    [ "\$a" = "00:00:00:00:00:00" ] || printf '"%s",' "\$a"
  done | sed 's/,\$//'
}

# The mode this machine is actually DRIVING, straight from DRM — not what the
# browser thinks. The browser reports CSS pixels, which is the right number for
# laying out a view and the wrong one for "what is this TV doing": it cannot see
# a panel overscanning or negotiating an odd EDID mode. First connected output
# wins; a kiosk drives one screen.
mode() {
  for card in /sys/class/drm/card*-*; do
    [ -r "\$card/status" ] || continue
    [ "\$(cat "\$card/status")" = "connected" ] || continue
    m="\$(head -1 "\$card/modes" 2>/dev/null)"
    [ -n "\$m" ] && { printf '%s' "\$m"; return; }
  done
}

# One probe, and whatever answers within two seconds. The server replies unicast,
# so this hears its own answer without needing anything open on this machine.
discover() {
  bound="\$(cat "\$BOUND_FILE" 2>/dev/null || true)"
  unreachable=\$1
  probe="{\"stageUtility\":\"discover\",\"v\":1,\"id\":\"\$ID\",\"macs\":[\$(macs)],\"hostname\":\"\$(hostname)\",\"os\":\"Linux\""
  m="\$(mode)"
  [ -n "\$m" ] && probe="\$probe,\"mode\":\"\$m\""
  [ -n "\$bound" ] && probe="\$probe,\"boundTo\":\"\$bound\""
  [ "\$unreachable" = "1" ] && probe="\$probe,\"unreachable\":true"
  probe="\$probe}"
  printf '%s' "\$probe" | socat -T2 - UDP-DATAGRAM:255.255.255.255:\$PORT,broadcast,bind=:0 2>/dev/null | head -c 2048
}

# A server= file skips discovery, for networks where broadcast does not cross.
if [ -r "\$STATE_DIR/server" ]; then
  URL="\$(cat "\$STATE_DIR/server")"
else
  URL=""
  fails=0
  while [ -z "\$URL" ]; do
    # Say we cannot reach our server only after a real effort, so a slow boot is
    # not reported as a fault — and so another server does not offer to steal a
    # screen the moment ours is briefly quiet.
    [ "\$fails" -gt 30 ] && flag=1 || flag=0
    reply="\$(discover \$flag)"
    URL="\$(printf '%s' "\$reply" | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p')"
    SRV="\$(printf '%s' "\$reply" | sed -n 's/.*"serverId":"\\([^"]*\\)".*/\\1/p')"
    [ -n "\$SRV" ] && printf '%s' "\$SRV" > "\$BOUND_FILE.candidate"
    if [ -z "\$URL" ]; then
      fails=\$((fails + 1))
      # After a real effort, fall back to the server we found last time.
      #
      # This loop used to run forever, which meant a Pi taken offsite - or one
      # booting before the server does - never launched a browser AT ALL. No
      # amount of cached content helps a screen that never loads the page, and
      # signage is specifically meant to keep playing without a server.
      #
      # Discovery is still tried first and keeps being tried on the next launch
      # (the browser exiting re-runs this), so a server that moved is still
      # found; this only decides what to do while nothing answers.
      if [ "\$fails" -ge 15 ] && [ -r "\$LAST_SERVER_FILE" ]; then
        URL="\$(cat "\$LAST_SERVER_FILE" 2>/dev/null || true)"
        [ -n "\$URL" ] && echo "no server answered; using the last known one: \$URL"
      fi
    fi
    if [ -z "\$URL" ]; then
      # Two seconds while it might be booting, backing off to thirty so a screen
      # left on overnight is not shouting all night.
      [ "\$fails" -lt 10 ] && sleep 2 || sleep 30
    fi
  done
fi

# Remember it, so the next boot has somewhere to go if nothing answers.
[ -n "\$URL" ] && printf '%s' "\$URL" > "\$LAST_SERVER_FILE" 2>/dev/null || true

TOKEN="\$(cat "\$TOKEN_FILE" 2>/dev/null || true)"
TARGET="\$URL/enroll?device=\$ID"
[ -n "\$TOKEN" ] && TARGET="\$TARGET&token=\$TOKEN"

CHROME=chromium-browser
command -v \$CHROME >/dev/null 2>&1 || CHROME=chromium

# --noerrdialogs and the restore-flag scrub together stop the "Restore pages?"
# bar after a power cut, which otherwise sits over the display until somebody
# walks to the wall and dismisses it.
PROFILE=\$STATE_DIR/chrome
mkdir -p "\$PROFILE/Default"
sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' \\
  "\$PROFILE/Default/Preferences" 2>/dev/null || true

# --unsafely-treat-insecure-origin-as-secure is what lets the signage service
# worker register. A service worker needs a secure context and this app is served
# over plain HTTP on a LAN, so without this a screen that REBOOTS with no server
# is dead however much it had cached. Scoped to this one origin, in this one
# browser profile, and it needs no certificate.
exec \$CHROME \\
  --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
  --disable-features=TranslateUI --check-for-update-interval=31536000 \\
  --unsafely-treat-insecure-origin-as-secure="\$URL" \\
  --allow-insecure-localhost \\
  --user-data-dir="\$PROFILE" \\
  "\$TARGET"
LAUNCHER
chmod +x "$BIN"

# ── Survive a reboot, and a browser that dies ──────────────────────────────
cat > "$UNIT" <<UNITFILE
[Unit]
Description=Stage Utility kiosk display
After=graphical.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SUDO_USER:-pi}
Environment=DISPLAY=:0
ExecStart=$BIN
# The browser exiting is not a failure to give up on — it is the cue to
# re-discover, which is how a screen recovers when the server's address changed.
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
UNITFILE

# Screen blanking is the difference between a display and a black rectangle.
if command -v xset >/dev/null 2>&1; then
  cat > /etc/xdg/autostart/stage-utility-noblank.desktop <<'BLANK'
[Desktop Entry]
Type=Application
Name=Stage Utility — no screen blanking
Exec=sh -c "xset s off; xset -dpms; xset s noblank"
BLANK
fi

systemctl daemon-reload
systemctl enable --now stage-utility-kiosk.service

echo
echo "==> Done. This screen is device $(cat "$STATE_DIR/device-id")"
echo "    Open Screens in Stage Utility and set it up under \"Not set up yet\"."
