#!/bin/sh
# One-time setup. Everything private lives outside this public repository.
set -eu
umask 077
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
if ! command -v rclone >/dev/null 2>&1 && [ ! -x "$HOME_DIR/bin/rclone" ]; then
  "$PYTHON" "$HERE/install_rclone.py" --home "$HOME_DIR"
fi
"$VPY" "$HERE/configure.py" --home "$HOME_DIR" --venv "$HOME_DIR/venv"
printf '\nSetup complete. Test: %s/sync.sh --dry-run\n' "$HERE"
