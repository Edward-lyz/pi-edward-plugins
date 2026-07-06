#!/usr/bin/env bash
# install.sh — install the pi-better-ux extensions and their runtime dependencies.
#
# Steps:
#   1. npm install       -> runtime deps, incl. the fff extension's
#                           @ff-labs/fff-node native module
#   2. ensure `rtk` CLI  -> used by the rtk extension (`rtk rewrite`, needs >= 0.23.0)
#   3. pi install <repo> -> register this package with pi
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

scope=""
while [ $# -gt 0 ]; do
  case "$1" in
    -l|--local) scope="-l" ;;
    -h|--help)
      echo "Usage: ./install.sh [-l|--local]"
      echo "  (default)   register with global pi settings (~/.pi/agent/settings.json)"
      echo "  -l|--local  register with project pi settings (.pi/settings.json)"
      exit 0 ;;
    *) echo "install.sh: unknown option '$1'" >&2; exit 2 ;;
  esac
  shift
done

command -v pi  >/dev/null 2>&1 || { echo "install.sh: 'pi' not found in PATH. Install pi first: https://pi.dev" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "install.sh: 'npm' not found in PATH. Install Node.js first." >&2; exit 1; }

echo "==> Installing npm dependencies (incl. @ff-labs/fff-node for the fff extension)..."
npm install

echo "==> Checking rtk CLI (used by the rtk extension)..."
rtk_ok() {
  command -v rtk >/dev/null 2>&1 || return 1
  local v major minor
  v="$(rtk --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$major" -gt 0 ] || [ "$minor" -ge 23 ]
}
if rtk_ok; then
  echo "    rtk $(rtk --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) present."
else
  echo "    Installing/upgrading rtk (need >= 0.23.0 for 'rtk rewrite')..."
  if command -v brew >/dev/null 2>&1; then
    if brew list rtk >/dev/null 2>&1; then brew upgrade rtk || brew install rtk; else brew install rtk; fi
  elif command -v cargo >/dev/null 2>&1; then
    cargo install rtk --force
  else
    echo "install.sh: cannot install rtk automatically (need 'brew' or 'cargo')." >&2
    echo "            install it manually then re-run: https://github.com/rtk-ai/rtk#installation" >&2
    exit 1
  fi
fi

echo "==> Registering the package with pi..."
pi install ${scope:+"$scope"} "$REPO_DIR"

echo "==> Done."
if [ -n "$scope" ]; then
  echo "    Registered in project settings (.pi/settings.json). Run 'pi list' to verify."
else
  echo "    Registered in global settings (~/.pi/agent/settings.json). Run 'pi list' to verify."
fi
