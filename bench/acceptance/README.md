# Query-while-scanning acceptance

This is measurement tooling, not a second engine. It links the real public
`proseql-native` API and SQLite. `Resident` is the reference baseline.
The #12 acceptance decision judges `Streaming` against SQLite.

## Run on aka only

From the source checkout, use:

```sh
# Local launch does only Git/source transfer; every command runs on aka.
bash scripts/qws/aka-run harness --x86-64-v2 --pull -- proseql-task bench-acceptance
# Equivalent single flake task on aka, already inside aka-run:
# nix run --builders '' path:.#bench-acceptance
# Focused checks and formatting:
bash scripts/qws/aka-run harness --x86-64-v2 --pull -- bash bench/acceptance/run.sh check
bash scripts/qws/aka-run harness --x86-64-v2 --pull -- bash bench/acceptance/run.sh format
```

Do not overlap aka-run invocations for `harness`: its rsync uses `--delete`.
Run consumer checks before or after the matrix, not while it writes results.
No commands run on rakku or yari. No real health data is used.

The task builds two optimized binaries with
`RUSTFLAGS='-C target-cpu=x86-64-v2'`: normal timing/RSS and an independent
counting-allocator binary. All measured operations and fixture preparation use
`systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout`.
Distributed Nix builders stay disabled. Rust dependencies use the committed lock.

The source transferred by aka-run has an empty remote Git repository. Therefore
`source-files.sha256` and `harness.sha256` record the actual compiled source bytes.
The local launcher also records `QWS_SOURCE_SHA`; direct aka-run callers can pass
that variable, but an unavailable revision is labelled unknown, not invented.

Results go to `results/runs/<UTC timestamp>/`. Those large per-trial logs are
ignored. The task also writes `results/latest.md`, `results/latest.jsonl` and
`results/source.sha`. Commit only these small summaries and a short provenance
note. JSONL contains numeric cell summaries, heap, cache and every target verdict.
The raw trials remain on aka and are pulled back for investigation. Exit 0 means the matrix completed and answers matched; it does **not** mean the performance targets passed. Verify must read the target verdicts in Markdown or JSONL.

Defaults: three timing trials and one meter trial per cell, 360 planned trials.
For a smoke run only, set `ACCEPTANCE_REPEATS=1`; the table records that reduction.
`ACCEPTANCE_TIMEOUT` changes the per-operation timeout (default 180 seconds),
never the 1 GiB/no-swap limit. A SIGKILL skips later repetitions of that exact
cell; failures and skips stay visible and cannot become zero-valued passes.

## Fixture and measured public paths

The Stage 0 generator is retained without the throwaway scanner. January–October
2025 has 656,640 records per shape: steps each minute, heartRate every second
minute. `samples` has 10 month files. `raw` copies the same synthetic records into
256 hash shards. Raw is a synthetic shape, not a private payload-schema claim.
An additional same-row-count `raw16` fixture measures controlled partition-count
RSS growth for the ten-month aggregate (16 versus 256 shards).

| Workload | Native API / behavior |
|---|---|
| point | `find_by_id`, one existing ID, no time/shard hint |
| hour | `query_bounded`, May 1 00:00–01:00 UTC, both metrics, 90 full records |
| month | `aggregate_grouped_bounded`, May steps by UTC day |
| ten | `aggregate_grouped_bounded`, January–October by day and metric |
| append | public mutation `create_many`, 1,000 genuinely new IDs, durable commit |
| open | `open_sources_with_options` |
| idle | freshly opened backend, one-second observation interval |

`NativeSourceRuntimeOptions::execution_model` explicitly selects `Resident` or
`Streaming`. There are no implementation-specific read/append shortcuts. The
skeleton's Streaming fallback therefore runs now; merged streaming paths are
picked up automatically. Unlike Stage 0, point uses the real `find_by_id` API.

Append timing contains **no benchmark preflight**. A separate small fixture puts
a requested October ID with conflicting content in May, then calls the same
public `create_many`. The global-conflict probe runs for both shapes and gates append acceptance. Raw puts the conflicting ID in a deliberately different shard. The
Resident baseline currently misses this correctness guarantee. It must not be
reported as a globally checked fast append. The probe automatically sees the
Streaming guarantee once it is implemented. Set `ACCEPTANCE_REQUIRE_GLOBAL=1` for the focused Rust tests at cutover to require that guarantee, rather than only report the skeleton miss. Each successful timed append must
persist exactly 1,000 new rows; every trial uses an independent fixture copy.

The SQLite baseline uses the exact typed logical records, TEXT primary keys and
non-covering `(metric,time)` indexes. WAL, `synchronous=NORMAL`, default page cache,
no mmap or covering aggregate index. A bounded k-way merge imports chronological
records in both shapes. SQLite temporary files stay under the owned filesystem
`/home/simonwjackson/work/qws-harness-data/tmp`. Native synced text appends do not
have equal power-loss durability to NORMAL WAL. Timing against this requested
bar is measured; the same-durability qualification remains unmeasured.

## Timing, memory and verdicts

Backend order rotates across workloads, repetitions and meter/timing profiles.
Cold runs fsync and evict **only owned fixture files** with `POSIX_FADV_DONTNEED`.
`mincore` reports file-page residency before launch and after exit. Warm runs
prewarm the backend file set; read queries additionally prime the same operation
on the same open runtime. Append warms only file pages, never the mutation.
SQLite's file contains both shapes; text warming covers the selected collection.
Inode metadata and controller/hypervisor caches are not evicted.

Read timing excludes open and includes canonical answer consumption. Full rows
are digested and dropped within the timer. All successful implementations must
match complete-row digests and every group, not only counts. This fixture does
not prove general ordering, cursor, callback or schema-error parity.

VmHWM resets immediately before the timed operation. Peak includes warm starting
state. RSS is sampled at return and one second later while the backend stays
open. There is no `malloc_trim` or source-session teardown. Back-to-idle means:

```
retained = max(0, RSS_after_1s - fresh_idle_RSS)
retained <= max(SQLite_after_1s - SQLite_fresh_idle_RSS, 1 MiB)
```

The retained ratio uses this tolerance as its denominator. Open/idle ratios use
`SQLite RSS + 20 MiB`. Peak and wall ratios use SQLite's matching cell. Both cold
and warm must meet the limit. Every read gets separate peak and retained rows.
Partition growth reports 256-shard peak / 16-shard peak with a strict ≤1 observed
no-growth proxy. No tolerance was specified for this target; small allocator or
metadata growth can miss it. The measured ratio is not a scaling proof.

Heap is Rust requested live/peak bytes, not glibc arenas. SQLite's independent C
heap live/peak is in JSONL. Linux instruction counts are optional: disabled perf
is reported as unmeasured/null, never zero. Failed/missing measurements cannot
pass. Open ≤1 second on the real Logbook/rakku shape and absolute Celeron times
remain explicitly **unmeasured**. aka is only the approved synthetic proxy.

Synthetic fixtures and binary copies are retained under the fixed owned
`/home/simonwjackson/work/qws-harness-data` directory for repeated Verify runs.
Costs: roughly 3 GiB of fixture data, build output, and trial time. Do not treat
these results as consumer latency or a guarantee for the Celeron's disk/allocator.
