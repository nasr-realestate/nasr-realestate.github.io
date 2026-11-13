#!/bin/sh
# The repeatable command. --dry-run / --prepare-only never upload.
set -eu
umask 077
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOME_DIR=${NASR_WA_HOME:-"$HOME/nasr-wa-sync"}
exec "$HOME_DIR/venv/bin/python" "$HERE/wa_sync.py" --config "$HOME_DIR/config.json" "$@"
