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
phase=validated
result=0
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

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

enter_phase() {
  phase=$1
  printf 'update version=%s phase=%s gui=%s backend=%s newPid=%s\n' "$version" "$phase" "$gui" "$backend" "$new_pid" || true
}

remove_bundle() {
  if ! "$lsregister" -u "$1" >/dev/null 2>&1; then
    printf 'update version=%s warning=unregister-bundle-failed bundle=%s\n' "$version" "$1" || true
  fi
  /bin/rm -rf "$1"
}

write_result() {
  receipt_phase=$phase
  if [ "$1" != installed ]; then receipt_phase=$failure_phase; fi
  printf 'update version=%s status=%s phase=%s exitCode=%s recoveryPhase=%s\n' "$version" "$1" "$receipt_phase" "$result" "$phase" || true
  printf '{"status":"%s","version":"%s","token":"%s","phase":"%s","exitCode":%s}\n' "$1" "$version" "$token" "$receipt_phase" "$result" > "$updates/result.json.tmp"
  /bin/mv -f "$updates/result.json.tmp" "$updates/result.json"
}

launch() {
  unset ELECTRON_RUN_AS_NODE WORKBENCH_DEV_URL
  export WORKBENCH_DATA_DIR="$data"
  "$live/Contents/MacOS/Ensemble" >> "$updates/installer.log" 2>&1 &
  new_pid=$!
  printf 'update version=%s phase=%s launchedPid=%s\n' "$version" "$phase" "$new_pid" || true
}

finish() {
  result=$? failure_phase=$phase
  trap - EXIT HUP INT TERM
  if [ "$completed" -eq 0 ]; then
    if [ "$backed_up" -eq 1 ]; then
      enter_phase rollback-stop-gui
      if [ -n "$new_pid" ] && alive "$new_pid"; then
        /bin/kill -TERM "$new_pid" 2>/dev/null || true
        wait_exit "$new_pid" 10 || /bin/kill -KILL "$new_pid" 2>/dev/null || true
      fi
      enter_phase rollback-stop-backend
      new_backend=$(/bin/ps -axo pid=,command= | /usr/bin/awk -v expected="$live/Contents/MacOS/Ensemble $live/Contents/Resources/app/dist/main/backend-entry.js --data-dir $data" '{ pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if ($0==expected) print pid }')
      for candidate in $new_backend; do
        case "$candidate" in ''|*[!0-9]*) write_result rollback-failed; exit 1 ;; esac
        if alive "$candidate"; then
          owned_backend "$candidate" || { write_result rollback-failed; exit 1; }
          /bin/kill -TERM "$candidate" 2>/dev/null || true
          wait_exit "$candidate" 15 || { write_result rollback-failed; exit 1; }
        fi
      done
      enter_phase rollback-wait-bundle-processes
      remaining=15
      while /bin/ps -axo command= | /usr/bin/awk -v prefix="$live/Contents/" 'index($0,prefix)==1 { found=1 } END { exit !found }'; do
        if [ "$remaining" -eq 0 ]; then write_result rollback-failed; exit 1; fi
        remaining=$((remaining - 1))
        /bin/sleep 1
      done
      enter_phase rollback-restore-bundle
      remove_bundle "$staged"
      if [ -d "$live" ]; then /bin/mv "$live" "$staged"; fi
      if ! /bin/mv "$backup" "$live"; then
        write_result rollback-failed
        exit 1
      fi
      unset WORKBENCH_UPDATE_TOKEN
      enter_phase rollback-launch-old
      launch
    elif ! alive "$gui"; then
      unset WORKBENCH_UPDATE_TOKEN
      enter_phase recover-launch-old
      launch
    fi
    write_result error
  fi
  /bin/rm -f "$updates/pending.json" "$ready"
  if [ "$backed_up" -eq 0 ] || [ "$completed" -eq 1 ] || [ -d "$live/Contents" ]; then
    remove_bundle "$staged"
    remove_bundle "$backup"
    /bin/rm -rf "$stage"
    enter_phase refresh-launch-registration
    if ! "$lsregister" -f "$live" >/dev/null 2>&1; then
      printf 'update version=%s warning=register-live-failed bundle=%s\n' "$version" "$live" || true
    fi
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

printf 'update version=%s live=%s stage=%s gui=%s backend=%s\n' "$version" "$live" "$stage" "$gui" "$backend" || true
enter_phase wait-old-gui
wait_exit "$gui" 40
if alive "$backend"; then
  enter_phase check-old-backend
  owned_backend "$backend"
  enter_phase stop-old-backend
  /bin/kill -TERM "$backend"
  enter_phase wait-old-backend
  wait_exit "$backend" 30
fi

# A second profile may still have the same installed bundle open. Leave it alone.
enter_phase wait-bundle-processes
remaining=15
while /bin/ps -axo command= | /usr/bin/awk -v prefix="$live/Contents/" 'index($0,prefix)==1 { found=1 } END { exit !found }'; do
  [ "$remaining" -gt 0 ] || exit 1
  remaining=$((remaining - 1))
  /bin/sleep 1
done

enter_phase backup-old-bundle
/bin/mv "$live" "$backup"
backed_up=1
enter_phase replace-bundle
/bin/mv "$staged" "$live"
export WORKBENCH_UPDATE_TOKEN="$token"
enter_phase launch-new
launch
enter_phase wait-new-ready
remaining=45
while [ ! -s "$ready" ]; do
  alive "$new_pid"
  [ "$remaining" -gt 0 ] || exit 1
  remaining=$((remaining - 1))
  /bin/sleep 1
done
enter_phase check-new-ready-pid
[ "$(/bin/cat "$ready")" = "$new_pid" ]
completed=1
enter_phase commit
write_result installed
enter_phase remove-old-bundle
exit 0
