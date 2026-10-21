# Time-series benchmark

This file records the native time-series benchmark before and after each step of `openspec/changes/native-timeseries/`. All data is synthetic. No personal data is read, copied or quoted.

## How to run

```sh
just bench-timeseries            # --rows 140000,1000000,10000000 --years 10 --mode lazy
just bench-timeseries --mode baseline --rows 140000,1000000 --inserts 1000 --insert-budget-secs 600
```

The recipe runs:

```sh
cargo run --release --manifest-path crates/Cargo.toml -p proseql-native \
  --example timeseries_bench -- --rows 140000,1000000,10000000 --years 10 --mode lazy
```

Later flags override earlier ones, so `just bench-timeseries --mode baseline` runs the baseline. The harness itself defaults to `--mode baseline`; the recipe passes `--mode lazy` first because the acceptance check (contract section 6) is a lazy run. Never run an eager mode at 10M rows on a machine with less than about 64 GiB of RAM (step 1). Run `--help` for every option.

### Data

- One heart-rate sample per line: `{"id":"heartrate:<iso>","timestamp":"<iso ms Z>","bpm":<int>,"source":"awake|rest|live|workout|session","month":"YYYY-MM"}`.
- Rows are spread evenly over `--years` (default 10) from `--start` (default `2016-01-01`), with up to half a slot of seeded jitter. Timestamps are strictly increasing, so IDs are unique. 10 years give 120 monthly partitions for every size.
- Partition files are `<root>/heartrate/YYYY-MM.jsonl`. The key is the `month` field, because `PartitionKey::Field { field: "month" }` uses the complete field value as the file name. Time buckets (step 3) produce the same `YYYY-MM` names.
- Files match the JSONL encoder byte for byte: compact lines in schema order, joined by `\n`, with no trailing newline. A rewrite therefore reproduces the earlier bytes.
- The generator uses SplitMix64 with `--seed` (default `20261020`).
- Data is cached under `$PROSEQL_BENCH_DATA_DIR`, else `/var/tmp/proseql-timeseries-bench/cache/<key>`, keyed by generator version, rows, start, span and seed. It is never written into the checkout. A `.complete` marker guards against partial caches. Delete the directory to free disk (10M rows use 1.27 GB).
- To match today's real layout (about 140k rows in eight monthly files), run `--rows 140000 --years 0.66 --start 2026-01-01`. The acceptance command uses 10 years for every size, so that row is reference only.

### Method

- The parent process generates or reuses the data, copies it into a fresh work directory (`copy_file_range`, which reflinks on btrfs), and runs each size in a fresh child process. Peak RSS (`VmHWM` in `/proc/self/status`) is therefore per size. The page cache is warm.
- The child opens the collection through the public API: `NativeRuntime::open_sources_with_host` with a `DatabaseSourceConfig::Partitioned` JSONL source, `watch_debounce: None`, and a storage host that forwards to `FsStorageHost` and counts bytes read and written.
- **Open**: wall time of `open_sources_with_host`. "RSS after open" is `VmHWM` after open, the peak through open.
- **Range query**: `timestamp >= A and timestamp < A + 1h`, with `A` the hour at the middle of the span. Median of `--query-reps` (default 20) runs through `runtime.read(|db| db.query(..))` (eager modes) or `runtime.query(..)` (lazy mode). "Partitions loaded" is the number of partition files resident when the query runs (eager modes) or `NativeQueryStats.partitions_loaded` (lazy mode). "Index" is the index the planner used. Since commit `6d29c55` the harness also times a window of one sample slot (span / rows) at the same start, which returns about one row at every size.
- **Insert**: one `runtime.mutate(|db| db.create(..))` per sample, timestamps after the last generated row and inside the last month, so every insert targets an existing full-size partition. Up to `--inserts` (default 1,000), stopping after `--insert-budget-secs` (default 600 s per size). "Bytes written" and "bytes read" are counted at the storage host for each insert. "File growth" is the size change of the target file. "Prefix kept" checks that the final target file starts with its original bytes.
- **Memory guard**: a watchdog thread polls `VmRSS` and `MemAvailable` every 10 ms. Above `--max-rss-mb` (default: `MemAvailable` − 1024 MiB at start), or when the machine's `MemAvailable` falls below `--min-available-mb` (default 1024, since commit `03d0dbc`), the child prints its partial numbers with `"status":"aborted"` and exits. The second check matters on a shared machine: other processes can take the memory the RSS limit assumed was free, and the kernel OOM killer then acts before the RSS limit (see "Harness note" in step 2).
- **Output**: one `TSBENCH {json}` line per size, then a Markdown table.
- **Modes**: `--mode baseline|append|timebucket|ordered|lazy` selects cumulative feature sets. `append` sets `append_only: true` and `duplicate_ids: ignore_identical`, so creates use the native append path (since commit `741ddbf`). `timebucket` adds `PartitionKey::TimeBucket { timestamp, Month }` and generates rows without the `month` field (cache key suffix `-nomonth`, same file names). `ordered` adds `ordered_indexes: ["timestamp"]` on top of `timebucket` (cumulative since branch `ts/lazy`; the step 4 run below was made on `ts/index` without steps 2 and 3 and records `"partition_key":"field:month"`). `lazy` adds a `lazy_partitions` policy on top of `ordered`. The counting host forwards `append_durable` and `read_tail`, so appends count the bytes they write and the conflict-check tail they read.

## Step 1 baseline (commit 0e3666a)

### Run

| Item | Value |
|---|---|
| Runtime code | `0e3666a` (unchanged); harness from branch `ts/bench` commit `f28910c` |
| Command | `nix develop -c just bench-timeseries` (defaults: `--mode baseline --inserts 1000 --insert-budget-secs 600 --query-reps 20 --seed 20261020`). The recipe has passed `--mode lazy` since step 5; to repeat this run, add `--mode baseline`. |
| Date | 2026-10-20, 19:58–20:21 UTC |
| CPU | 11th Gen Intel Core i9-11900H, 8 cores / 16 threads, 2.5 GHz base, 4.9 GHz max |
| RAM | 31 GiB (32,588,248 kB); 15.7 of 15.9 GiB swap in use at start |
| Disk | WD Blue SN570 2 TB NVMe SSD, btrfs |
| OS / toolchain | Linux 6.18.17, rustc 1.92.0, release profile |
| Machine load | Shared machine. One-minute load average 42.7 at start, 19 to 20 during the 140k run, 6.4 at the end. Other sessions were compiling. Treat timings as ±50%. |
| Memory limit | `--max-rss-mb 15262` (default from `MemAvailable` at start) |

### Results

| Rows | Partitions | Data | Open | RSS after open (peak) | Resident after open | Peak RSS | Inserts timed | Insert median | Insert p95 | Bytes written / insert | Bytes read / insert | File growth / insert | Prefix kept | 1 h query median | Rows returned | Partitions loaded | Index | Status |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|---|
| 140,000 | 120 | 17.8 MB | 4.50 s | 780 MiB | 591 MiB | 1,124 MiB | 495 of 1,000 (budget) | 1,071 ms | 1,943 ms | 179,509 B | 179,382 B | 127 B | yes | 170 ms | 1 | 120 | none | ok |
| 1,000,000 | 120 | 127.0 MB | 27.2 s | 5,574 MiB | 4,047 MiB | 8,198 MiB | 76 of 1,000 (budget) | 7,279 ms | 11,688 ms | 1,062,710 B | 1,062,583 B | 127 B | yes | 1,538 ms | 11 | 120 | none | ok |
| 10,000,000 | 120 | 1.27 GB | did not finish | — | — | 15,272 MiB at abort | 0 | — | — | — | — | — | — | — | — | — | — | aborted in open after 90.4 s: RSS 15,267 MiB > limit 15,262 MiB |

Machine-readable lines from this run:

```text
TSBENCH {"mode":"baseline","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":15262,"status":"ok","partitions":120,"data_bytes":17780235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":609392.273807,"open_ms":4499.590389999999,"rss_after_open_mb":780,"rss_resident_after_open_mb":591,"records_loaded":140000,"open_partitions_read":120,"open_bytes_read":17780235,"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":250.55452700000004,"query_median_ms":170.303369,"query_rows":1,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","inserts_done":495,"insert_median_ms":1071.2364670000002,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":true,"insert_target":"2025-12.jsonl","insert_target_bytes_before":148024,"insert_paths_written":1,"insert_p95_ms":1942.866894,"insert_min_ms":696.894339,"insert_max_ms":3082.915437,"insert_bytes_written_median":179509.0,"insert_bytes_read_median":179382.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":1124}
TSBENCH {"mode":"baseline","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":15262,"status":"ok","partitions":120,"data_bytes":127005405,"rss_before_open_mb":3,"phase":"done","phase_started_ms":659057.787996,"open_ms":27193.262986,"rss_after_open_mb":5574,"rss_resident_after_open_mb":4047,"records_loaded":1000000,"open_partitions_read":120,"open_bytes_read":127005405,"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1580.5763960000002,"query_median_ms":1537.8060355000002,"query_rows":11,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","inserts_done":76,"insert_median_ms":7279.163360500001,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":true,"insert_target":"2025-12.jsonl","insert_target_bytes_before":1057831,"insert_paths_written":1,"insert_p95_ms":11688.235959,"insert_min_ms":5504.1724619999995,"insert_max_ms":14009.282159999999,"insert_bytes_written_median":1062709.5,"insert_bytes_read_median":1062582.5,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":8198}
TSBENCH {"mode":"baseline","rows":10000000,"years":10.0,"seed":20261020,"max_rss_mb":15262,"status":"aborted","partitions":120,"data_bytes":1270055284,"rss_before_open_mb":3,"phase":"open","phase_started_ms":0.6008450000000001,"reason":"rss 15267 MiB exceeded --max-rss-mb 15262","peak_rss_mb":15272,"elapsed_ms":90372.891017,"phase_elapsed_ms":90372.29017200001}
```

### Reading the baseline

- **10M rows do not fit on this machine.** Open was stopped at 15.3 GiB after 90 s, before it finished. The 140k and 1M runs use about 5.7 KiB of peak RSS per row through open (780 MiB / 140k; 5,574 MiB / 1M). A linear extrapolation gives about 54 GiB through open and about 80 GiB with inserts at 10M (inferred, not measured). That exceeds the 31 GiB of this machine regardless of the limit. The target size was not reduced.
- **Insert cost grows with total history, not with partition size.** At 140k rows the target partition holds 148 KB, yet one insert takes about 1.1 s. At 1M rows it takes about 7.3 s (6.8× for 7.1× rows). Each mutation snapshots every record, regroups all partitions and compares them, then durably rewrites the target partition. Extrapolated cost at 10M is about 70 s per insert (inferred).
- **Every insert rewrites the whole target partition.** Bytes written per insert equal the partition size (179 KB and 1.06 MB medians), against 127 bytes of file growth. The conflict check also reads the whole partition before each write. The earlier bytes survive because the encoder reproduces them, not because the file is appended.
- **Fewer than 1,000 inserts at baseline.** The 600 s budget allowed 495 inserts at 140k and 76 at 1M. The median and p95 come from those samples. Raise `--insert-budget-secs` for more samples.
- **The range query scans everything.** All 120 partitions are loaded at open and no ordered index exists, so a one-hour query costs 170 ms at 140k and 1.5 s at 1M (about 15 s at 10M, inferred).
- **Open time and memory grow with total history.** 4.5 s and 780 MiB at 140k; 27 s and 5.6 GiB at 1M.

### Reference: today's layout (140k rows, 8 months)

Command: `nix develop -c just bench-timeseries --rows 140000 --years 0.66 --start 2026-01-01 --insert-budget-secs 300` (baseline mode at that commit; today add `--mode baseline`), 20:22–20:28 UTC, one-minute load average 4.8 to 5.4, same machine and commit.

| Rows | Partitions | Open | RSS after open (peak) | Peak RSS | Inserts timed | Insert median | Insert p95 | Bytes written / insert | File growth / insert | Prefix kept | 1 h query median | Rows returned | Partitions loaded | Index |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|
| 140,000 | 8 | 2.19 s | 779 MiB | 1,160 MiB | 319 of 1,000 (budget) | 930 ms | 1,097 ms | 2,163,511 B | 127 B | yes | 138 ms | 24 | 8 | none |

```text
TSBENCH {"mode":"baseline","rows":140000,"years":0.66,"seed":20261020,"max_rss_mb":20714,"status":"ok","partitions":8,"data_bytes":17780347,"rss_before_open_mb":3,"phase":"done","phase_started_ms":305238.209787,"open_ms":2188.995914,"rss_after_open_mb":779,"rss_resident_after_open_mb":589,"records_loaded":140000,"open_partitions_read":8,"open_bytes_read":17780347,"query_from":"2026-05-01T12:00:00.000Z","query_reps":20,"query_first_ms":146.355777,"query_median_ms":137.8083475,"query_rows":24,"query_partitions_loaded":8,"query_partition_reads":0,"query_index_used":"none","inserts_done":319,"insert_median_ms":930.146397,"inserts_requested":1000,"insert_budget_secs":300.0,"insert_budget_hit":true,"insert_target":"2026-08.jsonl","insert_target_bytes_before":2143195,"insert_paths_written":1,"insert_p95_ms":1097.388407,"insert_min_ms":741.3771820000001,"insert_max_ms":1262.543862,"insert_bytes_written_median":2163511.0,"insert_bytes_read_median":2163385.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":1160}
```

With the same 140k rows in 8 partitions of about 2.1 MB instead of 120 partitions of about 150 KB, an insert costs about the same (930 ms against 1,071 ms) while it writes 12× more bytes. This supports the reading above: at baseline, insert cost follows total rows, and the partition rewrite is the smaller part.

## Step 2 append

### Run

| Item | Value |
|---|---|
| Runtime and harness | branch `ts/append`, commit `741ddbf` |
| Command | `./crates/target/release/examples/timeseries_bench --rows 140000,1000000 --years 10 --mode append --inserts 1000` (release build, inside `nix develop`) |
| Date | 2026-10-20, 23:05–23:07 UTC (append and time bucket); baseline rerun 23:13–23:17 UTC |
| Machine | same as step 1 |
| Machine load | One-minute load average 13 at start, 8.5 at the end; another worker ran its own benchmark at the same time. The step 1 baseline ran at 19–43, so the baseline was rerun at 140k under this load (below). Treat timings as ±50%. |
| Memory limit | `--max-rss-mb 13162` (default from `MemAvailable` at start) |

### Results

| Rows | Mode | Open | RSS after open (peak) | Peak RSS | Inserts timed | Insert median | Insert p95 | Bytes written / insert | Bytes read / insert | File growth / insert | Prefix kept | 1 h query median | Status |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| 140,000 | baseline (step 1, load 19–43) | 4.50 s | 780 MiB | 1,124 MiB | 495 of 1,000 | 1,071 ms | 1,943 ms | 179,509 B | 179,382 B | 127 B | yes | 170 ms | ok |
| 140,000 | baseline rerun (load 11–17, 180 s budget) | 2.36 s | 781 MiB | 1,137 MiB | 143 of 1,000 | 1,208 ms | 1,668 ms | 157,163 B | 157,036 B | 127 B | yes | 185 ms | ok |
| 140,000 | **append** | 1.81 s | 781 MiB | 781 MiB | 1,000 of 1,000 | **0.54 ms** | 0.77 ms | **127 B** | 4,096 B | 127 B | yes | 156 ms | ok |
| 1,000,000 | baseline (step 1) | 27.2 s | 5,574 MiB | 8,198 MiB | 76 of 1,000 | 7,279 ms | 11,688 ms | 1,062,710 B | 1,062,583 B | 127 B | yes | 1,538 ms | ok |
| 1,000,000 | **append** | 19.0 s | 5,562 MiB | 5,562 MiB | 1,000 of 1,000 | **0.58 ms** | 1.28 ms | **127 B** | 4,096 B | 127 B | yes | 1,145 ms | ok |
| 10,000,000 | append | — | — | — | 0 | — | — | — | — | — | — | — | does not fit before lazy loading (OOM-killed in open) |

The 1M baseline was not rerun: its peak RSS (8.2 GiB) did not fit safely beside the other worker's benchmark. The 140k rerun shows the step 1 numbers hold under this lighter load (1.2 s against 1.1 s per insert).

```text
TSBENCH {"mode":"append","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":13162,"status":"ok","partitions":120,"data_bytes":17780235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":6113.127315,"open_ms":1810.657526,"rss_after_open_mb":781,"rss_resident_after_open_mb":591,"records_loaded":140000,"open_partitions_read":120,"open_bytes_read":17780235,"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":148.911325,"query_median_ms":155.956837,"query_rows":1,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","inserts_done":1000,"insert_median_ms":0.542295,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":148024,"insert_paths_written":1,"insert_p95_ms":0.773996,"insert_min_ms":0.449929,"insert_max_ms":3.8696960000000002,"insert_bytes_written_median":127.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":781}
TSBENCH {"mode":"append","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":13162,"status":"ok","partitions":120,"data_bytes":127005405,"rss_before_open_mb":3,"phase":"done","phase_started_ms":43802.738785,"open_ms":18978.861299999997,"rss_after_open_mb":5562,"rss_resident_after_open_mb":4034,"records_loaded":1000000,"open_partitions_read":120,"open_bytes_read":127005405,"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1504.564352,"query_median_ms":1145.096362,"query_rows":11,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","inserts_done":1000,"insert_median_ms":0.5757155,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":1057831,"insert_paths_written":1,"insert_p95_ms":1.2846909999999998,"insert_min_ms":0.455768,"insert_max_ms":3.34628,"insert_bytes_written_median":127.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":5562}
TSBENCH {"mode":"baseline","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":4555,"status":"ok","partitions":120,"data_bytes":17780235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":186182.780409,"open_ms":2364.481191,"rss_after_open_mb":781,"rss_resident_after_open_mb":591,"records_loaded":140000,"open_partitions_read":120,"open_bytes_read":17780235,"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":190.716378,"query_median_ms":184.846474,"query_rows":1,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","inserts_done":143,"insert_median_ms":1207.942988,"inserts_requested":1000,"insert_budget_secs":180.0,"insert_budget_hit":true,"insert_target":"2025-12.jsonl","insert_target_bytes_before":148024,"insert_paths_written":1,"insert_p95_ms":1667.6945220000002,"insert_min_ms":855.455512,"insert_max_ms":2695.641744,"insert_bytes_written_median":157163.0,"insert_bytes_read_median":157036.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":1137}
```

### Reading step 2

- **Insert cost no longer follows total rows.** The append median is 0.54 ms at 140k and 0.58 ms at 1M (1.07×), against 1.2 s and 7.3 s for the rewrite path: about 2,200× and 12,600× faster. All 1,000 inserts ran in about one second per size.
- **Bytes written equal the line.** Each insert writes 127 bytes: the 126-byte line and its newline. The first append to the rewritten file also writes the missing final newline (128 bytes). File growth equals bytes written, and the earlier bytes of the target file are unchanged ("prefix kept").
- **Bytes read are a constant 4 KiB.** The conflict check reads the file length and its final 4 KiB instead of the whole partition (157 KB and 1.06 MB before).
- **Inserts no longer raise peak RSS.** Peak RSS equals RSS after open (781 MiB and 5,562 MiB). The rewrite path snapshotted every record per insert and peaked at 1,137 MiB and 8,198 MiB.
- **Open and query are unchanged.** Every partition still loads at open and the range query still scans; those are steps 4 and 5. The open-time difference against step 1 is machine load (the 140k rerun opened in 2.4 s).
- **10M: does not fit before lazy loading.** The run was OOM-killed in open. The machine had 9.8 GB available at start and another benchmark was running; the harness guard limit was 8,682 MiB and the child never reported crossing it (see "Harness note"). Step 1 already showed that open alone needs about 54 GiB at 10M (inferred). The size was not reduced and was not retried in this stage.

### Harness note

The RSS guard limit is fixed at start (`MemAvailable` − 1 GiB). On a shared machine other processes can use the remaining memory while the child grows, so the kernel or systemd OOM killer can act before the child's own RSS reaches the limit. That is what happened at 10M: the child printed no abort line. A guard that also checks `MemAvailable` at each poll would abort first. This is left for the lazy-loading stage, which reuses the harness.

## Step 3 time bucket

### Run

Same machine, commit and session as step 2, 23:06–23:07 UTC, one-minute load average 8.5 to 8.7. Command: `./crates/target/release/examples/timeseries_bench --rows 140000,1000000 --years 10 --mode timebucket --inserts 1000`. Memory limit 12,508 MiB. Rows have no `month` field; the partition key is `PartitionKey::TimeBucket { field: "timestamp", bucket: TimeBucket::Month }`, which produces the same 120 file names.

### Results

| Rows | Data | Open | RSS after open (peak) | Peak RSS | Inserts timed | Insert median | Insert p95 | Bytes written / insert | Bytes read / insert | File growth / insert | Prefix kept | 1 h query median | Status |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| 140,000 | 15.3 MB | 1.85 s | 745 MiB | 745 MiB | 1,000 of 1,000 | 0.59 ms | 0.90 ms | 109 B | 4,096 B | 109 B | yes | 156 ms | ok |
| 1,000,000 | 109.0 MB | 16.8 s | 5,312 MiB | 5,312 MiB | 1,000 of 1,000 | 0.56 ms | 0.76 ms | 109 B | 4,096 B | 109 B | yes | 1,201 ms | ok |
| 10,000,000 | — | — | — | — | 0 | — | — | — | — | — | — | — | not run: does not fit before lazy loading (see step 2) |

```text
TSBENCH {"mode":"timebucket","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":12508,"status":"ok","partitions":120,"data_bytes":15260235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":5800.164801,"open_ms":1846.145991,"rss_after_open_mb":745,"rss_resident_after_open_mb":563,"records_loaded":140000,"open_partitions_read":120,"open_bytes_read":15260235,"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":225.263788,"query_median_ms":156.175926,"query_rows":1,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","inserts_done":1000,"insert_median_ms":0.593769,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":127036,"insert_paths_written":1,"insert_p95_ms":0.896194,"insert_min_ms":0.448321,"insert_max_ms":5.292438,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"peak_rss_mb":745}
TSBENCH {"mode":"timebucket","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":12508,"status":"ok","partitions":120,"data_bytes":109005405,"rss_before_open_mb":3,"phase":"done","phase_started_ms":42221.049872,"open_ms":16751.645795,"rss_after_open_mb":5312,"rss_resident_after_open_mb":3846,"records_loaded":1000000,"open_partitions_read":120,"open_bytes_read":109005405,"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1562.248821,"query_median_ms":1200.5893525000001,"query_rows":11,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","inserts_done":1000,"insert_median_ms":0.5554475,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":907891,"insert_paths_written":1,"insert_p95_ms":0.759128,"insert_min_ms":0.474467,"insert_max_ms":4.411359999999999,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"peak_rss_mb":5312}
```

### Reading step 3

- **The redundant field is gone.** Each line is 18 bytes shorter (108 + newline against 126 + newline), so the data is 14% smaller (15.3 MB against 17.8 MB at 140k; 109 MB against 127 MB at 1M).
- **Smaller records use less memory.** RSS after open falls by 4.5% (745 against 781 MiB at 140k; 5,312 against 5,562 MiB at 1M).
- **Routing costs nothing measurable.** The append median stays at about 0.56–0.59 ms; deriving and validating the bucket from the timestamp is not visible next to the file sync.
- Open, query and the 10M limit are unchanged from step 2.

## Step 4 ordered index

`--mode ordered` adds `ordered_indexes: ["timestamp"]`. Steps 2 and 3 are on other branches, so this run is **not cumulative**: it uses the baseline partition key `PartitionKey::Field { month }` with `append_only: true`, which still rewrites the partition at this commit (the TSBENCH line records `"partition_key":"field:month"`). Insert numbers therefore show the rewrite path, not step 2's append. Rerun `--mode ordered` once steps 2 and 3 are merged.

The harness now also times a "newest 100" query (`sort: timestamp desc, limit: 100`) and reads `index_used` and `candidate_rows` from `Database::explain_query`, which shares the executor's planning functions. "Partitions loaded" still counts files read at open (all of them) until step 5.

### Run

| Item | Value |
|---|---|
| Code | branch `ts/index`, runtime at `90e40a9`; harness changes committed with this section |
| Command | `nix develop -c cargo run --release --manifest-path crates/Cargo.toml -p proseql-native --example timeseries_bench -- --mode baseline\|ordered --rows 140000,1000000 --years 10 --insert-budget-secs 120`, then `--mode ordered --rows 10000000` |
| Date | 2026-10-20, 23:05–23:18 UTC |
| Machine | Same as step 1 (i9-11900H, 31 GiB, NVMe, btrfs, Linux 6.18.17, rustc 1.92.0) |
| Machine load | Shared. One-minute load average 11 to 48 during the runs (other sessions were compiling). Baseline and ordered ran consecutively under the same conditions. Treat timings as ±50%; the query ratios are far larger than that. |
| Memory limit | default (`MemAvailable` − 1024 MiB): 13,700 MiB baseline, 13,175 MiB ordered, 10,002 MiB for the 10M run |
| Insert budget | 120 s per size (not 600 s); the index does not change the rewrite cost |

### Results

| Rows | Mode | Open | RSS after open (peak) | Resident after open | 1 h query median | Rows | Index | Candidates | Newest-100 median | Index sorted | Inserts timed | Insert median | Status |
|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---|---:|---:|---|
| 140,000 | baseline | 1.85 s | 781 MiB | 591 MiB | 134 ms | 1 | none | 140,000 | 219 ms | no | 140 | 832 ms | ok |
| 140,000 | ordered | 1.98 s | 805 MiB | 612 MiB | 0.0015 ms | 1 | ordered | 1 | 0.065 ms | yes | 128 | 854 ms | ok |
| 1,000,000 | baseline | 17.0 s | 5,574 MiB | 4,047 MiB | 1,141 ms | 11 | none | 1,000,000 | 2,017 ms | no | 9 | 10,604 ms | ok |
| 1,000,000 | ordered | 19.3 s | 5,744 MiB | 4,217 MiB | 0.021 ms | 11 | ordered | 11 | 0.096 ms | yes | 13 | 9,397 ms | ok |
| 10,000,000 | ordered | did not finish | 10,004 MiB at abort | — | — | — | — | — | — | — | 0 | — | aborted in open after 84.5 s: RSS 10,003 MiB > limit 10,002 MiB |

Machine-readable lines from this run:

```text
TSBENCH {"mode":"baseline","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":13700,"status":"ok","partitions":120,"data_bytes":17780235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":129356.283277,"open_ms":1845.760109,"rss_after_open_mb":781,"rss_resident_after_open_mb":591,"records_loaded":140000,"open_partitions_read":120,"open_bytes_read":17780235,"partition_key":"field:month","ordered_indexes":[],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":139.377058,"query_median_ms":134.03585199999998,"query_rows":1,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","query_candidate_rows":140000,"sorted_query_median_ms":218.8484795,"sorted_query_index_used":"none","sorted_query_index_sorted":false,"inserts_done":140,"insert_median_ms":831.8890645,"inserts_requested":1000,"insert_budget_secs":120.0,"insert_budget_hit":true,"insert_target":"2025-12.jsonl","insert_target_bytes_before":148024,"insert_paths_written":1,"insert_p95_ms":1029.900504,"insert_min_ms":719.18421,"insert_max_ms":1539.1627749999998,"insert_bytes_written_median":156972.5,"insert_bytes_read_median":156845.5,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":1125}
TSBENCH {"mode":"baseline","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":13700,"status":"ok","partitions":120,"data_bytes":127005405,"rss_before_open_mb":3,"phase":"done","phase_started_ms":207847.17451399998,"open_ms":16975.271602,"rss_after_open_mb":5574,"rss_resident_after_open_mb":4047,"records_loaded":1000000,"open_partitions_read":120,"open_bytes_read":127005405,"partition_key":"field:month","ordered_indexes":[],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1395.7555909999999,"query_median_ms":1141.1878225,"query_rows":11,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"none","query_candidate_rows":1000000,"sorted_query_median_ms":2016.551907,"sorted_query_index_used":"none","sorted_query_index_sorted":false,"inserts_done":9,"insert_median_ms":10604.237989,"inserts_requested":1000,"insert_budget_secs":120.0,"insert_budget_hit":true,"insert_target":"2025-12.jsonl","insert_target_bytes_before":1057831,"insert_paths_written":1,"insert_p95_ms":39052.384955,"insert_min_ms":6407.0123490000005,"insert_max_ms":39052.384955,"insert_bytes_written_median":1058470.0,"insert_bytes_read_median":1058340.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":7877}
TSBENCH {"mode":"ordered","rows":10000000,"years":10.0,"seed":20261020,"max_rss_mb":10002,"status":"aborted","partitions":120,"data_bytes":1270055284,"rss_before_open_mb":3,"phase":"open","phase_started_ms":0.30565699999999996,"reason":"rss 10003 MiB exceeded --max-rss-mb 10002","peak_rss_mb":10004,"elapsed_ms":84459.718626,"phase_elapsed_ms":84459.412969}
TSBENCH {"mode":"ordered","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":13175,"status":"ok","partitions":120,"data_bytes":17780235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":123178.652718,"open_ms":1984.749507,"rss_after_open_mb":805,"rss_resident_after_open_mb":612,"records_loaded":140000,"open_partitions_read":120,"open_bytes_read":17780235,"partition_key":"field:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":0.016381,"query_median_ms":0.001475,"query_rows":1,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"ordered","query_candidate_rows":1,"sorted_query_median_ms":0.064944,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":128,"insert_median_ms":853.6053280000001,"inserts_requested":1000,"insert_budget_secs":120.0,"insert_budget_hit":true,"insert_target":"2025-12.jsonl","insert_target_bytes_before":148024,"insert_paths_written":1,"insert_p95_ms":1411.224964,"insert_min_ms":689.81332,"insert_max_ms":1586.868737,"insert_bytes_written_median":156207.0,"insert_bytes_read_median":156078.5,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":1149}
TSBENCH {"mode":"ordered","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":13175,"status":"ok","partitions":120,"data_bytes":127005405,"rss_before_open_mb":3,"phase":"done","phase_started_ms":146894.748766,"open_ms":19287.880048000003,"rss_after_open_mb":5744,"rss_resident_after_open_mb":4217,"records_loaded":1000000,"open_partitions_read":120,"open_bytes_read":127005405,"partition_key":"field:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":121.94348000000001,"query_median_ms":0.0212,"query_rows":11,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"ordered","query_candidate_rows":11,"sorted_query_median_ms":0.096226,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":13,"insert_median_ms":9397.036653000001,"inserts_requested":1000,"insert_budget_secs":120.0,"insert_budget_hit":true,"insert_target":"2025-12.jsonl","insert_target_bytes_before":1057831,"insert_paths_written":1,"insert_p95_ms":13560.217255,"insert_min_ms":6981.264945000001,"insert_max_ms":13560.217255,"insert_bytes_written_median":1058723.0,"insert_bytes_read_median":1058596.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":8369}
```

### Reading step 4

- **The one-hour range query no longer scans.** It visits only the matching rows (`candidate_rows` = rows returned: 1 and 11). The median falls from 134 ms to 1.5 µs at 140k and from 1,141 ms to 21 µs at 1M. Query time now follows the number of matching rows, not total history.
- **Newest-first pages read the index in order.** The newest 100 samples take 65 µs at 140k and 96 µs at 1M, against 219 ms and 2,017 ms when the engine clones and sorts every row.
- **First query at 1M: 122 ms.** Later repetitions take 21 µs. The baseline shows the same first-run penalty (1,396 ms against a 1,141 ms median). The machine had about 15 GiB of swap in use, so the likely cause is paging the freshly loaded state back in (inferred, not measured).
- **Memory cost is about 175 bytes per row.** RSS after open rises by 24 MiB at 140k and 170 MiB at 1M (resident: 21 MiB and 170 MiB). That is about 2% to 3% on top of today's in-memory collection.
- **Open cost is the index build.** Open takes 7% (140k) to 14% (1M) longer; both are within the noise of this machine.
- **Inserts are unchanged.** Index maintenance is logarithmic. The insert time is still dominated by the partition rewrite (step 2 removes that).
- **10M rows still do not fit.** Open stopped at the 10 GiB limit after 85 s, as at baseline. The ordered index cannot change that; step 5 (lazy partitions) must load only the partitions a query touches. The acceptance check (`partitions_loaded = 1`, `index_used = ordered`, time ≤ 2× at 10M) therefore waits for step 5. `index_used = ordered` is already reported, and the query cost per matching row does not depend on history size.

## Step 5 lazy

`--mode lazy` is cumulative: append-only with `duplicate_ids: ignore_identical`, `PartitionKey::TimeBucket { timestamp, Month }`, `ordered_indexes: ["timestamp"]`, and `lazy_partitions` with `LazyPartitionPolicy { max_loaded_partitions: 4, full_scan: FullScanPolicy::Error }`. Every timed operation must therefore prune. Queries run through `NativeRuntime::query`; `partitions_loaded` and `index_used` come from `NativeRuntime::query_with_stats`. Under `full_scan: Error` the unfiltered newest-100 query would fail, so in lazy mode it is limited to the last month (`timestamp >= 2025-12-01T00:00:00.000Z`; it loads one partition). After the 1,000 appends the child closes, reopens and times one more append into the then unloaded target partition ("cold append").

`--mode ordered` was rerun on this branch and is now cumulative (append + time bucket + ordered index, all partitions loaded at open), so step 4 has a row that differs from step 3 only by the index. No eager mode was run at 10M rows: eager open needs about 54 GiB at that size (step 1, inferred), more than this 31 GiB shared machine.

### Run

| Item | Value |
|---|---|
| Code | branch `ts/lazy`, commit `6d29c55` (runtime last changed in `03d0dbc`, where `NativeRuntime::query` stopped computing stats) |
| Commands | `./crates/target/release/examples/timeseries_bench --rows 140000,1000000,10000000 --years 10 --mode lazy --inserts 1000` (equal to `just bench-timeseries`), then `--rows 140000,1000000 --mode ordered --inserts 1000` (release build, inside `nix develop`) |
| Date | 2026-10-21, 00:30–00:32 UTC; an earlier lazy run at 00:28 UTC (harness `03d0dbc`, no one-slot query) is listed as a repeat |
| Machine | Same as step 1 (i9-11900H, 31 GiB, NVMe, btrfs, Linux 6.18.17, rustc 1.92.0) |
| Machine load | Shared. One-minute load average 26 to 40 during the runs, 13.8 to 15.4 GiB swap in use, 9.8 to 11.6 GiB `MemAvailable` at start. Treat timings as ±50%. |
| Memory guard | `--max-rss-mb` default (8,797 MiB lazy, 9,183 MiB ordered), `--min-available-mb 1024`. No size aborted. |

### Results

| Rows | Mode | Open | RSS after open (peak) | Peak RSS | Appends timed | Append median | Append p95 | Bytes written / append | Bytes read / append | Prefix kept | 1 h query median | Rows | Partitions loaded | Index | One-slot query median | First 1 h query (loads) | Cold append | Cold append bytes read | Status |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|---:|---:|---:|---:|---|
| 140,000 | ordered (cumulative) | 4.05 s | 769 MiB | 769 MiB | 1,000 of 1,000 | 0.79 ms | 2.46 ms | 109 B | 4,096 B | yes | 0.0035 ms | 1 | 120 | ordered | 0.0038 ms | 0.028 ms | — | — | ok |
| 1,000,000 | ordered (cumulative) | 24.2 s | 5,482 MiB | 5,482 MiB | 1,000 of 1,000 | 0.54 ms | 0.75 ms | 109 B | 4,096 B | yes | 0.015 ms | 11 | 120 | ordered | 0.0031 ms | 119 ms | — | — | ok |
| 140,000 | **lazy** | 10.6 ms | 5 MiB | 11 MiB | 1,000 of 1,000 | 0.78 ms | 2.52 ms | 109 B | 4,096 B | yes | 0.0090 ms | 1 | 1 | ordered | 0.0085 ms | 49 ms | 28 ms | 240,107 B | ok |
| 1,000,000 | **lazy** | 3.5 ms | 5 MiB | 36 MiB | 1,000 of 1,000 | 0.82 ms | 3.23 ms | 109 B | 4,096 B | yes | 0.031 ms | 11 | 1 | ordered | 0.0091 ms | 124 ms | 114 ms | 1,020,962 B | ok |
| 10,000,000 | **lazy** | 3.6 ms | 5 MiB | 324 MiB | 1,000 of 1,000 | 0.85 ms | 3.11 ms | 109 B | 4,096 B | yes | 0.287 ms | 114 | 1 | ordered | 0.0083 ms | 1,366 ms | 1,238 ms | 9,193,196 B | ok |
| 140,000 | lazy (repeat) | 3.4 ms | 5 MiB | 11 MiB | 1,000 of 1,000 | 1.02 ms | 5.28 ms | 109 B | 4,096 B | yes | 0.0089 ms | 1 | 1 | ordered | — | 17 ms | 38 ms | 240,107 B | ok |
| 1,000,000 | lazy (repeat) | 2.9 ms | 5 MiB | 36 MiB | 1,000 of 1,000 | 0.86 ms | 4.13 ms | 109 B | 4,096 B | yes | 0.030 ms | 11 | 1 | ordered | — | 164 ms | 116 ms | 1,020,962 B | ok |
| 10,000,000 | lazy (repeat) | 3.8 ms | 5 MiB | 326 MiB | 1,000 of 1,000 | 0.85 ms | 3.88 ms | 109 B | 4,096 B | yes | 0.314 ms | 114 | 1 | ordered | — | 1,402 ms | 1,170 ms | 9,193,196 B | ok |

The newest-100 query (last month, sorted by `timestamp` descending) took 0.16, 0.17 and 0.20 ms in lazy mode at 140k, 1M and 10M, with `index_used = ordered`, the sort read from the index, and one partition loaded.

Machine-readable lines from this run:

```text
TSBENCH {"mode":"lazy","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":8797,"min_available_mb":1024,"mem_available_at_start_mb":9821,"status":"ok","partitions":120,"data_bytes":15260235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":1217.634812,"open_ms":10.643326,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":49.387951,"query_median_ms":0.0090405,"query_rows":1,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":1,"slot_query_window_ms":2254068,"slot_query_median_ms":0.008544,"slot_query_rows":1,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.158225,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.7836885,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":127036,"insert_paths_written":1,"insert_first_ms":1.182362,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":2.518462,"insert_min_ms":0.603293,"insert_max_ms":15.96754,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":2.8173619999999997,"cold_append_ms":27.812267000000002,"cold_append_bytes_read":240107,"cold_append_bytes_written":109,"peak_rss_mb":11}
TSBENCH {"mode":"lazy","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":8797,"min_available_mb":1024,"mem_available_at_start_mb":9858,"status":"ok","partitions":120,"data_bytes":109005405,"rss_before_open_mb":3,"phase":"done","phase_started_ms":1771.249694,"open_ms":3.478918,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":123.852454,"query_median_ms":0.030655500000000002,"query_rows":11,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":11,"slot_query_window_ms":315569,"slot_query_median_ms":0.0090675,"slot_query_rows":1,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.170447,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.822058,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":907891,"insert_paths_written":1,"insert_first_ms":5.523532,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":3.2316010000000004,"insert_min_ms":0.6768409999999999,"insert_max_ms":21.735774,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":2.821935,"cold_append_ms":113.688772,"cold_append_bytes_read":1020962,"cold_append_bytes_written":109,"peak_rss_mb":36}
TSBENCH {"mode":"lazy","rows":10000000,"years":10.0,"seed":20261020,"max_rss_mb":8797,"min_available_mb":1024,"mem_available_at_start_mb":9857,"status":"ok","partitions":120,"data_bytes":1090055284,"rss_before_open_mb":3,"phase":"done","phase_started_ms":5807.471158,"open_ms":3.5742920000000002,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1366.443949,"query_median_ms":0.286784,"query_rows":114,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":114,"slot_query_window_ms":31556,"slot_query_median_ms":0.0083315,"slot_query_rows":1,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.19782100000000002,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.847491,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":9080125,"insert_paths_written":1,"insert_first_ms":19.473419,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":3.108592,"insert_min_ms":0.662242,"insert_max_ms":19.473419,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":2.882386,"cold_append_ms":1237.546057,"cold_append_bytes_read":9193196,"cold_append_bytes_written":109,"peak_rss_mb":324}
TSBENCH {"mode":"lazy","rows":10000000,"years":10.0,"seed":20261020,"max_rss_mb":8797,"min_available_mb":1024,"mem_available_at_start_mb":9857,"status":"ok","partitions":120,"data_bytes":1090055284,"rss_before_open_mb":3,"phase":"done","phase_started_ms":5807.471158,"open_ms":3.5742920000000002,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1366.443949,"query_median_ms":0.286784,"query_rows":114,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":114,"slot_query_window_ms":31556,"slot_query_median_ms":0.0083315,"slot_query_rows":1,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.19782100000000002,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.847491,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":9080125,"insert_paths_written":1,"insert_first_ms":19.473419,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":3.108592,"insert_min_ms":0.662242,"insert_max_ms":19.473419,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":2.882386,"cold_append_ms":1237.546057,"cold_append_bytes_read":9193196,"cold_append_bytes_written":109,"peak_rss_mb":324}
TSBENCH {"mode":"ordered","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":9183,"min_available_mb":1024,"mem_available_at_start_mb":10207,"status":"ok","partitions":120,"data_bytes":15260235,"rss_before_open_mb":4,"phase":"done","phase_started_ms":5206.486369,"open_ms":4052.3369799999996,"rss_after_open_mb":769,"rss_resident_after_open_mb":585,"records_loaded":140000,"open_partitions_read":120,"open_bytes_read":15260235,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":0.028293000000000002,"query_median_ms":0.0034505,"query_rows":1,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"ordered","query_candidate_rows":1,"slot_query_window_ms":2254068,"slot_query_median_ms":0.0038015,"slot_query_rows":1,"sorted_query_filter":null,"sorted_query_partitions_loaded":120,"sorted_query_median_ms":0.15438649999999998,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.7906435,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":127036,"insert_paths_written":1,"insert_first_ms":63.31652999999999,"insert_first_bytes_read":4096.0,"insert_p95_ms":2.462402,"insert_min_ms":0.6543570000000001,"insert_max_ms":63.31652999999999,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"peak_rss_mb":769}
TSBENCH {"mode":"ordered","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":9183,"min_available_mb":1024,"mem_available_at_start_mb":11570,"status":"ok","partitions":120,"data_bytes":109005405,"rss_before_open_mb":3,"phase":"done","phase_started_ms":25168.354047,"open_ms":24209.282779999998,"rss_after_open_mb":5482,"rss_resident_after_open_mb":4016,"records_loaded":1000000,"open_partitions_read":120,"open_bytes_read":109005405,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":119.270976,"query_median_ms":0.015091,"query_rows":11,"query_partitions_loaded":120,"query_partition_reads":0,"query_index_used":"ordered","query_candidate_rows":11,"slot_query_window_ms":315569,"slot_query_median_ms":0.0031375,"slot_query_rows":1,"sorted_query_filter":null,"sorted_query_partitions_loaded":120,"sorted_query_median_ms":0.076697,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.5352085,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":907891,"insert_paths_written":1,"insert_first_ms":1.746436,"insert_first_bytes_read":4096.0,"insert_p95_ms":0.754367,"insert_min_ms":0.44931099999999996,"insert_max_ms":2.721412,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"peak_rss_mb":5482}
```

Repeat run (harness `03d0dbc`):

```text
TSBENCH {"mode":"lazy","rows":140000,"years":10.0,"seed":20261020,"max_rss_mb":10636,"min_available_mb":1024,"mem_available_at_start_mb":11656,"status":"ok","partitions":120,"data_bytes":15260235,"rss_before_open_mb":3,"phase":"done","phase_started_ms":1904.029264,"open_ms":3.384592,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":16.89875,"query_median_ms":0.0089135,"query_rows":1,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":1,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.12318749999999999,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":1.0175015,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":127036,"insert_paths_written":1,"insert_first_ms":4.489044,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":5.279181,"insert_min_ms":0.571159,"insert_max_ms":27.840704000000002,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":3.533452,"cold_append_ms":37.901347,"cold_append_bytes_read":240107,"cold_append_bytes_written":109,"peak_rss_mb":11}
TSBENCH {"mode":"lazy","rows":1000000,"years":10.0,"seed":20261020,"max_rss_mb":10636,"min_available_mb":1024,"mem_available_at_start_mb":11475,"status":"ok","partitions":120,"data_bytes":109005405,"rss_before_open_mb":4,"phase":"done","phase_started_ms":1967.538706,"open_ms":2.88957,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":163.531047,"query_median_ms":0.03032,"query_rows":11,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":11,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.149198,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.8604465,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":907891,"insert_paths_written":1,"insert_first_ms":2.922113,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":4.128115,"insert_min_ms":0.667753,"insert_max_ms":13.938116,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":4.902309,"cold_append_ms":116.395108,"cold_append_bytes_read":1020962,"cold_append_bytes_written":109,"peak_rss_mb":36}
TSBENCH {"mode":"lazy","rows":10000000,"years":10.0,"seed":20261020,"max_rss_mb":10636,"min_available_mb":1024,"mem_available_at_start_mb":10140,"status":"ok","partitions":120,"data_bytes":1090055284,"rss_before_open_mb":3,"phase":"done","phase_started_ms":6024.57901,"open_ms":3.7674000000000003,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1401.7492869999999,"query_median_ms":0.31357,"query_rows":114,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":114,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.214454,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.8471865000000001,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":9080125,"insert_paths_written":1,"insert_first_ms":10.198573000000001,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":3.880769,"insert_min_ms":0.650832,"insert_max_ms":17.050276,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":2.593163,"cold_append_ms":1170.170612,"cold_append_bytes_read":9193196,"cold_append_bytes_written":109,"peak_rss_mb":326}
TSBENCH {"mode":"lazy","rows":10000000,"years":10.0,"seed":20261020,"max_rss_mb":10636,"min_available_mb":1024,"mem_available_at_start_mb":10140,"status":"ok","partitions":120,"data_bytes":1090055284,"rss_before_open_mb":3,"phase":"done","phase_started_ms":6024.57901,"open_ms":3.7674000000000003,"rss_after_open_mb":5,"rss_resident_after_open_mb":5,"records_loaded":0,"open_partitions_read":0,"open_bytes_read":0,"partition_key":"time_bucket:timestamp:month","ordered_indexes":["timestamp"],"query_from":"2020-12-31T05:00:00.000Z","query_reps":20,"query_first_ms":1401.7492869999999,"query_median_ms":0.31357,"query_rows":114,"query_partitions_loaded":1,"query_partition_reads":1,"query_index_used":"ordered","query_candidate_rows":114,"sorted_query_filter":{"timestamp":{"$gte":"2025-12-01T00:00:00.000Z"}},"sorted_query_partitions_loaded":1,"sorted_query_median_ms":0.214454,"sorted_query_index_used":"ordered","sorted_query_index_sorted":true,"inserts_done":1000,"insert_median_ms":0.8471865000000001,"inserts_requested":1000,"insert_budget_secs":600.0,"insert_budget_hit":false,"insert_target":"2025-12.jsonl","insert_target_bytes_before":9080125,"insert_paths_written":1,"insert_first_ms":10.198573000000001,"insert_first_bytes_read":4096.0,"partitions_resident_at_end":2,"insert_p95_ms":3.880769,"insert_min_ms":0.650832,"insert_max_ms":17.050276,"insert_bytes_written_median":109.0,"insert_bytes_read_median":4096.0,"insert_file_growth_median":109.0,"insert_line_bytes_median":109.0,"insert_prefix_preserved":true,"reopen_ms":2.593163,"cold_append_ms":1170.170612,"cold_append_bytes_read":9193196,"cold_append_bytes_written":109,"peak_rss_mb":326}
```

### Acceptance (contract section 6, 10M against 140k rows, lazy mode)

| Target | 140k | 10M | Ratio | Result |
|---|---:|---:|---:|---|
| Open time ≤ 2× | 10.6 ms (repeat 3.4 ms) | 3.6 ms (repeat 3.8 ms) | 0.34× (repeat 1.11×) | met |
| RSS after open ≤ 2× | 5 MiB | 5 MiB | 1.0× | met |
| Append median over 1,000 appends ≤ 2× | 0.78 ms | 0.85 ms | 1.08× (repeat 0.83×) | met |
| Bytes written = line length; earlier bytes unchanged | 109 B = 109 B; prefix kept | 109 B = 109 B; prefix kept | — | met |
| One-hour query: `partitions_loaded = 1` | 1 | 1 | — | met |
| One-hour query: `index_used = ordered` | ordered | ordered | — | met |
| One-hour query time ≤ 2× | 0.0090 ms | 0.287 ms | **31.7×** (repeat 35.2×) | **not met** |

The handoff's own definition of done for this query ("reads only one partition and uses the ordered index") is met; the ≤ 2× time bound is an addition of the approved contract, and that bound is the target missed here.

### Reading step 5

- **Open no longer grows with history.** Open lists 120 file names and decodes nothing: 3 to 11 ms and 5 MiB at every size (eager: 4.1 s and 769 MiB at 140k, 24 s and 5.5 GiB at 1M).
- **Appends cost the same at every size.** The median stays at 0.8 ms, each append writes exactly its 109-byte line, reads the 4 KiB conflict-check tail, and leaves the earlier bytes unchanged. The target partition was already loaded by the newest-100 query, so the timed appends include no partition load.
- **The first append into an unloaded partition loads it.** The ID check (and the `ignore_identical` comparison) needs the target partition, so a cold append reads and decodes it once: 28 ms (240 KB) at 140k, 114 ms (1.0 MB) at 1M, 1.2 s (9.2 MB) at 10M. A create into a partition file that does not exist reads nothing. With one-minute samples a month is about 44,000 rows, so a cold append there would cost roughly half the 10M figure (inferred).
- **The one-hour query reads one partition through the ordered index, but its time follows the rows it returns.** Ten years of data in 140k rows put about 1 sample in the hour; 10M rows put 114 there. The query costs about 8 to 9 µs plus 2.2 to 2.5 µs per returned row in lazy mode (1M: 11 rows in 31 µs; 10M: 114 rows in 287 µs), so the target is missed: 31.7× against at most 2×. The one-slot window, which returns one row at every size, takes 8.5, 9.1 and 8.3 µs (0.98× at 10M against 140k): the cost does not depend on history size, only on the result size. The target is not reachable for a fixed one-hour window while the engine returns owned rows: 114 rows within 2 × 9 µs would need about 160 ns per row, below the cost of copying one record.
- **The first query on a partition pays its load.** 49 ms, 124 ms and 1.4 s at 140k, 1M and 10M (one partition of about 1,200, 8,300 and 83,000 rows).
- **Lazy adds about 5 µs per query.** The eager cumulative run answers the one-slot query in 3.1 to 3.8 µs; lazy needs 8.3 to 9.1 µs for pruning (120 keys), loading checks and eviction.
- **Peak memory follows the loaded partitions.** Two partitions were loaded at the end (the queried month and the append month): 11 MiB at 140k, 36 MiB at 1M and 324 MiB at 10M, about 2 KB per loaded row. This is not bounded by history, but it grows with partition size; choose the bucket accordingly.
- **The ordered index costs nothing at append time.** Cumulative `ordered` appends take 0.79 and 0.54 ms, as in steps 2 and 3.

## Before and after

One row per step and size. Steps 1–3 come from their sections above (steps 2 and 3 on branch `ts/append`). Step 4 has two rows: the run on `ts/index` without steps 2 and 3 (rewrite path, `month` field key) and the cumulative rerun on this branch. Step 5 is lazy mode from this section. Timings are medians; machine load differed between runs (see each section), so treat timings as ±50%.

| Step | Rows | Open | Peak RSS | Append median | Bytes written / append | 1 h query median | Partitions loaded | Index used |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 baseline | 140,000 | 4.50 s | 1,124 MiB | 1,071 ms | 179,509 B | 170 ms | 120 | none |
| 1 baseline | 1,000,000 | 27.2 s | 8,198 MiB | 7,279 ms | 1,062,710 B | 1,538 ms | 120 | none |
| 1 baseline | 10,000,000 | did not finish (aborted in open at 15.3 GiB) | — | — | — | — | — | — |
| 2 append | 140,000 | 1.81 s | 781 MiB | 0.54 ms | 127 B | 156 ms | 120 | none |
| 2 append | 1,000,000 | 19.0 s | 5,562 MiB | 0.58 ms | 127 B | 1,145 ms | 120 | none |
| 2 append | 10,000,000 | did not finish (OOM-killed in open) | — | — | — | — | — | — |
| 3 time bucket | 140,000 | 1.85 s | 745 MiB | 0.59 ms | 109 B | 156 ms | 120 | none |
| 3 time bucket | 1,000,000 | 16.8 s | 5,312 MiB | 0.56 ms | 109 B | 1,201 ms | 120 | none |
| 3 time bucket | 10,000,000 | not run (does not fit eagerly) | — | — | — | — | — | — |
| 4 ordered (`ts/index`, not cumulative) | 140,000 | 1.98 s | 1,149 MiB | 854 ms | 156,207 B | 0.0015 ms | 120 | ordered |
| 4 ordered (`ts/index`, not cumulative) | 1,000,000 | 19.3 s | 8,369 MiB | 9,397 ms | 1,058,723 B | 0.021 ms | 120 | ordered |
| 4 ordered (`ts/index`, not cumulative) | 10,000,000 | did not finish (aborted in open at 10.0 GiB) | — | — | — | — | — | — |
| 4 ordered (cumulative) | 140,000 | 4.05 s | 769 MiB | 0.79 ms | 109 B | 0.0035 ms | 120 | ordered |
| 4 ordered (cumulative) | 1,000,000 | 24.2 s | 5,482 MiB | 0.54 ms | 109 B | 0.015 ms | 120 | ordered |
| 4 ordered (cumulative) | 10,000,000 | not run (eager open needs about 54 GiB, inferred) | — | — | — | — | — | — |
| 5 lazy | 140,000 | 10.6 ms | 11 MiB | 0.78 ms | 109 B | 0.0090 ms | 1 | ordered |
| 5 lazy | 1,000,000 | 3.5 ms | 36 MiB | 0.82 ms | 109 B | 0.031 ms | 1 | ordered |
| 5 lazy | 10,000,000 | 3.6 ms | 324 MiB | 0.85 ms | 109 B | 0.287 ms | 1 | ordered |

"Peak RSS" is `VmHWM` at the end of the size (open, queries and appends). In eager modes "partitions loaded" counts the files loaded at open. The 1 h query returns 1, 11 and 114 rows at 140k, 1M and 10M in every mode.
