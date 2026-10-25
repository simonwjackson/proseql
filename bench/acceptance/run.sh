#!/usr/bin/env bash
# All compilation/execution is on aka. Local launch only uses Git and transport.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
action=${1:-all}
if [[ $(hostname -s) != aka ]]; then
  if [[ $action != all && $action != check && $action != format ]]; then
    echo 'Use all, check or format to dispatch through aka-run.' >&2
    exit 2
  fi
  sha=$(git rev-parse HEAD)
  exec bash scripts/qws/aka-run harness --x86-64-v2 --pull -- env QWS_SOURCE_SHA="$sha" bash bench/acceptance/run.sh "$action"
fi
if [[ $(uname -m) != x86_64 || ${RUSTFLAGS:-} != '-C target-cpu=x86-64-v2' ]]; then
  echo 'aka x86_64 and RUSTFLAGS=-C target-cpu=x86-64-v2 are required.' >&2
  exit 1
fi
export NIX_CONFIG="${NIX_CONFIG:-}
builders ="
data=${ACCEPTANCE_DATA:-/home/simonwjackson/work/qws-harness-data/bench2}
mkdir -p "$data/tmp"
export TMPDIR="$data/tmp" SQLITE_TMPDIR="$data/tmp"
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
manifest=bench/acceptance/Cargo.toml
scope() {
  systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout "$@"
}
python() { nix shell --builders '' nixpkgs#python3 --command python3 "$@"; }
ruff() { nix run --builders '' nixpkgs#ruff -- "$@"; }
case "$action" in
  format)
    cargo fmt --manifest-path "$manifest"
    ruff check --fix bench/acceptance/*.py
    ruff format bench/acceptance/*.py
    ;;
  check)
    cargo check --locked --manifest-path "$manifest" --all-targets --all-features
    cargo test --locked --release --manifest-path "$manifest" --all-features -- --test-threads=1
    cargo clippy --locked --manifest-path "$manifest" --all-targets --all-features --no-deps -- -D warnings
    cargo fmt --manifest-path "$manifest" --check
    python -m unittest discover -s bench/acceptance -p 'test_*.py'
    ruff check bench/acceptance/*.py
    ruff format --check bench/acceptance/*.py
    shellcheck bench/acceptance/run.sh scripts/consumers/*.sh
    ;;
  all)
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    out="$root/bench/acceptance/results/runs/$stamp"
    mkdir -p "$out"
    printf '%s\n' "${QWS_SOURCE_SHA:-unknown-rsync-source}" > "$out/source.sha"
    # aka-run has an empty Git repo. Bind measurements to actual source bytes.
    find crates bench/acceptance/src -type f \( -name '*.rs' -o -name Cargo.toml -o -name Cargo.lock \) -print0 | sort -z | xargs -0 sha256sum > "$out/source-files.sha256"
    sha256sum bench/acceptance/*.py bench/acceptance/run.sh "$manifest" bench/acceptance/Cargo.lock > "$out/harness.sha256"
    { date -u; uname -a; lscpu; rustc --version; cargo --version; df -hT "$data"; printf 'RUSTFLAGS=%s\n' "$RUSTFLAGS"; } > "$out/environment.log"
    cargo build --locked --release --manifest-path "$manifest" > "$out/build.log" 2>&1
    cp "$CARGO_TARGET_DIR/release/proseql-acceptance" "$data/timing"
    cargo build --locked --release --manifest-path "$manifest" --features heap-meter > "$out/build-meter.log" 2>&1
    cp "$CARGO_TARGET_DIR/release/proseql-acceptance" "$data/meter"
    sha256sum "$data/timing" "$data/meter" > "$out/binaries.sha256"
    { date -u; cat /proc/loadavg; } > "$out/preparation-load-before.txt"
    if [[ ! -e "$data/base" ]]; then
      scope 600 "$data/timing" prepare "$data/base" > "$out/prepare.json"
    else
      cp "$data/base/manifest.json" "$out/fixture.json"
    fi
    if [[ ! -e "$data/base16" ]]; then
      scope 600 "$data/timing" prepare16 "$data/base16" > "$out/prepare16.json"
    fi
    # Independent probe fixtures. Never insert a conflict into measured data.
    for backend in sqlite streaming; do
      for kind in samples raw; do
        scope 180 "$data/timing" duplicate-check "$data/probe-$stamp-$backend-$kind" "$backend" "$kind" > "$out/duplicate-$backend-$kind.json"
      done
    done
    python -c 'import json,sys; from pathlib import Path; p=Path(sys.argv[1]); (p/"duplicates.json").write_text(json.dumps({f"{b}/{k}":json.loads((p/f"duplicate-{b}-{k}.json").read_text())["global_duplicate_checks"] for b in ("sqlite","streaming") for k in ("samples","raw")}))' "$out"
    { date -u; cat /proc/loadavg; } > "$out/preparation-load-after.txt"
    # The driver is small; each measured process has its own 1 GiB/no-swap scope.
    python bench/acceptance/measure.py "$data" "$out"
    python bench/acceptance/summarize.py "$out"
    prefix=${ACCEPTANCE_RESULT_PREFIX:-latest}
    cp "$out/tables.md" "bench/acceptance/results/$prefix.md"
    cp "$out/summary.jsonl" "bench/acceptance/results/$prefix.jsonl"
    cp "$out/source.sha" "bench/acceptance/results/$prefix-source.sha"
    echo "Results: $out"
    ;;
  *) echo 'usage: run.sh all|check|format' >&2; exit 2 ;;
esac
