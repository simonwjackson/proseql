#!/usr/bin/env bash
# Copy committed synthetic test sources, then build/test only on aka.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 || ( $# == 2 && $2 != --compare-baseline ) ]]; then
  echo 'usage: bash scripts/consumers/run.sh PROSEQL_SOURCE_PATH [--compare-baseline]' >&2
  exit 2
fi
source_path=$(cd -- "$1" && pwd)
tool_root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$tool_root"
sha=$(git -C "$source_path" rev-parse HEAD)
remote_source=/home/simonwjackson/work/qws-harness-proseql
ssh -o BatchMode=yes aka mkdir -p "$remote_source"
rsync -a --delete --exclude .git --exclude target --exclude node_modules --exclude .direnv --exclude snapshots \
  "$source_path/" "aka:$remote_source/"
for consumer in coach logbook; do
  repo="$HOME/code/sandbox/$consumer"
  commit=$(git -C "$repo" rev-parse HEAD)
  snapshot="$tool_root/scripts/consumers/snapshots/$consumer-$commit"
  mkdir -p "$snapshot"
  if [[ $consumer == coach ]]; then
    # Tracked code plus generated synthetic and shared contract fixtures only.
    git -C "$repo" archive "$commit" server contract/fixtures | tar -x -C "$snapshot"
  else
    # stage-history tests replace HOME with a synthetic temporary directory.
    git -C "$repo" archive "$commit" Cargo.toml Cargo.lock crates scripts/stage-history | tar -x -C "$snapshot"
  fi
  remote="/home/simonwjackson/work/qws-harness-$consumer"
  ssh -o BatchMode=yes aka mkdir -p "$remote"
  rsync -a --delete --exclude target --exclude .git "$snapshot/" "aka:$remote/"
  printf '%s\n' "$commit" > "$tool_root/scripts/consumers/$consumer.sha"
done
# Tooling is synced independently, so the supplied source need not contain it.
if [[ ${2:-} == --compare-baseline ]]; then
  mkdir -p scripts/consumers/snapshots/proseql-main
  git archive 5d1a2aa crates | tar -x -C scripts/consumers/snapshots/proseql-main
  git bundle create scripts/consumers/snapshots/pins.bundle main
  exec bash scripts/qws/aka-run harness --x86-64-v2 --pull -- env QWS_SOURCE_SHA="$sha" bash scripts/consumers/baselines-aka.sh "$remote_source"
fi
exec bash scripts/qws/aka-run harness --x86-64-v2 --pull -- env QWS_SOURCE_SHA="$sha" bash scripts/consumers/check-aka.sh "$remote_source"
