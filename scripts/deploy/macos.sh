#!/usr/bin/env bash
# Codex Proxy — macOS deployment helper (source checkout + launchd).
#
# Runs this checkout as a per-user LaunchAgent: starts at login, restarts on
# crash, logs to ./logs/codex-proxy.log. Reuses what an existing desktop (DMG)
# install already has: its TLS native addon (so Rust is optional) and its
# account data (copied, never moved — the desktop app keeps working).
#
# Usage: scripts/deploy/macos.sh <command> [options]
#   install   Build, migrate data, install + start the LaunchAgent
#             (--switch: take over from a running desktop app once it is idle)
#   update    git pull --ff-only, rebuild, restart
#   start | stop | restart | status | logs | uninstall
#
# Written for the bash 3.2 that ships with macOS.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="${CODEX_PROXY_LAUNCHD_LABEL:-com.codex-proxy}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/codex-proxy.log"
DATA_DIR="$REPO_DIR/data"
DMG_DATA_DIR="${CODEX_PROXY_DESKTOP_DATA_DIR:-$HOME/Library/Application Support/@codex-proxy/electron/data}"
DMG_APPS="${CODEX_PROXY_DESKTOP_APPS:-/Applications/Codex Proxy.app:$HOME/Applications/Codex Proxy.app}"
GUI_DOMAIN="gui/$(id -u)"
HEALTH_TIMEOUT_S="${CODEX_PROXY_HEALTH_TIMEOUT:-90}"
IDLE_SECONDS="${CODEX_PROXY_IDLE_SECONDS:-5}"
IDLE_TIMEOUT_S="${CODEX_PROXY_IDLE_TIMEOUT:-0}"

OPT_LAN=0
OPT_YES=0
OPT_NO_MIGRATE=0
OPT_FORCE_MIGRATE=0
OPT_SWITCH=0
NODE_BIN=""
SWITCHED_FROM_DESKTOP=""

# ── output helpers ──────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

step() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

confirm() {
  # confirm "question" → 0 on yes. --yes auto-accepts; non-interactive declines.
  if [ "$OPT_YES" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  local reply
  printf '%s [y/N] ' "$1"
  read -r reply || return 1
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

usage() {
  cat <<EOF
Codex Proxy — macOS deployment (launchd)

Usage: scripts/deploy/macos.sh <command> [options]

Commands:
  install      Install deps, build, set up the TLS addon, migrate desktop-app
               data, then install and start the LaunchAgent ($LABEL)
  update       git pull --ff-only, rebuild, restart
  start        Load and start the LaunchAgent
  stop         Stop and unload the LaunchAgent (stays installed)
  restart      Restart the running service
  status       Show service state and health
  logs         Follow the service log
  uninstall    Stop and remove the LaunchAgent (keeps code and data/)

Options (install / update):
  --lan            Listen on 0.0.0.0 so other devices on the LAN can connect
  --no-migrate     Do not copy data from the desktop app
  --migrate-data   Re-copy desktop-app data even if ./data exists
                   (the current ./data is backed up first)
  --switch         (install) If the desktop app is running: build first, wait
                   until it has no in-flight requests, quit it, copy its latest
                   data, then start the service. Rolls back to the desktop app
                   if the new service fails its health check.
  -y, --yes        Answer yes to prompts (e.g. brew install node)

Environment:
  CODEX_PROXY_LAUNCHD_LABEL     LaunchAgent label (default: com.codex-proxy)
  CODEX_PROXY_NODE              Node binary to use (default: node on PATH)
  CODEX_PROXY_HEALTH_TIMEOUT    Seconds to wait for /health (default: 90)
  CODEX_PROXY_IDLE_SECONDS      --switch: idle time required before quitting
                                the desktop app (default: 5)
  CODEX_PROXY_IDLE_TIMEOUT      --switch: give up after this many seconds of
                                waiting for idle; 0 = wait indefinitely
  CODEX_PROXY_DESKTOP_APPS      Colon-separated desktop app paths to take the
                                TLS addon from (default: /Applications and
                                ~/Applications "Codex Proxy.app")
  CODEX_PROXY_DESKTOP_DATA_DIR  Desktop app data dir to migrate from
EOF
}

# ── preflight ───────────────────────────────────────────────────────────────

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "This script only supports macOS."
}

node_version_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}

ensure_node() {
  local candidate p
  candidate="${CODEX_PROXY_NODE:-$(command -v node || true)}"
  if [ -z "$candidate" ]; then
    # Non-login shells (e.g. ssh host cmd) often miss Homebrew's PATH.
    for p in /opt/homebrew/bin/node /usr/local/bin/node; do
      if [ -x "$p" ]; then candidate="$p"; PATH="$(dirname "$p"):$PATH"; break; fi
    done
  fi
  if [ -z "$candidate" ] || ! node_version_ok "$candidate"; then
    if [ -n "$candidate" ]; then
      warn "Found Node $("$candidate" -v) at $candidate, but 22.13+ is required."
    else
      warn "Node.js is not installed."
    fi
    if command -v brew >/dev/null 2>&1 && confirm "Install the latest Node.js with Homebrew now?"; then
      brew install node
      hash -r
      candidate="$(command -v node || true)"
    fi
    [ -n "$candidate" ] && node_version_ok "$candidate" \
      || die "Node.js 22.13+ is required. Install it (e.g. 'brew install node') and re-run."
  fi
  # Keep symlinked paths as-is (e.g. /opt/homebrew/opt/node@22/bin/node): resolving
  # them to a versioned Cellar path would break the LaunchAgent after brew upgrade.
  case "$candidate" in
    /*) NODE_BIN="$candidate" ;;
    *) NODE_BIN="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")" ;;
  esac
  case "$NODE_BIN" in
    */.nvm/*|*/.volta/*|*/.fnm/*|*/.asdf/*)
      warn "Node comes from a version manager ($NODE_BIN). The LaunchAgent pins this exact path;"
      warn "re-run 'install' after switching Node versions." ;;
  esac
  ok "Node $("$NODE_BIN" -v) ($NODE_BIN)"
  # Some builds (e.g. ones linked against a stale shared OpenSSL CA bundle) can't
  # verify public certificates; npm install and token refresh would then fail.
  if ! "$NODE_BIN" -e 'fetch("https://registry.npmjs.org/",{method:"HEAD",signal:AbortSignal.timeout(15000)}).then(()=>process.exit(0),(e)=>{console.error(e.cause&&e.cause.code||e.message);process.exit(1)})' 2>/tmp/codex-proxy-node-tls.$$; then
    warn "This Node failed an HTTPS request: $(cat /tmp/codex-proxy-node-tls.$$ 2>/dev/null)"
    warn "If that is a certificate error, use another Node build, e.g.:"
    warn "  brew install node@22 && CODEX_PROXY_NODE=/opt/homebrew/opt/node@22/bin/node $0 ..."
  fi
  rm -f /tmp/codex-proxy-node-tls.$$
}

desktop_app_pid() {
  pgrep -f "Codex Proxy.app/Contents/MacOS/Codex Proxy" 2>/dev/null | head -n 1 || true
}

# Bundle path of the running desktop app (one of $DMG_APPS), for rollback.
running_app_path() {
  local IFS=":" app command
  command="$(ps -o command= -p "$1" 2>/dev/null || true)"
  for app in $DMG_APPS; do
    case "$command" in *"$app/Contents/MacOS/"*) echo "$app"; return 0 ;; esac
  done
  for app in $DMG_APPS; do
    [ -d "$app" ] && { echo "$app"; return 0; }
  done
}

check_desktop_app_not_running() {
  if [ -n "$(desktop_app_pid)" ]; then
    die "The Codex Proxy desktop app is running. Quit it (and turn off its login item in
       System Settings → General → Login Items) so the two don't fight over port and data,
       or re-run with --switch to take over once it is idle."
  fi
}

# Merged server config (default.yaml + <data dir>/local.yaml + PORT env) as
# "host port set|unset". The data dir defaults to ./data.
read_server_config() {
  (cd "$REPO_DIR" && CP_LOCAL_YAML="${1:-data}/local.yaml" "$NODE_BIN" -e '
    const fs = require("fs");
    let host = "127.0.0.1", port = 8080, key = null;
    try {
      const yaml = require("js-yaml");
      for (const f of ["config/default.yaml", process.env.CP_LOCAL_YAML]) {
        if (!fs.existsSync(f)) continue;
        const s = (yaml.load(fs.readFileSync(f, "utf8")) || {}).server || {};
        if (s.host) host = s.host;
        if (s.port) port = s.port;
        if (s.proxy_api_key !== undefined) key = s.proxy_api_key;
      }
    } catch {}
    if (process.env.PORT) port = parseInt(process.env.PORT, 10) || port;
    process.stdout.write(`${host} ${port} ${key ? "set" : "unset"}`);
  ' 2>/dev/null) || echo "127.0.0.1 8080 unset"
}

service_pid() {
  launchctl print "$GUI_DOMAIN/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" {print $3; exit}'
}

check_port_free() {
  local port="$1" pids pid own_pid
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  own_pid="$(service_pid || true)"
  for pid in $pids; do
    # Our own running service is fine: install is re-runnable and restarts it.
    [ -n "$own_pid" ] && [ "$pid" = "$own_pid" ] && continue
    die "Port $port is already in use by: $(ps -o pid=,command= -p "$pid" 2>/dev/null | head -c 160)
       Stop that process or change server.port in data/local.yaml."
  done
}

# ── TLS native addon ────────────────────────────────────────────────────────

addon_ok() {
  (cd "$REPO_DIR" && "$NODE_BIN" scripts/native/smoke-addon.mjs >/dev/null 2>&1)
}

restore_tracked_loader() {
  # `napi build` regenerates the committed loader; keep the checkout clean so
  # later `git pull --ff-only` updates keep working.
  (cd "$REPO_DIR" && git checkout -- native/index.js native/index.d.ts 2>/dev/null) || true
}

copy_addon_from_desktop_app() {
  local IFS=":" app found=1 f
  for app in $DMG_APPS; do
    [ -d "$app/Contents/Resources" ] || continue
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      cp -f "$f" "$REPO_DIR/native/"
      found=0
    done <<EOF
$(find "$app/Contents/Resources" -name 'codex-tls.darwin-*.node' 2>/dev/null)
EOF
    if [ "$found" = 0 ]; then
      ok "Copied TLS addon from $app"
      return 0
    fi
  done
  return 1
}

build_addon_with_rust() {
  local cargo_bin
  cargo_bin="$(command -v cargo || true)"
  [ -z "$cargo_bin" ] && [ -x "$HOME/.cargo/bin/cargo" ] && cargo_bin="$HOME/.cargo/bin/cargo"
  [ -n "$cargo_bin" ] || return 1
  step "Building the TLS addon with Rust (a few minutes on first build)"
  (cd "$REPO_DIR/native" && PATH="$(dirname "$cargo_bin"):$PATH" npm install --no-audit --no-fund && PATH="$(dirname "$cargo_bin"):$PATH" npm run build)
  restore_tracked_loader
}

ensure_native_addon() {
  step "Checking the TLS native addon"
  if addon_ok; then ok "Addon present and loadable"; return 0; fi

  if copy_addon_from_desktop_app; then
    if addon_ok; then ok "Desktop-app addon works with this checkout"; return 0; fi
    warn "The desktop app's addon doesn't load with this version; removing it."
    rm -f "$REPO_DIR"/native/codex-tls.darwin-*.node
  fi

  if build_addon_with_rust && addon_ok; then ok "Built addon with Rust"; return 0; fi

  die "No usable TLS addon. Either:
       • install the desktop app (DMG) on this Mac and re-run, or
       • install Rust:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
         then re-run this script (it will build the addon)."
}

# ── build ───────────────────────────────────────────────────────────────────

build_app() {
  step "Installing dependencies"
  (cd "$REPO_DIR" && npm ci --no-audit --no-fund)
  (cd "$REPO_DIR/web" && npm ci --no-audit --no-fund)
  step "Building (web dashboard + server)"
  (cd "$REPO_DIR" && npm run build)
  ok "Build complete"
}

# ── data ────────────────────────────────────────────────────────────────────

migrate_data() {
  [ "$OPT_NO_MIGRATE" = 1 ] && { ok "Skipping data migration (--no-migrate)"; return 0; }
  step "Account data"
  if [ ! -d "$DMG_DATA_DIR" ]; then
    ok "No desktop-app data found; starting with an empty ./data"
    return 0
  fi
  if [ -d "$DATA_DIR" ] && [ "$OPT_FORCE_MIGRATE" != 1 ]; then
    ok "./data already exists; keeping it (use --migrate-data to re-copy from the desktop app)"
    return 0
  fi
  if [ -d "$DATA_DIR" ]; then
    local backup="$DATA_DIR.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$DATA_DIR" "$backup"
    ok "Backed up existing ./data to $(basename "$backup")"
  fi
  cp -Rp "$DMG_DATA_DIR" "$DATA_DIR"
  ok "Copied desktop-app data (accounts, keys, settings) into ./data"
  ok "The desktop app's own data is untouched"
}

configure_lan() {
  [ "$OPT_LAN" = 1 ] || return 0
  step "Enabling LAN access"
  local cfg
  cfg="$(read_server_config)"
  if [ "${cfg##* }" != "set" ]; then
    warn "No server.proxy_api_key is configured: anyone on your network could use"
    warn "the proxy and open the dashboard. Set an API key in the dashboard settings"
    warn "(or server.proxy_api_key in data/local.yaml) before exposing it."
    confirm "Enable LAN access anyway?" || die "Aborted. Re-run without --lan, or set an API key first."
  fi
  mkdir -p "$DATA_DIR"
  (cd "$REPO_DIR" && "$NODE_BIN" -e '
    const fs = require("fs"), yaml = require("js-yaml");
    const f = "data/local.yaml";
    const doc = fs.existsSync(f) ? (yaml.load(fs.readFileSync(f, "utf8")) || {}) : {};
    doc.server = { ...(doc.server || {}), host: "0.0.0.0" };
    fs.writeFileSync(f, yaml.dump(doc, { lineWidth: 120 }));
  ')
  ok "server.host = 0.0.0.0 (data/local.yaml)"
}

# ── switching over from the desktop app ─────────────────────────────────────

# In-flight account slots reported by a /health URL; empty if unreachable.
health_used_slots() {
  curl -fsS --max-time 3 "$1" 2>/dev/null | "$NODE_BIN" -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const n = JSON.parse(s).pool.used_slots; if (Number.isInteger(n)) process.stdout.write(String(n)); } catch {}
    });' 2>/dev/null || true
}

wait_for_desktop_idle() {
  local url="$1" start now idle_since="" used last_report=0
  step "Waiting for the desktop app to be idle (0 in-flight requests for ${IDLE_SECONDS}s)"
  start="$(date +%s)"
  while :; do
    used="$(health_used_slots "$url")"
    now="$(date +%s)"
    if [ "$used" = 0 ]; then
      [ -n "$idle_since" ] || idle_since="$now"
      if [ $((now - idle_since)) -ge "$IDLE_SECONDS" ]; then ok "Desktop app is idle"; return 0; fi
    else
      idle_since=""
    fi
    if [ $((now - last_report)) -ge 30 ]; then
      if [ -n "$used" ]; then echo "  … $used in-flight request(s), waiting ($(date '+%H:%M:%S'))"
      else echo "  … $url not answering, waiting ($(date '+%H:%M:%S'))"; fi
      last_report="$now"
    fi
    if [ "$IDLE_TIMEOUT_S" -gt 0 ] && [ $((now - start)) -ge "$IDLE_TIMEOUT_S" ]; then
      die "The desktop app was still busy after ${IDLE_TIMEOUT_S}s. Nothing was changed; re-run later."
    fi
    sleep 1
  done
}

# Quit the desktop app at an idle moment. SIGTERM is used on purpose: on macOS
# its Quit/AppleScript path only hides the window to the tray, while SIGTERM
# runs the app's graceful shutdown (server close, DB flush).
switch_from_desktop_app() {
  local pid cfg host port url app_path i=0
  pid="$(desktop_app_pid)"
  [ -n "$pid" ] || return 0
  app_path="$(running_app_path "$pid")"
  cfg="$(read_server_config "$DMG_DATA_DIR")"
  host="${cfg%% *}"; port="$(echo "$cfg" | awk '{print $2}')"
  case "$host" in 0.0.0.0|::|"") host="127.0.0.1" ;; esac
  url="http://$host:$port/health"
  wait_for_desktop_idle "$url"
  step "Quitting the desktop app (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    warn "Still running after 20s; forcing it to stop."
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
  fi
  i=0
  while lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  SWITCHED_FROM_DESKTOP="${app_path:-/Applications/Codex Proxy.app}"
  ok "Desktop app stopped; port $port is free"
}

# After a successful switch the desktop copy is stale: the service keeps
# rotating refresh tokens, so a desktop app reopened on the old copy (login
# item, a watchdog, an updater) would refresh with superseded tokens and can
# get the accounts revoked. Move it aside (kept, not deleted) so such a launch
# starts empty instead.
retire_desktop_data() {
  [ -d "$DMG_DATA_DIR" ] || return 0
  local dest="$DMG_DATA_DIR.migrated-$(date +%Y%m%d-%H%M%S)"
  mv "$DMG_DATA_DIR" "$dest"
  ok "Moved the desktop app's (now stale) data aside to $(basename "$dest")"
}

rollback_to_desktop_app() {
  [ -n "$SWITCHED_FROM_DESKTOP" ] || return 0
  warn "Rolling back: removing the LaunchAgent and reopening $SWITCHED_FROM_DESKTOP"
  unload_service
  rm -f "$PLIST"
  open -a "$SWITCHED_FROM_DESKTOP" 2>/dev/null || warn "Could not reopen it; start it manually."
}

# ── launchd ─────────────────────────────────────────────────────────────────

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

write_plist() {
  step "Writing LaunchAgent $PLIST"
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  local node_dir
  node_dir="$(dirname "$NODE_BIN")"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$node_dir"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null || die "Generated plist is invalid: $PLIST"
  ok "LaunchAgent written"
}

is_loaded() {
  launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1
}

unload_service() {
  if is_loaded; then
    launchctl bootout "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
    local i=0
    while is_loaded && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  fi
}

load_service() {
  [ -f "$PLIST" ] || die "LaunchAgent not installed. Run: scripts/deploy/macos.sh install"
  unload_service
  launchctl bootstrap "$GUI_DOMAIN" "$PLIST"
  launchctl enable "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
  launchctl kickstart -k "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || true
}

wait_healthy() {
  local cfg host port url i=0
  cfg="$(read_server_config)"
  host="${cfg%% *}"; port="$(echo "$cfg" | awk '{print $2}')"
  case "$host" in 0.0.0.0|::|"") host="127.0.0.1" ;; esac
  url="http://$host:$port/health"
  step "Waiting for $url"
  while [ $i -lt "$HEALTH_TIMEOUT_S" ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      ok "Service is healthy"
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  warn "No healthy response after ${HEALTH_TIMEOUT_S}s. Last log lines:"
  tail -n 30 "$LOG_FILE" 2>/dev/null >&2 || true
  return 1
}

print_summary() {
  local cfg host port lan_ip
  cfg="$(read_server_config)"
  host="${cfg%% *}"; port="$(echo "$cfg" | awk '{print $2}')"
  echo
  printf '%sCodex Proxy is running.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  echo "  Dashboard:  http://localhost:$port"
  if [ "$host" = "0.0.0.0" ] || [ "$host" = "::" ]; then
    lan_ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -n "$lan_ip" ] && echo "  LAN:        http://$lan_ip:$port"
  fi
  echo "  Logs:       $LOG_FILE"
  echo "  Manage:     scripts/deploy/macos.sh {status|restart|stop|logs|update|uninstall}"
}

# ── commands ────────────────────────────────────────────────────────────────

cmd_install() {
  require_macos
  step "Preflight"
  ensure_node
  [ "$OPT_SWITCH" = 1 ] || check_desktop_app_not_running
  ensure_native_addon
  build_app
  if [ "$OPT_SWITCH" = 1 ] && [ -n "$(desktop_app_pid)" ]; then
    switch_from_desktop_app
    # The desktop app kept running after any earlier copy, so its data is newer.
    [ "$OPT_NO_MIGRATE" = 1 ] || OPT_FORCE_MIGRATE=1
  fi
  migrate_data
  configure_lan
  local cfg port
  cfg="$(read_server_config)"; port="$(echo "$cfg" | awk '{print $2}')"
  check_port_free "$port"
  write_plist
  step "Starting service"
  load_service
  if ! wait_healthy; then
    rollback_to_desktop_app
    die "Service failed to become healthy. See $LOG_FILE"
  fi
  if [ -n "$SWITCHED_FROM_DESKTOP" ] && [ "$OPT_NO_MIGRATE" != 1 ]; then
    retire_desktop_data
    warn "Don't reopen the desktop app while this service runs, and disable anything that"
    warn "relaunches it (login item, watchdog, updater). To switch back, see scripts/deploy/README.md."
  fi
  print_summary
}

cmd_update() {
  require_macos
  ensure_node
  step "Pulling latest code"
  (cd "$REPO_DIR" && {
    if ! git diff --quiet || ! git diff --cached --quiet; then
      die "The checkout has local changes; commit or stash them first."
    fi
    git pull --ff-only
  })
  ensure_native_addon
  build_app
  configure_lan
  # Re-write the plist in case the Node path changed.
  write_plist
  step "Restarting service"
  load_service
  wait_healthy || die "Service failed to become healthy after update. See $LOG_FILE"
  print_summary
}

cmd_start() {
  load_service
  wait_healthy || die "Service failed to become healthy. See $LOG_FILE"
}

cmd_stop() {
  unload_service
  ok "Stopped ($LABEL). It will start again at next login unless you run 'uninstall'."
}

cmd_restart() {
  if is_loaded; then
    launchctl kickstart -k "$GUI_DOMAIN/$LABEL"
  else
    load_service
  fi
  wait_healthy || die "Service failed to become healthy. See $LOG_FILE"
}

cmd_status() {
  if [ ! -f "$PLIST" ]; then echo "Not installed ($PLIST missing)."; return 1; fi
  if is_loaded; then
    launchctl print "$GUI_DOMAIN/$LABEL" | grep -E '^[[:space:]]*(state|pid|last exit code|runs) =' || true
  else
    echo "Installed but not loaded. Start with: scripts/deploy/macos.sh start"
    return 1
  fi
  local cfg port
  NODE_BIN="$(command -v node || echo node)"
  cfg="$(read_server_config)"; port="$(echo "$cfg" | awk '{print $2}')"
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" 2>/dev/null; then
    echo
  else
    echo "Health check on port $port failed."
    return 1
  fi
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || die "No log yet at $LOG_FILE"
  tail -n 100 -f "$LOG_FILE"
}

cmd_uninstall() {
  unload_service
  rm -f "$PLIST"
  ok "Removed LaunchAgent $LABEL. Code and ./data were left in place."
}

# ── main ────────────────────────────────────────────────────────────────────

main() {
  local cmd="${1:-}"
  [ $# -gt 0 ] && shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --lan) OPT_LAN=1 ;;
      --no-migrate) OPT_NO_MIGRATE=1 ;;
      --migrate-data) OPT_FORCE_MIGRATE=1 ;;
      --switch) OPT_SWITCH=1 ;;
      -y|--yes) OPT_YES=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  if [ "$OPT_NO_MIGRATE" = 1 ] && [ "$OPT_FORCE_MIGRATE" = 1 ]; then
    die "--no-migrate and --migrate-data cannot be combined"
  fi

  # Commands that read config need a Node binary even when not (re)installing.
  case "$cmd" in
    start|restart) NODE_BIN="$(command -v node || echo node)" ;;
  esac

  case "$cmd" in
    install) cmd_install ;;
    update) cmd_update ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    uninstall) cmd_uninstall ;;
    ""|-h|--help|help) usage ;;
    *) die "Unknown command: $cmd (see --help)" ;;
  esac
}

main "$@"
