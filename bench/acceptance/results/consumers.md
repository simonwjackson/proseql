# Consumer compatibility on aka

Verified against the consumers' current committed sources, without editing either original repository. Builds and tests used `RUSTFLAGS='-C target-cpu=x86-64-v2'`, the ProseQL Nix dev shell, disabled remote builders, nice 10, separate Cargo targets, and filesystem-backed synthetic temporary data.

| Consumer | Consumer commit | Original ProseQL pin |
|---|---|---|
| Coach | `06719890e27212cf61fa77987dc4432cd68f1dd4` | `0e3666a2a39909a80ad7dd84b935c89249e9784f` |
| Logbook | `5dbb01551ecc9ff9530e9e193e60a48daedd025c` | `9a11d3665bcc881c568ee1d77d81596543c6ac07` |

| ProseQL source | Coach build | Coach tests | Logbook build | Logbook tests |
|---|---|---|---|---|
| Original pins, **no Cargo override**, committed locks | pass | 27 passed, 0 failed | pass | 219 passed, 0 failed, 2 pre-existing ignored |
| Pre-skeleton main `5d1a2aae29b90742f917d3153c72907d4bbef56e` | pass | 27 passed, 0 failed | pass | 219 passed, 0 failed, 2 pre-existing ignored |
| `qws/base` `11b3b80a398c985b3c2bf8fb915bd647e99d27f5` | pass | 27 passed, 0 failed | pass | 219 passed, 0 failed, 2 pre-existing ignored |

No API drift or skeleton regression was observed in these runs. This is source/test compatibility, not a real-data latency or deployment claim. The two Logbook ignores are its existing full-fixture RSS and 500k-row import measurements; this workflow did not enable them.

## Reproduce

```sh
# zao: Git/archive/rsync only. The script runs every build and test on aka.
bash scripts/consumers/run.sh /absolute/path/to/proseql --compare-baseline
```

The complete copies include Coach's tracked `server` and synthetic `contract/fixtures`, and Logbook's tracked `Cargo.toml`, `Cargo.lock`, `crates` and test-required `scripts/stage-history`. Each variant restores the original committed consumer lock in its **copy**. The original repositories remain untouched.

Commands executed in each copied consumer workspace on aka:

```sh
# Original pins: no --config, no [patch]. --locked keeps committed resolution.
cargo build --locked --workspace --all-targets
cargo test --locked --workspace -- --test-threads=1

# main and qws/base: four proseql-* path patches, supplied only by Cargo config.
cargo --config /.../<label>/<consumer>-patch.toml build --workspace --all-targets
cargo --config /.../<label>/<consumer>-patch.toml test --workspace -- --test-threads=1
```

Tests run through `timeout 1200`. No-override fetching uses an environment-only Git URL rewrite to `/home/simonwjackson/work/qws-harness-pinned-git`, a bare mirror holding the exact original commit objects transferred in a bundle. This changes transport, not Cargo dependencies. `cargo tree --prefix none` confirmed the exact Git pins and all four intended local override paths.

Logs and executable command records remain under `scripts/consumers/results/{pinned,main,qws-base}/` on aka and in the local ignored copy. Consumer copies and build caches remain in the owned `/home/simonwjackson/work/qws-harness-*` directories for Verify.

## Initial failures and classification

These failed setup runs were corrected and rerun; none is a final consumer failure.

| First error | Call site | Classification | Fix / verification |
|---|---|---|---|
| Coach: `couldn't read tests/../../contract/fixtures/finish/normal-open.json` | `server/tests/store.rs:122`, `include_str!` | Environment/tooling: incomplete archive, not API drift or skeleton | Include committed synthetic contract fixtures. Both builds and all 27 tests pass for all 3 sources. |
| Logbook: `assertion failed: output.status.success()` in `staging_copies_only_allowlisted_files_and_never_prints_contents` | `crates/importers/history/tests/import.rs:517`; child invokes `../../../scripts/stage-history` at line 505 | Environment/tooling: missing test script, not API drift or skeleton | Include the tracked script. The test supplies a synthetic temporary HOME. All 219 tests pass for all 3 sources. |
| Pins: `fatal: couldn't find remote ref HEAD` | Cargo's Git dependency fetch, before compilation; owned bare mirror had `main` but HEAD named unborn `master` | Environment/tooling transport setup, not a consumer test failure | Set mirror HEAD to `refs/heads/main`. Reran both pins without Cargo overrides; both build and test runs pass. |

No test failure was attributed to flakiness. No consumer source or engine source was changed to obtain these passes.
