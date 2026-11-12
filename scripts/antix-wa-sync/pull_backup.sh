#!/bin/sh
# Copy the current WhatsApp Business crypt15 backup from the phone into the private inbox.
# Read-only towards the phone: `adb pull`, an explicit --source file, or a mounted MTP/USB path.
# The copy is byte-verified before it replaces the inbox file; nothing is uploaded here.
set -eu
umask 077
HOME_DIR=${NASR_WA_HOME:-"$HOME/nasr-wa-sync"}
SRC_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SRC_ARG=${2:-}; shift 2 ;;
    --home) HOME_DIR=${2:-}; shift 2 ;;
    -h|--help) printf 'usage: pull_backup.sh [--source FILE] [--home DIR]\n'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
DEST="$HOME_DIR/inbox"
mkdir -p "$DEST"
chmod 700 "$HOME_DIR" "$DEST"
REL='Android/media/com.whatsapp.w4b/WhatsApp Business/Databases/msgstore.db.crypt15'
TMP="$DEST/.msgstore.copy"
VIA=""
hash_of() { sha256sum "$1" | awk '{print $1}'; }

if [ -n "$SRC_ARG" ]; then
  [ -f "$SRC_ARG" ] || { echo SOURCE_NOT_FOUND; exit 1; }
  cp "$SRC_ARG" "$TMP"
  cmp -s "$SRC_ARG" "$TMP" || { rm -f "$TMP"; echo COPY_MISMATCH; exit 1; }
  VIA="$SRC_ARG"
elif command -v adb >/dev/null 2>&1; then
  adb start-server >/dev/null 2>&1 || true
  adb devices || true
  if adb devices | grep -qw device; then
    if adb pull "/sdcard/$REL" "$TMP"; then
      # adb shell re-splits its arguments on the device, so the remote path
      # (which contains "WhatsApp Business") must be quoted for the device shell.
      RH=$(adb shell "sha256sum '/sdcard/$REL'" | tr -d '\r' | awk '{print $1}')
      LH=$(hash_of "$TMP")
      [ "${#RH}" -eq 64 ] || { echo REMOTE_HASH_UNAVAILABLE; exit 1; }
      [ "$RH" = "$LH" ] || { rm -f "$TMP"; echo COPY_MISMATCH; exit 1; }
      VIA=adb
    fi
  fi
fi

if [ -z "$VIA" ]; then
  MOUNT="$HOME/phone"
  if command -v jmtpfs >/dev/null 2>&1; then
    mkdir -p "$MOUNT"
    mountpoint -q "$MOUNT" || jmtpfs "$MOUNT" || true
  fi
  FOUND=$(find "$MOUNT" /media /mnt "/run/user/$(id -u)/gvfs" -maxdepth 12 -type f -name 'msgstore.db.crypt15' 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    cp "$FOUND" "$TMP"
    cmp -s "$FOUND" "$TMP" || { rm -f "$TMP"; echo COPY_MISMATCH; exit 1; }
    VIA="$FOUND"
  fi
fi

[ -n "$VIA" ] || { echo NO_PHONE_FILE_FOUND; exit 1; }
[ -s "$TMP" ] || { rm -f "$TMP"; echo EMPTY_COPY; exit 1; }
chmod 600 "$TMP"
mv -f "$TMP" "$DEST/msgstore.db.crypt15"
printf 'نُقل عبر: %s\n' "$VIA"
ls -l "$DEST/msgstore.db.crypt15"
hash_of "$DEST/msgstore.db.crypt15"
echo PULL_BACKUP_OK
