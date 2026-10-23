#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bash coreutils jq time
# Run from any directory. All data and logs stay outside the checkout.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
action=${1:-help}
out=${2:-${PROSEQL_MEMORY_ARTIFACTS:-/var/tmp/proseql-lazy-memory-evidence}}
mkdir -p "$out"
out=$(realpath "$out")
cd "$root"
case "$action" in
  build)
    nix develop --command cargo build --manifest-path crates/Cargo.toml -p proseql-native --profile memory-profile --example lazy_memory_bench --example timeseries_bench
    mkdir -p "$out/bin"
    cp crates/target/memory-profile/examples/lazy_memory_bench "$out/bin/unprofiled"
    cp crates/target/memory-profile/examples/timeseries_bench "$out/bin/timeseries_bench"
    nix develop --command cargo build --manifest-path crates/Cargo.toml -p proseql-native --profile memory-profile --features bench-observe --example lazy_memory_bench
    cp crates/target/memory-profile/examples/lazy_memory_bench "$out/bin/checkpoints"
    nix develop --command cargo build --manifest-path crates/Cargo.toml -p proseql-native --profile memory-profile --features allocation-meter --example lazy_memory_bench
    cp crates/target/memory-profile/examples/lazy_memory_bench "$out/bin/meter"
    nix develop --command cargo build --manifest-path crates/Cargo.toml -p proseql-native --profile memory-profile --features heap-profile --example lazy_memory_bench
    cp crates/target/memory-profile/examples/lazy_memory_bench "$out/bin/dhat"
    ;;
  check)
    if [[ ${PROSEQL_IN_DEV_SHELL:-0} != 1 ]]; then
      exec nix develop --command env PROSEQL_IN_DEV_SHELL=1 bash "$0" check "$out"
    fi
    cargo fmt --manifest-path crates/Cargo.toml --all
    cargo test --manifest-path crates/Cargo.toml -p proseql-native --example lazy_memory_bench --features heap-profile -- --test-threads=1
    cargo test --manifest-path crates/Cargo.toml -p proseql-native --example lazy_memory_bench --features allocation-meter -- --test-threads=1
    cargo test --manifest-path crates/Cargo.toml -p proseql-storage --lib --features bench-observe diagnostics::tests
    cargo test --manifest-path crates/Cargo.toml -p proseql-native --test lazy_partitions_runtime --features bench-observe
    cargo check --manifest-path crates/Cargo.toml -p proseql-native --examples --features heap-profile
    cargo clippy --manifest-path crates/Cargo.toml -p proseql-native -p proseql-storage --lib --examples --features proseql-native/heap-profile -- -D warnings
    cargo fmt --manifest-path crates/Cargo.toml --all -- --check
    bash -n scripts/profile-lazy-memory.sh
    ;;
  before)
    test -x "$out/bin/dhat"
    {
      date -u --iso-8601=seconds
      git rev-parse HEAD
      git diff --stat
      uname -a
      cat /proc/cpuinfo /proc/meminfo /proc/loadavg
      df -T "$out"
      nix develop --command rustc --version
      sha256sum "$out"/bin/*
    } > "$out/environment.log"
    "$out/bin/unprofiled" --data-dir "$out/data" --prepare-only > "$out/prepare.log" 2>&1
    for mode in zero ascending scan eager-id; do
      command time -v "$out/bin/unprofiled" --data-dir "$out/data" --mode "$mode" > "$out/$mode-unprofiled.log" 2> "$out/$mode-unprofiled.stderr"
      command time -v "$out/bin/checkpoints" --data-dir "$out/data" --mode "$mode" > "$out/$mode-checkpoints.log" 2> "$out/$mode-checkpoints.stderr"
      command time -v "$out/bin/dhat" --data-dir "$out/data" --mode "$mode" --heap-profile "$out/$mode-dhat.json" > "$out/$mode-dhat.log" 2> "$out/$mode-dhat.stderr"
    done
    # Existing benchmark retained as a separate control, not replaced by v1.
    command time -v "$out/bin/timeseries_bench" --data-dir "$out/original-data" --mode lazy --rows 140000,1000000,10000000 --years 10 --inserts 1000 --query-reps 20 > "$out/original-timeseries.log" 2> "$out/original-timeseries.stderr"
    ;;
  after)
    test -x "$out/bin/dhat"
    test -x "$out/bin/meter"
    test ! -e "$out/environment.log" || { echo "Refusing to overwrite evidence; choose a fresh directory" >&2; exit 2; }
    {
      date -u --iso-8601=seconds
      git rev-parse HEAD
      git status --short
      uname -a
      cat /proc/cpuinfo /proc/meminfo /proc/loadavg
      df -T "$out"
      nix develop --command rustc --version
      sha256sum "$out"/bin/*
    } > "$out/environment.log"
    "$out/bin/unprofiled" --data-dir "$out/data" --prepare-only > "$out/prepare.log" 2>&1
    "$out/bin/meter" --layout-only > "$out/layout.log"
    for mode in zero ascending scan eager-id; do
      echo "AFTER unprofiled $mode"
      command time -v "$out/bin/unprofiled" --data-dir "$out/data" --mode "$mode" --bounded > "$out/$mode-unprofiled.log" 2> "$out/$mode-unprofiled.stderr"
      echo "AFTER checkpoints $mode"
      command time -v "$out/bin/checkpoints" --data-dir "$out/data" --mode "$mode" --bounded > "$out/$mode-checkpoints.log" 2> "$out/$mode-checkpoints.stderr"
      echo "AFTER local-allocation-peaks $mode"
      command time -v "$out/bin/meter" --data-dir "$out/data" --mode "$mode" --bounded > "$out/$mode-meter.log" 2> "$out/$mode-meter.stderr"
      echo "AFTER DHAT allocation stacks $mode"
      command time -v "$out/bin/dhat" --data-dir "$out/data" --mode "$mode" --bounded --heap-profile "$out/$mode-dhat.json" > "$out/$mode-dhat.log" 2> "$out/$mode-dhat.stderr"
      echo "AFTER compatible legacy API control $mode"
      command time -v "$out/bin/unprofiled" --data-dir "$out/data" --mode "$mode" > "$out/$mode-legacy-unprofiled.log" 2> "$out/$mode-legacy-unprofiled.stderr"
    done
    command time -v "$out/bin/meter" --data-dir "$out/data" --mode scan --bounded --trim-end > "$out/allocator-diagnostic.log" 2> "$out/allocator-diagnostic.stderr"
    echo "AFTER unchanged original time-series workload"
    command time -v "$out/bin/timeseries_bench" --data-dir "$out/original-data" --mode lazy --rows 140000,1000000,10000000 --years 10 --inserts 1000 --query-reps 20 > "$out/original-timeseries.log" 2> "$out/original-timeseries.stderr"
    ;;
  feedback)
    "$out/bin/unprofiled" --data-dir "$out/feedback-data" --rows-per-month 1000 --id-rows 100 --prepare-only
    "$out/bin/dhat" --data-dir "$out/feedback-data" --rows-per-month 1000 --id-rows 100 --mode zero --bounded --heap-profile "$out/feedback-dhat.json" --check
    ;;
  summarize)
    for mode in zero ascending scan eager-id; do
      jq --arg mode "$mode" '. as $p | {mode: $mode, total_bytes: ([.pps[].tb]|add), peak_bytes: ([.pps[].gb]|add), end_bytes: ([.pps[].eb]|add), sites: [.pps[] | . + {frames: [.fs[] as $i | $p.ftbl[$i]]}]}' "$out/$mode-dhat.json" > "$out/$mode-sites.json"
      jq '{mode, total_bytes, peak_bytes, end_bytes, top_peak_sites: (.sites | sort_by(-.gb) | .[:20] | map({tb,gb,eb,tbk,tl,mean_lifetime_us: (.tl / .tbk),frames}))}' "$out/$mode-sites.json" > "$out/$mode-top-sites.json"
      jq -f scripts/summarize-lazy-sites.jq "$out/$mode-sites.json" > "$out/$mode-allocation-split.json"
      jq -R -s -f scripts/summarize-lazy-phases.jq "$out/$mode-dhat.stderr" > "$out/$mode-heap-phases.json"
      jq -R -s -f scripts/summarize-lazy-phases.jq "$out/$mode-checkpoints.stderr" > "$out/$mode-wall-phases.json"
      if [[ -f "$out/$mode-meter.stderr" ]]; then
        ./scripts/summarize-lazy-local.py "$out/$mode-meter.stderr" > "$out/$mode-local-peaks.json"
        ./scripts/summarize-lazy-local.py "$out/$mode-dhat.stderr" > "$out/$mode-dhat-local-peaks.json"
      fi
    done
    ;;
  *)
    echo "Usage: $0 build|check|before|after|feedback|summarize [artifact-directory]" >&2
    exit 2
    ;;
esac
