#!/bin/sh
# One-time setup. Everything private lives outside this public repository.
set -eu
umask 077
DEPS_ONLY=0
TRANSPORT=rclone
for arg in "$@"; do
  case "$arg" in
    --deps-only) DEPS_ONLY=1 ;;
    --manual) TRANSPORT=manual ;;
    -h|--help) printf 'usage: setup.sh [--deps-only] [--manual]\n  --deps-only: install tools only, skip the interactive configuration\n  --manual: browser upload transport, no rclone remote and no OAuth\n'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOME_DIR=${NASR_WA_HOME:-"$HOME/nasr-wa-sync"}
mkdir -p "$HOME_DIR"
chmod 700 "$HOME_DIR"
PYTHON=${PYTHON:-python3}
"$PYTHON" - <<'PY'
import sys
if sys.version_info[:2] != (3, 11):
    raise SystemExit('Python 3.11 required (antiX 23 normally provides it). Run python3 --version and send only the version.')
PY
if [ ! -x "$HOME_DIR/venv/bin/python" ]; then
  "$PYTHON" -m venv "$HOME_DIR/venv"
fi
VPY="$HOME_DIR/venv/bin/python"
"$VPY" -m pip install --disable-pip-version-check --require-hashes -r "$HERE/requirements-build.txt"
"$VPY" -m pip install --disable-pip-version-check --require-hashes --no-deps --no-build-isolation -r "$HERE/requirements.txt"
# A distro rclone (Debian 12 ships 1.60.1-DEV) is not the reviewed build; install the
# hash-pinned one locally and only fall back to the system binary if that is impossible.
if [ "$TRANSPORT" = rclone ]; then
  if [ ! -x "$HOME_DIR/bin/rclone" ]; then
    if ! "$PYTHON" "$HERE/install_rclone.py" --home "$HOME_DIR"; then
      printf 'WARN: could not install the pinned rclone; falling back to the system rclone if present\n' >&2
    fi
  fi
  if [ ! -x "$HOME_DIR/bin/rclone" ] && ! command -v rclone >/dev/null 2>&1; then
    printf 'rclone is unavailable; re-run setup.sh with working network access\n' >&2
    exit 1
  fi
fi
if [ "$DEPS_ONLY" = 1 ]; then
  "$PYTHON" "$HERE/doctor.py" --home "$HOME_DIR" || true
  printf '\nTools installed. Configuration is still pending. Next: %s/doctor.py then setup.sh\n' "$HERE"
  exit 0
fi
"$VPY" "$HERE/configure.py" --home "$HOME_DIR" --venv "$HOME_DIR/venv" --transport "$TRANSPORT"
"$PYTHON" "$HERE/doctor.py" --home "$HOME_DIR" || true
printf '\nSetup complete. Test: %s/sync.sh --dry-run\n' "$HERE"
