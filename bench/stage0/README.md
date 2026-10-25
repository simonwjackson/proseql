# Stage 0: isolated SQLite and scalar streaming experiment

Nothing here is a production engine or an approved redesign. Contracts: GitHub #12/#13 and `openspec/changes/query-while-scanning`.

## Reproduce on yari

From a committed checkout on **yari**:

```sh
nix run --builders '' .#bench-stage0
```

This records the environment and perf capability, checks the pinned production files, builds separate optimized timing/RSS and counting-allocator binaries, runs focused checks, prepares synthetic data, and runs the complete matrix, a stride-16 time-index supplement, an OOM/temp-file diagnostic, and summary generation. Nix binary-cache downloads are allowed. Distributed builders are disabled. No build or measurement is permitted on zao or rakku.

For the edit-on-zao/copy-to-yari workflow, commit first, then copy the worktree with rsync as requested. Because a linked worktree's `.git` pointer is not valid remotely, transfer the commits in an ignored bundle:

```sh
# zao: Git/file operations only; never run the task here.
git bundle create bench/stage0/source.bundle HEAD
rsync -a --delete --exclude target --exclude node_modules --exclude .git ./ \
  simon@yari:/home/simon/work/proseql-stage0/
ssh simon@yari '/home/simon/work/proseql-stage0/bench/stage0/run.sh checkout'
ssh simon@yari '/home/simon/work/proseql-stage0/bench/stage0/run.sh task all'
```

Multi-step remote logic lives in the Nix-shebang script, not ssh command strings. The `checkout` action imports existing commits; it does not create commits on yari. The caller must create `/home/simon/work/proseql-stage0` before the first copy. A fresh run requires a nonexistent `...-data/base`; preparation refuses to overwrite data. Copy the results home before `run.sh cleanup`. That action removes owned synthetic data, binary copies, Cargo target output, Python bytecode and the transferred bundle. Results are under `bench/stage0/results`, synthetic data and executable copies under `/home/simon/work/proseql-stage0-data`. If committed result files already exist, `all` selects a new timestamped `results/reproduction-*` directory; it never appends a new run to committed evidence.

## Fixture and workloads

The generator adapts the existing lazy-memory consumer fixture. January–October 2025 contains 437,760 UTC minutes. Every minute has a steps sample; even minutes also have heartRate: **656,640 records per shape**. There are 11 consumer fields, including long IDs, nullable `end`, the UTC day `date` and UTC time `atUtc`. Raw records copy those fields and add an FNV-1a-derived two-hex-digit `shard`; 256 files preserve chronological source order. These are synthetic raw-shaped records, not a copy of a private raw payload schema.

SQLite imports those exact JSON objects into typed columns in separate samples/raw tables. Returned rows reconstruct all original fields; there is no redundant JSON blob. It uses a primary-key B-tree, a `(metric,time)` B-tree, WAL, default page cache and `synchronous=NORMAL`. No covering aggregate index or precomputed daily totals is used. A bounded k-way merge imports both shapes in chronological ingestion order, so hash-file export order does not impose an artificially scattered SQLite table layout. SQLite temporary files are forced under the owned data directory with `SQLITE_TMPDIR` and `TMPDIR`; the SQLite adapter refuses a missing or off-directory setting.

| Workload | Operation |
|---|---|
| point | One existing ID. Raw also supplies its known shard; samples do not supply a time hint. |
| hour | May 1, 00:00–01:00 UTC, both metrics, return all 90 full records. |
| month | May, steps only, count/sum by UTC day. |
| ten | January–October, both metrics, count/sum by day and metric. |
| append | One batch of 1,000 requests: 900 new IDs and 100 exact existing duplicates, not an unchecked write. |
| open | Construct the backend and its configured metadata; no read query. |
| idle | Keep a freshly opened backend idle for one second; wall time is the observation interval, not work. |

Native reads use `query_bounded` / `aggregate_grouped_bounded`, matching the consumer's bounded path. Point is a bounded ID-filter query; it is not the separate `find_by_id` cache-miss path, which loads its full scope before trimming (source inspection, not an additional measured API). All successful runs must agree on full-row canonical digests, counts, exact integer-valued f64 sums, and every daily group. Focused tests additionally exercise independent writes, duplicate replay, unsorted append fallback, equal-time sparse block boundaries, and missing/corrupt/stale sidecars. This does not prove general query or mutation parity.

## Timing, memory and caches

Each trial runs in `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout 180 ...`. The driver/cache probes are also in a bounded scope. Three timing/RSS trials per combination rotate backend order; a separate meter trial avoids allocator instrumentation in the published wall times.

Read timing excludes open but includes result construction and canonical digest/fold. Warm reads run the same query once before timing, keeping the same backend. They therefore include ProseQL index reuse where possible, not just a warm OS cache. Cold reads start a fresh backend after fsync and `posix_fadvise(DONTNEED)` on owned files. Warm open opens/drops a backend once before timing a second open. Warm append reads source files into page cache but starts from a new backend and independent unchanged bytes; priming an append itself would turn new writes into duplicates. Append trials clone the base fixture with reflinks where available, otherwise independent copies.

RSS comes from `/proc/self/status`. Reset VmHWM immediately before the operation; peak includes the backend's resident starting state. Sample at return and one second later while the backend remains open. There is no consumer `malloc_trim` and no session teardown in that interval. Returned full rows are consumed into the digest and dropped within the timer; small aggregate/digest answers remain caller-owned.

The separate counting allocator reports Rust live/peak *requested bytes*, not allocator arenas. SQLite allocates in C: report its `sqlite3_memory_used`/`sqlite3_memory_highwater` separately. Do not add independent peaks and call that an exact joint peak. `/proc` sampling itself can add a few KiB to meter peaks. Heap-build timings are not baseline timings.

`mincore` probes source-file page residency without touching data pages. Report before process launch and after process exit, rounded to OS pages, including sidecars for the spike and database files for SQLite. This is owned-file residency, not system Cached or disjoint extra RSS. Post-exit SQLite residency includes connection-close checkpoint work outside the append timer. Cold eviction does not evict a virtual disk/controller cache. Warm trials prewarm the whole backend file set before the internal warm-up query. SQLite's single database contains both shapes, while the text file set is the selected collection. Thus warm cache columns describe deliberately prewarmed fixtures, not the query's minimum working set; use the cold-after column to see touched source pages plus readahead. Temporary SQLite sorter pages exist only during the query and are not captured by the post-exit source-file residency probe.

The main matrix keeps the requested default scope policy. A separate OOM diagnostic uses the same 1 GiB/no-swap/nice/timeout limits with `OOMPolicy=continue` only to keep the small observer alive after the native child is killed. It samples `/proc` RSS and the owning cgroup's peak/events. Another diagnostic observes actual SQLite `etilqs_` file descriptors under the owned temp directory; neither diagnostic is a published timing trial.

The perf capability check is the requested `nix run --builders '' nixpkgs#perf -- stat -e instructions:u true`. If supported, the Rust harness uses `perf_event_open` to count user instructions around only the timed operation, excluding setup and sleeps outside that operation. It uses no architecture-specific intrinsics.

## Spike limits and durability

The scanner uses borrowed serde string fields and a reused line buffer. It skips unused fields, filters before materializing results, folds groups using fixed-width UTC-day/metric keys (no per-row owned group-key allocation), and seeks using one time/offset sample every 256 rows. Sparse JSON sidecars are disposable, validated by length and nanosecond mtime; missing, invalid or stale sidecars rebuild. Unsorted files fall back to scanning. Metadata-preserving adversarial edits are not detected: this is not the production invalidation contract.

The scanner has no primary-key positional index. Sample point lookup scans all months; raw point lookup scans one hash shard. Exact append checks scan affected files and verify matching records; it syncs changed text files and rebuilds affected time indexes. This is deliberately not a transaction/watch implementation: no rollback journal, concurrent-edit conflict protocol, schema validation, callbacks or cross-file crash atomicity.

SQLite NORMAL WAL commits do not guarantee the same per-commit power-loss durability as ProseQL's synced text appends. The requested baseline is still NORMAL. Append timing is a measured bar, not proof of equivalent durability or atomicity. Stage 3 must resolve that contract before claiming the append target.
