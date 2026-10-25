# Consumer compatibility through Cargo patches

```sh
# Run from zao. Only Git/archive/transport runs here; all builds/tests run on aka.
bash scripts/consumers/run.sh /absolute/path/to/proseql-source
# Also compare original pins (no Cargo override), pre-skeleton main, supplied source:
bash scripts/consumers/run.sh /absolute/path/to/proseql-source --compare-baseline
```

The script captures the current **committed** Coach and Logbook revisions from
`~/code/sandbox/coach` and `~/code/sandbox/logbook`. It archives only tracked
server/Cargo/crates files plus Coach's synthetic contract fixtures and Logbook's test-required `scripts/stage-history`, then rsyncs them (excluding target) to owned copies:

- `/home/simonwjackson/work/qws-harness-coach/server`
- `/home/simonwjackson/work/qws-harness-logbook`

Coach's committed fixture generator declares synthetic data. No untracked app
storage, live health data, credentials, services or deployment targets are read.
Source repositories and their Cargo locks are never edited. Uncommitted consumer
edits are deliberately excluded. Consumer commits and commands are recorded.

The supplied source is copied to `/home/simonwjackson/work/qws-harness-proseql` independently of the tooling, so it need not include these scripts. `aka-run harness --x86-64-v2 --pull` copies the tooling and runs
`check-aka.sh` on aka in the ProseQL dev shell with Nix builders disabled and
nice 10. Each consumer gets a separate Cargo target and filesystem temp directory.
The command-line Cargo config patches all four `proseql-*` crates for the original
`file:///home/simonwjackson/code/github/simonwjackson/proseql` source URL. Cargo
may update the **copy's** lockfile. The original dependencies still name their
existing revisions (`0e3666a` and `9a11d36`); the override is not a consumer port.

For each consumer, the scripts execute:

```sh
cargo --config /.../coach-patch.toml build --workspace --all-targets
cargo --config /.../coach-patch.toml test --workspace -- --test-threads=1
# Repeat with logbook-patch.toml from its copied workspace root.
```

Tests have a 1,200-second timeout. Both consumers run even if the first fails.
Exit status is nonzero if any build or test fails. Full logs, commands and a
Markdown summary are under ignored `scripts/consumers/results/<label>/`; commit only a
small report under `bench/acceptance/results/`.

Do not overlap this script with another `aka-run harness` command: rsync deletes
remote files absent from the local source. Copies, caches and generated fixture
files remain only in owned `qws-harness-*` directories. The script does not launch
consumer servers or contact real services. It cannot establish real-data runtime
latency, deployment correctness or compatibility with uncommitted consumer code.

Baseline comparison archives `5d1a2aa` and transfers a Git bundle containing the exact consumer pins. The no-override run uses the untouched consumer manifests and `--locked`; an environment-only Git URL rewrite sends the original local source URL to an owned bare mirror with the same commit objects. It is a transport change, not a Cargo source patch. `cargo tree` records actual resolved ProseQL paths/revisions. Each comparison restores the committed consumer lock in its copy before building. No Git config is written to either original consumer repo.
