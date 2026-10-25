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
out="$root/bench/stage0/results"
mkdir -p "$out" "$data"
scope() {
  systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout "$@"
}
case "$action" in
  task)
    nix run --builders '' .#bench-stage0 -- "${2:-all}"
    ;;
  checkout)
    # Import the locally committed snapshot, never create commits on yari.
    git init "$root"
    git fetch "$root/bench/stage0/source.bundle" HEAD
    git reset --mixed FETCH_HEAD
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
    ;;
  check)
    # Tests create synthetic data on disk, never under tmpfs.
    mkdir -p "$data/test-tmp"
    export TMPDIR="$data/test-tmp"
    nix develop --builders '' -c cargo check --locked --manifest-path bench/stage0/Cargo.toml --all-targets --all-features -j 2 > "$out/check.log" 2>&1
    scope 300 nix develop --builders '' -c cargo test --locked --manifest-path bench/stage0/Cargo.toml --all-features -j 2 -- --test-threads=1 > "$out/tests.log" 2>&1
    nix develop --builders '' -c cargo clippy --locked --manifest-path bench/stage0/Cargo.toml --all-targets --all-features --no-deps -j 2 -- -D warnings > "$out/clippy.log" 2>&1
    nix develop --builders '' -c rustfmt --edition 2021 --check bench/stage0/src/*.rs > "$out/format.log" 2>&1
    shellcheck bench/stage0/run.sh > "$out/shellcheck.log" 2>&1
    python3 -m py_compile bench/stage0/measure.py
    ;;
  measure)
    scope 300 "$data/timing" prepare "$data/base" > "$out/prepare.json" 2> "$out/prepare.stderr"
    scope 14400 python3 bench/stage0/measure.py "$data" "$out"
    ;;
  cleanup)
    # Only this task's fixed owned directory, never consumer or service data.
    rm -rf -- /home/simon/work/proseql-stage0-data
    ;;
  all)
    bash "$0" environment
    bash "$0" build
    bash "$0" check
    bash "$0" measure
    ;;
  *) echo 'usage: run.sh task [ACTION]|checkout|environment|lock|format|build|check|measure|cleanup|all' >&2; exit 2 ;;
esac
