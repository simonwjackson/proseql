#!/usr/bin/env bash
set -euo pipefail
if [[ $(hostname -s) != aka || $# != 1 ]]; then exit 2; fi
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
status=0
QWS_SOURCE_SHA='consumer pins: Coach 0e3666a2a39909a80ad7dd84b935c89249e9784f; Logbook 9a11d3665bcc881c568ee1d77d81596543c6ac07' \
  bash "$root/scripts/consumers/check-aka.sh" pinned pinned || status=1
QWS_SOURCE_SHA=5d1a2aae29b90742f917d3153c72907d4bbef56e \
  bash "$root/scripts/consumers/check-aka.sh" "$root/scripts/consumers/snapshots/proseql-main" main || status=1
bash "$root/scripts/consumers/check-aka.sh" "$1" qws-base || status=1
exit "$status"
