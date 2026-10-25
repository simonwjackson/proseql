#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bash coreutils python3 systemd shellcheck git --builders ''
# This script is deliberately host-restricted. No local builds on zao.
set -euo pipefail
# No distributed builds. Substituter downloads remain enabled.
export NIX_CONFIG="${NIX_CONFIG:-}
builders ="
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
if [[ $(hostname -s) != yari || $(uname -m) != aarch64 ]]; then
  echo 'Stage 0 builds, tests and measurements are allowed only on yari.' >&2
  exit 1
fi
action=${1:-all}
data=/home/simon/work/proseql-stage0-data
out=${STAGE0_RESULTS:-"$root/bench/stage0/results"}
if [[ "$action" == all && -e "$out/trials.jsonl" ]]; then
  out="$out/reproduction-$(date -u +%Y%m%dT%H%M%SZ)"
fi
export STAGE0_RESULTS="$out"
mkdir -p "$out" "$data/tmp"
export TMPDIR="$data/tmp"
export SQLITE_TMPDIR="$data/tmp"
scope() {
  systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout "$@"
}
case "$action" in
  archive)
    mkdir -p "$out/initial"
    find "$out" -maxdepth 1 -type f -exec mv -t "$out/initial" -- {} +
    ;;
  task)
    nix run --builders '' .#bench-stage0 -- "${2:-all}"
    ;;
  checkout)
    # Import the locally committed snapshot, never create commits on yari.
    git init "$root"
    git fetch "$root/bench/stage0/source.bundle" HEAD
    git reset --mixed FETCH_HEAD
    ;;
  tools)
    {
      nix develop --builders '' -c rustc --version
      nix develop --builders '' -c cargo --version
      nix develop --builders '' -c cc --version
      getconf PAGESIZE
      nix develop --builders '' -c ldd "$data/timing"
    } > "$out/toolchain.log" 2>&1
    ;;
  environment)
    {
      date -u --iso-8601=seconds
      git rev-parse HEAD
      git status --porcelain
      uname -a
      lscpu
      cat /proc/meminfo /proc/loadavg
      df -hT /home/simon/work
      nix --version
      sha256sum -c bench/stage0/baseline-files.sha256
    } > "$out/environment.log" 2>&1
    scope 120 nix run --builders '' nixpkgs#perf -- stat -e instructions:u true > "$out/perf.log" 2>&1 || true
    ;;
  build)
    git rev-parse HEAD > "$out/source.sha"
    git status --porcelain > "$out/source.status"
    git diff --exit-code -- crates bench/stage0/src bench/stage0/Cargo.toml bench/stage0/Cargo.lock
    sha256sum bench/stage0/src/*.rs bench/stage0/Cargo.toml bench/stage0/Cargo.lock flake.nix > "$out/harness.sha256"
    sha256sum -c bench/stage0/baseline-files.sha256 > "$out/baseline-check.log"
    nix develop --builders '' -c cargo build --locked --release --manifest-path bench/stage0/Cargo.toml -j 2 > "$out/build.log" 2>&1
    cp bench/stage0/target/release/proseql-stage0 "$data/timing"
    nix develop --builders '' -c cargo build --locked --release --manifest-path bench/stage0/Cargo.toml --features heap-meter -j 2 > "$out/build-meter.log" 2>&1
    cp bench/stage0/target/release/proseql-stage0 "$data/meter"
    sha256sum "$data/timing" "$data/meter" > "$out/binaries.sha256"
    ;;
  lock)
    nix develop --builders '' -c cargo metadata --format-version 1 --manifest-path bench/stage0/Cargo.toml > "$out/cargo-metadata.json" 2> "$out/lock.log"
    ;;
  format)
    nix develop --builders '' -c rustfmt --edition 2021 bench/stage0/src/*.rs
    nix run --builders '' nixpkgs#ruff -- format bench/stage0/*.py
    ;;
  check)
    # Tests create synthetic data on disk, never under tmpfs.
    mkdir -p "$data/test-tmp"
    export TMPDIR="$data/test-tmp"
    nix develop --builders '' -c cargo check --locked --manifest-path bench/stage0/Cargo.toml --all-targets --all-features -j 2 > "$out/check.log" 2>&1
    scope 300 nix develop --builders '' -c cargo test --release --locked --manifest-path bench/stage0/Cargo.toml --all-features -j 2 -- --test-threads=1 > "$out/tests.log" 2>&1
    nix develop --builders '' -c cargo clippy --locked --manifest-path bench/stage0/Cargo.toml --all-targets --all-features --no-deps -j 2 -- -D warnings > "$out/clippy.log" 2>&1
    nix develop --builders '' -c rustfmt --edition 2021 --check bench/stage0/src/*.rs > "$out/format.log" 2>&1
    shellcheck --shell bash bench/stage0/run.sh > "$out/shellcheck.log" 2>&1
    python3 -m py_compile bench/stage0/*.py
    nix run --builders '' nixpkgs#ruff -- check bench/stage0/*.py > "$out/python-lint.log" 2>&1
    nix fmt --builders '' -- --check flake.nix > "$out/nix-format.log" 2>&1
    ;;
  measure)
    scope 300 "$data/timing" prepare "$data/base" > "$out/prepare.json" 2> "$out/prepare.stderr"
    scope 14400 python3 bench/stage0/measure.py "$data" "$out"
    ;;
  driver-check)
    mkdir -p "$out/driver-check"
    STAGE0_BACKENDS=sqlite,proseql,spike STAGE0_REPEATS=1 scope 300 python3 -c 'import sys; from pathlib import Path; sys.path.insert(0, "bench/stage0"); import measure; measure.run(Path(sys.argv[1]), Path(sys.argv[2]), kinds=("samples",), workloads=("hour",))' "$data" "$out/driver-check"
    ;;
  dense)
    scope 1800 python3 bench/stage0/dense.py "$data" "$out"
    ;;
  summarize)
    python3 bench/stage0/summarize.py "$out" > "$out/summary-check.json"
    ;;
  diagnose)
    rm -rf -- "$data/diagnostic"
    cp -a --reflink=auto "$data/base" "$data/diagnostic"
    # Keep the tiny observer alive when the native child is OOM-killed. The
    # measured binary and the memory/swap/priority/time limits are unchanged.
    systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 -p OOMPolicy=continue nice -n 10 timeout 180 python3 bench/stage0/diagnose.py "$data" > "$out/raw-append-diagnostic.json" 2> "$out/raw-append-diagnostic.stderr" || test -s "$out/raw-append-diagnostic.json"
    python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["returncode"] == -9 and r["memory_events_after"]["oom_kill"] > r["memory_events_before"]["oom_kill"]' "$out/raw-append-diagnostic.json"
    scope 180 python3 bench/stage0/diagnose.py "$data" sqlite-temp > "$out/sqlite-temp-diagnostic.json" 2> "$out/sqlite-temp-diagnostic.stderr"
    ;;
  cleanup)
    # Only this task's fixed owned directory, never consumer or service data.
    rm -rf -- /home/simon/work/proseql-stage0-data
    rm -rf -- "$root/bench/stage0/target" "$root/bench/stage0/__pycache__"
    rm -f -- "$root/bench/stage0/source.bundle"
    test ! -e /home/simon/work/proseql-stage0-data
    test ! -e "$root/bench/stage0/target"
    printf '%s\n' 'Verified: owned synthetic data, executable copies, Cargo target, Python bytecode and source bundle removed.' > "$out/cleanup.log"
    ;;
  all)
    bash "$0" environment
    bash "$0" build
    bash "$0" check
    bash "$0" tools
    bash "$0" measure
    bash "$0" dense
    bash "$0" diagnose
    bash "$0" summarize
    ;;
  *) echo 'usage: run.sh archive|task [ACTION]|checkout|environment|tools|lock|format|build|check|measure|driver-check|dense|diagnose|summarize|cleanup|all' >&2; exit 2 ;;
esac
