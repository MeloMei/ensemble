#!/bin/sh
# Whole-directory rename and rollback adapted from AgentRecall V1 apply-update.cjs
# at e130f72a1a34a87e4065d9f85f7733bdf632f1b6. Copyright (c) 2026
# AgentRecall contributors; MIT, see licenses/AgentRecall-MIT.txt.
# The helper lives outside the bundle so it survives replacement of the old app.
set -eu

[ "$#" -eq 8 ] || exit 2
live=$1
staged=$2
backup=$3
gui=$4
backend=$5
data=$6
token=$7
version=$8
stage=${backup%/*}
updates=$data/updates
ready=$updates/ready-$token
new_pid=
backed_up=0
completed=0

case "$gui:$backend" in *[!0-9:]*|:*|*:) exit 2 ;; esac
case "$token" in *[!a-f0-9-]*|'') exit 2 ;; esac
case "$version" in *[!0-9.]*|'') exit 2 ;; esac
[ "$staged" = "$stage/unpacked/Ensemble.app" ] || exit 2
[ "$backup" = "$stage/previous.app" ] || exit 2
parent=$(/usr/bin/dirname "$live")
[ "$(/usr/bin/dirname "$stage")" = "$parent" ] || exit 2
case "${stage##*/}" in .ensemble-update-??????) ;; *) exit 2 ;; esac
[ -d "$live/Contents" ] && [ ! -L "$live" ] && [ ! -L "$stage" ] || exit 2

alive() {
  state=$(/bin/ps -p "$1" -o stat= 2>/dev/null || true)
  case "$state" in ''|*Z*) return 1 ;; *) return 0 ;; esac
}

wait_exit() {
  pid=$1
  remaining=$2
  while alive "$pid"; do
    [ "$remaining" -gt 0 ] || return 1
    remaining=$((remaining - 1))
    /bin/sleep 1
  done
}

owned_backend() {
  command=$(/bin/ps -p "$1" -o command= 2>/dev/null || true)
  [ "$command" = "$live/Contents/MacOS/Ensemble $live/Contents/Resources/app/dist/main/backend-entry.js --data-dir $data" ]
}

write_result() {
  printf '{"status":"%s","version":"%s","token":"%s"}\n' "$1" "$version" "$token" > "$updates/result.json.tmp"
  /bin/mv -f "$updates/result.json.tmp" "$updates/result.json"
}

launch() {
  unset ELECTRON_RUN_AS_NODE WORKBENCH_DEV_URL
  export WORKBENCH_DATA_DIR="$data"
  "$live/Contents/MacOS/Ensemble" >> "$updates/installer.log" 2>&1 &
  new_pid=$!
}

finish() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$completed" -eq 0 ]; then
    if [ "$backed_up" -eq 1 ]; then
      if [ -n "$new_pid" ] && alive "$new_pid"; then
        /bin/kill -TERM "$new_pid" 2>/dev/null || true
        wait_exit "$new_pid" 10 || /bin/kill -KILL "$new_pid" 2>/dev/null || true
      fi
      new_backend=$(/bin/ps -axo pid=,command= | /usr/bin/awk -v expected="$live/Contents/MacOS/Ensemble $live/Contents/Resources/app/dist/main/backend-entry.js --data-dir $data" '{ pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if ($0==expected) print pid }')
      for candidate in $new_backend; do
        case "$candidate" in ''|*[!0-9]*) write_result rollback-failed; exit 1 ;; esac
        if alive "$candidate"; then
          owned_backend "$candidate" || { write_result rollback-failed; exit 1; }
          /bin/kill -TERM "$candidate" 2>/dev/null || true
          wait_exit "$candidate" 15 || { write_result rollback-failed; exit 1; }
        fi
      done
      remaining=15
      while /bin/ps -axo command= | /usr/bin/awk -v prefix="$live/Contents/" 'index($0,prefix)==1 { found=1 } END { exit !found }'; do
        if [ "$remaining" -eq 0 ]; then write_result rollback-failed; exit 1; fi
        remaining=$((remaining - 1))
        /bin/sleep 1
      done
      /bin/rm -rf "$staged"
      if [ -d "$live" ]; then /bin/mv "$live" "$staged"; fi
      if ! /bin/mv "$backup" "$live"; then
        write_result rollback-failed
        exit 1
      fi
      unset WORKBENCH_UPDATE_TOKEN
      launch
    elif ! alive "$gui"; then
      unset WORKBENCH_UPDATE_TOKEN
      launch
    fi
    write_result error
  fi
  /bin/rm -f "$updates/pending.json" "$ready"
  if [ "$backed_up" -eq 0 ] || [ "$completed" -eq 1 ] || [ -d "$live/Contents" ]; then /bin/rm -rf "$stage"; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

wait_exit "$gui" 40
if alive "$backend"; then
  owned_backend "$backend"
  /bin/kill -TERM "$backend"
  wait_exit "$backend" 30
fi

# A second profile may still have the same installed bundle open. Leave it alone.
remaining=15
while /bin/ps -axo command= | /usr/bin/awk -v prefix="$live/Contents/" 'index($0,prefix)==1 { found=1 } END { exit !found }'; do
  [ "$remaining" -gt 0 ] || exit 1
  remaining=$((remaining - 1))
  /bin/sleep 1
done

/bin/mv "$live" "$backup"
backed_up=1
/bin/mv "$staged" "$live"
export WORKBENCH_UPDATE_TOKEN="$token"
launch
remaining=45
while [ ! -s "$ready" ]; do
  alive "$new_pid"
  [ "$remaining" -gt 0 ] || exit 1
  remaining=$((remaining - 1))
  /bin/sleep 1
done
[ "$(/bin/cat "$ready")" = "$new_pid" ]
completed=1
write_result installed
/bin/rm -rf "$backup"
exit 0
