# Time-series benchmark

This file records the native time-series benchmark before and after each step of `openspec/changes/native-timeseries/`. All data is synthetic. No personal data is read, copied or quoted.

## How to run

```sh
just bench-timeseries            # --rows 140000,1000000,10000000 --years 10
just bench-timeseries --mode baseline --inserts 1000 --insert-budget-secs 600
```

The recipe runs:

```sh
cargo run --release --manifest-path crates/Cargo.toml -p proseql-native \
  --example timeseries_bench -- --rows 140000,1000000,10000000 --years 10
```

Later flags override earlier ones. Run `--help` for every option.

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
- **Range query**: `timestamp >= A and timestamp < A + 1h`, with `A` the hour at the middle of the span. Median of `--query-reps` (default 20) runs through `runtime.read(|db| db.query(..))`. "Partitions loaded" is the number of partition files resident when the query runs. "Index" is the index the planner used.
- **Insert**: one `runtime.mutate(|db| db.create(..))` per sample, timestamps after the last generated row and inside the last month, so every insert targets an existing full-size partition. Up to `--inserts` (default 1,000), stopping after `--insert-budget-secs` (default 600 s per size). "Bytes written" and "bytes read" are counted at the storage host for each insert. "File growth" is the size change of the target file. "Prefix kept" checks that the final target file starts with its original bytes.
- **Memory guard**: a watchdog thread polls `VmRSS` every 10 ms. Above `--max-rss-mb` (default: `MemAvailable` − 1024 MiB at start) the child prints its partial numbers with `"status":"aborted"` and exits, so a size that does not fit never drives the machine into swap or the OOM killer.
- **Output**: one `TSBENCH {json}` line per size, then a Markdown table.
- **Modes**: `--mode baseline|append|timebucket|ordered|lazy` selects cumulative feature sets. `append` sets `append_only: true` (it still rewrites at this commit). `timebucket` and `lazy` fail before generating data until their step adds the configuration. `ordered` adds `ordered_indexes: ["timestamp"]`; until step 3 is on the same branch it keeps the `month` field key and records `"partition_key":"field:month"`. Each step removes its check in `require_supported` and wires the feature into `runtime_config`, `runtime_options` and `query_stats`.

## Step 1 baseline (commit 0e3666a)

### Run

| Item | Value |
|---|---|
| Runtime code | `0e3666a` (unchanged); harness from branch `ts/bench` commit `f28910c` |
| Command | `nix develop -c just bench-timeseries` (defaults: `--mode baseline --inserts 1000 --insert-budget-secs 600 --query-reps 20 --seed 20261020`) |
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

Command: `nix develop -c just bench-timeseries --rows 140000 --years 0.66 --start 2026-01-01 --insert-budget-secs 300`, 20:22–20:28 UTC, one-minute load average 4.8 to 5.4, same machine and commit.

| Rows | Partitions | Open | RSS after open (peak) | Peak RSS | Inserts timed | Insert median | Insert p95 | Bytes written / insert | File growth / insert | Prefix kept | 1 h query median | Rows returned | Partitions loaded | Index |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|
| 140,000 | 8 | 2.19 s | 779 MiB | 1,160 MiB | 319 of 1,000 (budget) | 930 ms | 1,097 ms | 2,163,511 B | 127 B | yes | 138 ms | 24 | 8 | none |

```text
TSBENCH {"mode":"baseline","rows":140000,"years":0.66,"seed":20261020,"max_rss_mb":20714,"status":"ok","partitions":8,"data_bytes":17780347,"rss_before_open_mb":3,"phase":"done","phase_started_ms":305238.209787,"open_ms":2188.995914,"rss_after_open_mb":779,"rss_resident_after_open_mb":589,"records_loaded":140000,"open_partitions_read":8,"open_bytes_read":17780347,"query_from":"2026-05-01T12:00:00.000Z","query_reps":20,"query_first_ms":146.355777,"query_median_ms":137.8083475,"query_rows":24,"query_partitions_loaded":8,"query_partition_reads":0,"query_index_used":"none","inserts_done":319,"insert_median_ms":930.146397,"inserts_requested":1000,"insert_budget_secs":300.0,"insert_budget_hit":true,"insert_target":"2026-08.jsonl","insert_target_bytes_before":2143195,"insert_paths_written":1,"insert_p95_ms":1097.388407,"insert_min_ms":741.3771820000001,"insert_max_ms":1262.543862,"insert_bytes_written_median":2163511.0,"insert_bytes_read_median":2163385.0,"insert_file_growth_median":127.0,"insert_line_bytes_median":127.0,"insert_prefix_preserved":true,"peak_rss_mb":1160}
```

With the same 140k rows in 8 partitions of about 2.1 MB instead of 120 partitions of about 150 KB, an insert costs about the same (930 ms against 1,071 ms) while it writes 12× more bytes. This supports the reading above: at baseline, insert cost follows total rows, and the partition rewrite is the smaller part.

## Step 2 append

Not run yet. Run `just bench-timeseries --mode append` and add the results here, with a baseline rerun under the same machine load.

## Step 3 time bucket

Not run yet. Run `just bench-timeseries --mode timebucket`.

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
| Machine load | Shared. One-minute load average 11 to 48 during the runs (other sessions were compiling). Baseline and ordered ran back to back under the same conditions. Treat timings as ±50%; the query ratios are far larger than that. |
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

Not run yet. Run `just bench-timeseries --mode lazy`. Acceptance at 10M versus 140k rows: lazy open time and RSS ≤ 2×; append median over 1,000 appends ≤ 2×, bytes written = line length, earlier file bytes unchanged; one-hour query with `partitions_loaded = 1`, `index_used = ordered`, time ≤ 2×.
