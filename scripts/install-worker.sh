#!/bin/sh
# Canopy worker installer. Served by the web BFF with its own origin below.
set -eu
umask 077
set +x

fail() { printf '%s\n' "Canopy: $*" >&2; exit 1; }
gateway='' token='' name='' release_url='' checksum_url=''
origin='CANOPY_INSTALL_ORIGIN_DEFAULT'
service=yes force=no channel_fallback=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gateway|--token|--name|--origin|--release-url|--checksum-url)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing option value"
      case "$1" in
        --gateway) gateway=$2 ;; --token) token=$2 ;; --name) name=$2 ;;
        --origin) origin=$2 ;; --release-url) release_url=$2 ;; --checksum-url) checksum_url=$2 ;;
      esac
      shift 2 ;;
    --no-service) service=no; shift ;; --force) force=yes; shift ;;
    --channel-fallback) channel_fallback=yes; shift ;;
    *) fail "Usage: --gateway URL --token TOKEN [--name NAME] [--no-service] [--force]" ;;
  esac
done
[ -n "$gateway" ] && [ -n "$token" ] || fail "--gateway and --token are required"
case "$origin" in http://*|https://*) ;; *) fail "Download this script from your Canopy web origin or supply --origin URL" ;; esac
command -v curl >/dev/null 2>&1 || fail "Install curl first"
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail "Supported systems: Linux x64/arm64 and macOS arm64" ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail "Unsupported CPU architecture" ;; esac
[ "$os/$arch" != darwin/x64 ] || fail "macOS requires Apple Silicon (arm64)"
config="$HOME/.config/canopy/worker.json"
bin_dir="$HOME/.local/share/canopy/bin"
binary="$bin_dir/canopy-worker"
reuse=no
if [ "$force" != yes ]; then
  [ ! -L "$config" ] || fail "Config is a symlink; use --force with a fresh token to replace it"
  if [ -e "$config" ]; then
    [ -f "$config" ] && [ -r "$config" ] && [ -s "$config" ] || fail "Existing config is not a readable nonempty file; use --force with a fresh token"
    reuse=yes
    printf '%s\n' 'Existing config preserved, including its gateway. Reinstalling binary/service only; use --force with a fresh token to enroll again.'
  fi
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/canopy-install.XXXXXXXX")
next=''
trap 'rm -rf "$tmp"; [ -z "$next" ] || rm -f "$next"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
asset="canopy-worker-$os-$arch"
printf '%s\n' "Downloading Canopy worker ($os/$arch)…"
if [ -n "$release_url" ]; then
  case "$release_url" in https://github.com/itsoltech/canopy/releases/download/*/"$asset") ;; *) fail "Invalid GitHub release URL" ;; esac
  [ "$checksum_url" = "${release_url%/*}/checksums.txt" ] || fail "Checksum URL must belong to the same GitHub release as the binary"
  curl -fsSL --connect-timeout 15 --max-time 300 "$release_url" -o "$tmp/worker" || fail "Release download failed"
  curl -fsSL --connect-timeout 15 --max-time 60 "$checksum_url" -o "$tmp/checksums" || fail "Checksum download failed"
  expected=$(awk -v file="$asset" '$2 == file || $2 == "*" file { print $1 }' "$tmp/checksums")
else
  base="${origin%/}/install/worker/$os/$arch"
  if curl -fsSL --connect-timeout 15 --max-time 300 "$base" -o "$tmp/worker"; then
    curl -fsSL --connect-timeout 15 --max-time 60 "$base?sha256=1" -o "$tmp/hash" || fail "Mirror checksum unavailable"
    expected=$(cat "$tmp/hash")
  else
    [ "$channel_fallback" = yes ] || fail "No mirrored binary for this gateway version. Use the GitHub release fallback shown in Settings → Workers"
    curl -fsSL --connect-timeout 15 --max-time 60 "$base?release=1" -o "$tmp/release" || fail "No GitHub release available for the gateway channel"
    release_url=$(sed -n '1p' "$tmp/release")
    expected=$(sed -n '2p' "$tmp/release")
    release_version=$(sed -n '3p' "$tmp/release")
    case "$release_url" in https://github.com/itsoltech/canopy/releases/download/*/"$asset") ;; *) fail "Invalid GitHub release URL" ;; esac
    printf '%s\n' "Mirror unavailable. Using GitHub channel release $release_version; gateway compatibility may require an update."
    curl -fsSL --connect-timeout 15 --max-time 300 "$release_url" -o "$tmp/worker" || fail "Release download failed"
  fi
fi
[ "${#expected}" -eq 64 ] || fail "Invalid SHA-256 checksum"
case "$expected" in *[!a-fA-F0-9]*) fail "Invalid SHA-256 checksum" ;; esac
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/worker" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp/worker" | awk '{print $1}')
else fail "Install sha256sum or shasum first"; fi
[ "$actual" = "$expected" ] || fail "SHA-256 mismatch; nothing installed"
mkdir -p "$bin_dir" "$(dirname "$config")"
chmod 700 "$(dirname "$config")"
# Rename within the destination filesystem; leave a running binary intact until verified.
next=$(mktemp "$bin_dir/.canopy-worker.XXXXXXXX")
install -m 0755 "$tmp/worker" "$next"
mv -f "$next" "$binary"
next=''
if [ "$reuse" = no ]; then
  set -- enroll --gateway "$gateway" --token "$token" --config "$config"
  [ "$force" != yes ] || set -- "$@" --force
  # Name is attached to the invitation by the gateway, never passed as executable syntax.
  "$binary" "$@" >"$tmp/enroll" 2>&1 || fail "Enrollment failed. Check the gateway address and generate a fresh token"
  printf '%s\n' "Worker enrolled${name:+: $name}."
fi
token=; set --
chmod 600 "$config"
# Preserve caller PATH and include common user-managed CLI locations in the service.
PATH="$bin_dir:$HOME/.local/bin:$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/node/current/bin:$HOME/.npm-global/bin:$HOME/.npm/bin:$HOME/.bun/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
for location in "$HOME"/.local/share/mise/installs/node/*/bin "$HOME"/.nvm/versions/node/*/bin; do
  [ ! -d "$location" ] || PATH="$location:$PATH"
done
if command -v npm >/dev/null 2>&1; then
  prefix=$(npm prefix -g 2>/dev/null || true)
  [ ! -d "$prefix/bin" ] || PATH="$prefix/bin:$PATH"
fi
export PATH
if [ "$service" = yes ]; then
  "$binary" service --config "$config" >"$tmp/service"
  if [ "$os" = linux ]; then
    if [ -d "/run/user/$(id -u)" ]; then
      XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
      DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
      export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
    fi
    command -v systemctl >/dev/null 2>&1 || fail "systemd user services unavailable. Re-run with --no-service"
    mkdir -p "$HOME/.config/systemd/user"
    sed -n '/^\[Unit\]/,$p' "$tmp/service" >"$HOME/.config/systemd/user/canopy-worker.service"
    systemctl --user daemon-reload || fail "User systemd session unavailable; start a user session or use --no-service"
    systemctl --user enable canopy-worker.service
    systemctl --user restart canopy-worker.service
    systemctl --user --no-pager status canopy-worker.service || true
    if command -v loginctl >/dev/null 2>&1; then
      linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)
      [ "$linger" = yes ] || printf '%s\n' "To keep running after logout, ask your administrator to run: loginctl enable-linger $(id -un)"
    fi
  else
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/share/canopy"
    plist="$HOME/Library/LaunchAgents/com.canopy.worker.plist"
    sed -n '/^<?xml/,$p' "$tmp/service" >"$plist"
    launchctl bootout "gui/$(id -u)/com.canopy.worker" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" || fail "LaunchAgent needs a logged-in macOS user session"
    launchctl kickstart "gui/$(id -u)/com.canopy.worker"
    printf '%s\n' "Canopy LaunchAgent started."
  fi
else
  printf '%s\n' "Service skipped. Start: $binary --config $config"
fi
for cli in claude codex grok; do
  if command -v "$cli" >/dev/null 2>&1; then printf '%s\n' "$cli: found ($(command -v "$cli"))"
  else printf '%s\n' "$cli: not installed; install the agent CLI separately"; fi
done
printf '%s\n' 'Sign in on this machine: claude auth login; codex login; grok (follow its sign-in prompt).' 'Check Settings → Workers for the live connection and provider setup.'
