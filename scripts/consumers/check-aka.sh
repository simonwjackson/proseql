#!/usr/bin/env bash
set -euo pipefail
if [[ $(hostname -s) != aka || $# -lt 1 || $# -gt 2 ]]; then
  echo 'aka only; usage: check-aka.sh PROSEQL_SOURCE_PATH|pinned [LABEL]' >&2
  exit 2
fi
tool_root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
source_path=$1
label=${2:-current}
if [[ ! $label =~ ^[a-zA-Z0-9._-]+$ ]]; then exit 2; fi
if [[ $source_path != pinned ]]; then source_path=$(cd -- "$source_path" && pwd); fi
export NIX_CONFIG="${NIX_CONFIG:-}
builders ="
export RUSTFLAGS='-C target-cpu=x86-64-v2'
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
out="$tool_root/scripts/consumers/results/$label"
mkdir -p "$out"
if [[ $source_path == pinned ]]; then
  # Transport the exact original commits, with no Cargo override or repo edits.
  mirror=/home/simonwjackson/work/qws-harness-pinned-git
  git init -q --bare "$mirror"
  git -C "$mirror" fetch "$tool_root/scripts/consumers/snapshots/pins.bundle" refs/heads/main:refs/heads/main
  git -C "$mirror" symbolic-ref HEAD refs/heads/main
  export CARGO_NET_GIT_FETCH_WITH_CLI=true
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="url.file://$mirror.insteadOf"
  export GIT_CONFIG_VALUE_0=file:///home/simonwjackson/code/github/simonwjackson/proseql
fi
status=0
printf '| Consumer | Commit | Build | Tests |\n|---|---|---|---|\n' > "$out/summary.md"
for consumer in coach logbook; do
  copy="/home/simonwjackson/work/qws-harness-$consumer"
  if [[ $consumer == coach ]]; then copy="$copy/server"; fi
  commit=$(cat "$tool_root/scripts/consumers/$consumer.sha")
  snapshot="$tool_root/scripts/consumers/snapshots/$consumer-$commit"
  if [[ $consumer == coach ]]; then snapshot="$snapshot/server"; fi
  # Each comparison starts with the exact committed consumer lock.
  cp "$snapshot/Cargo.lock" "$copy/Cargo.lock"
  cargo_args=()
  lock_args=()
  if [[ $source_path != pinned ]]; then
    patch="$out/$consumer-patch.toml"
    cat > "$patch" <<EOF
[patch."file:///home/simonwjackson/code/github/simonwjackson/proseql"]
proseql-native = { path = "$source_path/crates/proseql-native" }
proseql-engine = { path = "$source_path/crates/proseql-engine" }
proseql-storage = { path = "$source_path/crates/proseql-storage" }
proseql-formats = { path = "$source_path/crates/proseql-formats" }
EOF
    cargo_args=(--config "$patch")
  else
    lock_args=(--locked)
  fi
  export CARGO_TARGET_DIR="/home/simonwjackson/work/qws-harness-$consumer-target"
  export TMPDIR="/home/simonwjackson/work/qws-harness-$consumer-tmp"
  mkdir -p "$TMPDIR"
  printf 'ProseQL source: %s\nConsumer commit: %s\nSource mode: %s\n' "${QWS_SOURCE_SHA:-unknown-rsync-source}" "$commit" "$source_path" > "$out/$consumer-commands.txt"
  build=pass
  tests=pass
  (
    cd "$copy"
    printf '%q ' cargo "${cargo_args[@]}" build "${lock_args[@]}" --workspace --all-targets >> "$out/$consumer-commands.txt"
    printf '\n' >> "$out/$consumer-commands.txt"
    cargo "${cargo_args[@]}" build "${lock_args[@]}" --workspace --all-targets || exit "$?"
    # Save resolution evidence, including the actual patched manifest paths.
    cargo "${cargo_args[@]}" tree "${lock_args[@]}" --prefix none | grep '^proseql-' > "$out/$consumer-proseql-tree.txt"
  ) > "$out/$consumer-build.log" 2>&1 || { build=fail; status=1; }
  (
    cd "$copy"
    printf '%q ' timeout 1200 cargo "${cargo_args[@]}" test "${lock_args[@]}" --workspace -- --test-threads=1 >> "$out/$consumer-commands.txt"
    printf '\n' >> "$out/$consumer-commands.txt"
    timeout 1200 cargo "${cargo_args[@]}" test "${lock_args[@]}" --workspace -- --test-threads=1
  ) > "$out/$consumer-tests.log" 2>&1 || { tests=fail; status=1; }
  printf '| %s | %s | %s | %s |\n' "$consumer" "$commit" "$build" "$tests" >> "$out/summary.md"
done
cat "$out/summary.md"
exit "$status"
