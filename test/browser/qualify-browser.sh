#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || $# != 1 ]]; then
  echo 'Run this entry point on a dedicated GitHub-hosted job.' >&2
  exit 1
fi
image_id="$1"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$(docker image inspect --format '{{.Id}}' "$image_id")" == "$image_id" ]]

# The dedicated VM runs one worker, with a second Chromium only for native tests.
# Hold the VM's browser qualification lock through process and container absence.
exec 9< "${RUNNER_TEMP:?}"
flock -n 9
browser_root="$(mktemp -d /tmp/flowai-wui.XXXXXXXX)"
owner="web-ui-${browser_root##*.}"
container_id=''
child=''
cleanup() {
  local status=$? cleanup_failed=0 owned
  trap - EXIT HUP INT TERM
  if [[ -n "$child" ]]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" || true
  fi
  if owned="$(docker ps -aq --no-trunc --filter "label=flowai.web-ui.qualification=$owner")"; then
    if [[ -n "$owned" ]]; then
      if [[ "$owned" =~ ^[0-9a-f]{64}$ && ( -z "$container_id" || "$owned" == "$container_id" ) ]]; then
        docker rm -f "$owned" >/dev/null || cleanup_failed=1
      else
        cleanup_failed=1
      fi
    fi
    if [[ "$cleanup_failed" == 0 ]] &&
       owned="$(docker ps -aq --filter "label=flowai.web-ui.qualification=$owner")" &&
       [[ -z "$owned" ]] &&
       { [[ -z "$container_id" ]] ||
         { owned="$(docker ps -aq --filter "id=$container_id")" && [[ -z "$owned" ]]; }; }; then
      echo "Web UI container absence verified for $owner"
    else
      cleanup_failed=1
    fi
  else
    cleanup_failed=1
  fi
  node owned-browser-processes.mjs "$browser_root" || cleanup_failed=1
  if [[ "$cleanup_failed" != 0 ]]; then exit 1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

container_id="$(docker create --pull=never --name "$owner" \
  --label "flowai.web-ui.qualification=$owner" \
  --publish 127.0.0.1::8080 "$image_id")"
[[ "$container_id" =~ ^[0-9a-f]{64}$ ]]
[[ "$(docker inspect --format '{{.Image}}' "$container_id")" == "$image_id" ]]
docker start "$container_id" >/dev/null
port="$(docker port "$container_id" 8080/tcp)"
[[ "$port" =~ ^127\.0\.0\.1:[0-9]+$ ]]
origin="http://$port"
curl -fsS --retry 12 --retry-connrefused --retry-delay 1 --max-time 2 "$origin/healthz"
echo

FLOWAI_WEB_UI_ORIGIN="$origin" FLOWAI_WEB_UI_IMAGE_ID="$image_id" \
  FLOWAI_BROWSER_NATIVE_TMP="$browser_root" FLOWAI_BROWSER_OWNER="$browser_root" \
  TMPDIR="$browser_root" TMP="$browser_root" TEMP="$browser_root" \
  node node_modules/playwright/cli.js test --workers=1 --retries=0 &
child=$!
browser_status=0
wait "$child" || browser_status=$?
child=''
report_status=0
node report-qualification.mjs test-results/results.json || report_status=$?
if (( browser_status != 0 )); then exit "$browser_status"; fi
exit "$report_status"
