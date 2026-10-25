# SQLite baseline and streaming spike: Stage 0 (#13)

Stage 0 measures the bar. It does **not** authorize or implement a production rewrite. The decision gate is user approval of the plan below.

## Contract and evidence

Contracts: [epic #12](https://github.com/simonwjackson/proseql/issues/12), [Stage 0 #13](https://github.com/simonwjackson/proseql/issues/13), and the Logbook source brief dated 2026-10-24. Read both issues in full, including comments. The later machine rules supersede all older zao/rakku instructions.

Production baseline: `61c4322e87df90c76daa4a4798556a55c7214151`. No production Rust or TypeScript source changes. The standalone benchmark links the native engine by path, with its existing dependency versions retained from `crates/Cargo.lock`. The [baseline file manifest](../../bench/stage0/baseline-files.sha256) checks every tracked file under `crates/` before building. The [OpenSpec change](../../openspec/changes/query-while-scanning/proposal.md) records scope and approval boundaries.

Reproduce with `nix run --builders '' .#bench-stage0` **on yari only**, from a committed checkout. See the [harness method and costs](../../bench/stage0/README.md). All source edits and commits are on zao. All benchmark builds, checks and measurements are on yari. No connection, copy or measurement on rakku. The initial devshell acquisition used yari's configured aarch64 fuji builder for tool dependencies; the parent approved this and requested local-only builds thereafter. Every later Nix invocation disables builders; substituter downloads remain enabled.

## Method

Machine: yari, aarch64 Ampere Neoverse N1, 4 vCPU, about 23 GiB RAM, Linux 6.18.53, btrfs-backed `/home`. This host also runs Forgerie. Measurements use nice 10, `MemoryMax=1G`, `MemorySwapMax=0` and explicit timeouts. Data is under `/home/simon/work/proseql-stage0-data`, not tmpfs. Instructions are measured: the requested `perf stat -e instructions:u true` succeeds; operation-only counters use Linux `perf_event_open`.

January–October 2025 provides **656,640 samples**: steps every minute and heartRate every second minute. The 11-field consumer fixture adapts the existing lazy-memory generator, with long IDs, nullable end, UTC time and UTC date. A second collection stores the same logical samples plus a deterministic hash-shard field in 256 JSONL files. This is a synthetic raw-shaped collection, not an assertion about an uninspected private raw payload schema. Monthly samples use `TimeBucket::Month`, ordered `atUtc`, append-only, identical-duplicate handling and `max_loaded_partitions=1`; raw uses a shard field, ordered `atUtc` and the same policy.

SQLite 3.51.1 imports the exact logical records into typed columns, not a JSON blob plus duplicated query columns. Each table has a TEXT primary key and a non-covering `(metric,time)` index. Actual PRAGMAs are WAL, synchronous=1 (NORMAL), cache_size=-2000, page_size=4096, mmap_size=0, temp_store=0. These are recorded in `prepare.json`. No precomputed totals or covering aggregate index. A bounded k-way merge imports both shapes in chronological ingestion order, giving SQLite normal append locality rather than clustering its raw table by the text export's hash shard. SQLite temporary files are forced under the owned `/home/simon` data directory. Raw point queries supply a known shard to text implementations; sample point queries supply only the ID.

Native reads use `query_bounded` / `aggregate_grouped_bounded`, as in the consumer's bounded path. Point uses a bounded ID-filter query, not the separate `find_by_id` cache-miss path that loads its full scope before trimming (source inspection only). Read timing excludes open and includes input construction and answer construction/consumption. Warm reads prime the same operation on the same backend; cold reads open a new backend after owned-file eviction. Warm append primes file pages only, never a mutating call. Every append trial starts from independent identical bytes. The headline append requests **1,000 genuinely new rows**; each implementation checks every ID for a duplicate before the write, and the driver verifies that exactly 1,000 new rows persist. Native appears twice: "native as shipped" (`create_many` alone, which checks only loaded/routed partitions) and "native + global preflight" (one public `query_bounded` `id $in` scan of every partition, then `create_many`). The preflight exists only in this benchmark. It is a scan, not a membership structure, and it does not fix the production gap tracked in #16; it is also not atomic with the write. SQLite checks each ID with its primary-key B-tree; the spike scans every file. The earlier batch of 900 new rows plus 100 exact duplicates stays as a labelled supplement for the rejection path. The read matrix and the supplement use binaries built at `03d0cb0`; the strict append cells use binaries built at `4d2937b` (no read-path source change between them) and the driver at `cb0f9f3`. Open constructs metadata; idle is a one-second observation interval after open, not an active operation cost. Each backend remains open for the post-query one-second RSS sample, with no trim or session teardown.

An initial partial matrix was stopped and excluded: SQLite temporary-file placement had not been constrained, its raw import followed shard order, and the scanner still allocated owned aggregate keys per row. The final matrix starts from a newly generated fixture, fixes all three, and retains the initial evidence separately rather than mixing revisions.

Three timing/RSS trials rotate implementation order. A separate counting-allocator trial reports Rust requested heap and SQLite C allocator bytes separately. RSS peak resets immediately before the timed operation, after warm-up. File cache is owned-file `mincore` residency before process launch and after process exit, not system-wide Cached, and not memory to add blindly to RSS. Warm trials prewarm the whole backend file set: SQLite's database contains both shapes, but the text set is the selected collection. Warm cache columns therefore describe the chosen prewarm history, not each query's minimum working set. Cold-after cache is touched source pages plus readahead. Temporary SQLite sorter-file cache during the query is not captured by the post-exit source-file probe. `DONTNEED` cannot evict a hypervisor/disk-controller cache or inode/directory metadata. See the harness README for precise timing and ownership boundaries.

## Results on yari

Short answer: ProseQL at `61c4322` misses every speed and peak-memory target on yari; only open and idle memory pass. The level-1 spike (borrowed scalar scan, pushed-down filters and folds, sparse time index) meets the ten-month, 1-hour, peak-memory, open/idle-memory and back-to-idle targets on the month-partitioned `samples` shape. It misses point lookup (no ID index), append (global duplicate scan), one-month warm by 4 %, and the range reads on the 256-shard `raw` shape. All numbers below are measured on yari; nothing is extrapolated to rakku.

### Key rows (wall ms, median of 3, cold / warm)

| Workload | Shape | SQLite | ProseQL `61c4322` | Spike |
|---|---|---:|---:|---:|
| Point by ID | samples | 3.90 / 0.04 | 8,237.02 / 7,980.46 | 513.37 / 365.16 |
| Point by ID | raw | 4.76 / 0.04 | 29.05 / 0.59 | 3.88 / 1.52 |
| 1-hour range | samples | 5.33 / 0.58 | 847.51 / 0.74 | 1.40 / 0.45 |
| 1-hour range | raw | 5.50 / 0.61 | 8,019.41 / 7,938.65 | 372.63 / 32.35 |
| One month by day | samples | 83.20 / 38.41 | 1,614.55 / 935.97 | 50.67 / 40.08 |
| One month by day | raw | 90.27 / 37.77 | 8,037.64 / 8,118.50 | 427.10 / 73.45 |
| Ten months by day, 2 metrics | samples | 889.31 / 617.95 | 9,299.86 / 9,042.32 | 530.87 / 418.63 |
| Ten months by day, 2 metrics | raw | 878.66 / 607.81 | 8,645.52 / 8,723.05 | 962.92 / 439.50 |
| Append 1,000 new rows (headline) | samples | 27.94 / 16.33 | shipped 788.37 / 755.20; + global preflight 13,235.44 / 13,271.75 | 714.86 / 617.67 |
| Append 1,000 new rows (headline) | raw | 30.41 / 17.25 | shipped OOM-killed; + global preflight OOM-killed | 2,365.41 / 1,729.07 |
| Open | samples / raw | 1.47 / 0.24; 1.67 / 0.24 | 0.48 / 0.27; 3.85 / 3.67 | 6.41 / 0.39; 4.13 / 1.67 |
| Idle steady RSS (MiB) | samples / raw | 5.23 / 5.23; 5.23 / 5.23 | 5.56 / 5.57; 5.69 / 5.69 | 3.93 / 3.93; 4.02 / 4.02 |
| Ten-month peak RSS (MiB) | samples / raw | 9.27 / 9.50; 9.39 / 9.50 | 320.91 / 460.89; 91.23 / 109.02 | 4.21 / 4.27; 4.30 / 4.35 |

The full generated tables follow. They come from `bench/stage0/summarize.py` over the committed trial files; the report copies them without hand edits.

### Generated tables

All paired cells are **cold / warm**. Wall values are medians of 3 optimized trials. Memory peak is the maximum of those 3 trials; steady RSS is the median one-second sample. Heap is one separate meter trial. `killed` has no completed operation value; do not read it as zero. CSV retains ranges, return RSS, cache-before and separate C heap live/peak values. The append rows in these two tables are the **supplement** (900 new + 100 exact duplicates, rejection path); the strict append headline is a separate table.

| Shape / workload | SQLite ms | ProseQL ms | Spike ms |
|---|---:|---:|---:|
| samples / point | 3.90 / 0.04 | 8237.02 / 7980.46 | 513.37 / 365.16 |
| samples / hour | 5.33 / 0.58 | 847.51 / 0.74 | 1.40 / 0.45 |
| samples / month | 83.20 / 38.41 | 1614.55 / 935.97 | 50.67 / 40.08 |
| samples / ten | 889.31 / 617.95 | 9299.86 / 9042.32 | 530.87 / 418.63 |
| samples / append (supplement: 900 new + 100 duplicates) | 29.04 / 16.17 | 766.23 / 746.25 | 249.93 / 241.83 |
| samples / open | 1.47 / 0.24 | 0.48 / 0.27 | 6.41 / 0.39 |
| samples / idle | 1000.18 / 1000.17 | 1000.17 / 1000.16 | 1000.18 / 1000.19 |
| raw / point | 4.76 / 0.04 | 29.05 / 0.59 | 3.88 / 1.52 |
| raw / hour | 5.50 / 0.61 | 8019.41 / 7938.65 | 372.63 / 32.35 |
| raw / month | 90.27 / 37.77 | 8037.64 / 8118.50 | 427.10 / 73.45 |
| raw / ten | 878.66 / 607.81 | 8645.52 / 8723.05 | 962.92 / 439.50 |
| raw / append (supplement: 900 new + 100 duplicates) | 29.46 / 16.20 | killed / killed | 2240.11 / 1676.42 |
| raw / open | 1.67 / 0.24 | 3.85 / 3.67 | 4.13 / 1.67 |
| raw / idle | 1000.18 / 1000.17 | 1000.19 / 1000.19 | 1000.17 / 1000.18 |

### Memory, cache and user instructions

RSS and heap/cache units are MiB. `Rust L/P` is live/peak requested heap; `C P` is SQLite's separate C heap peak (not included in Rust). Owned-file cache is after process exit; before/after bytes are in the CSV. Instructions are millions, operation-only.

| Shape / workload | Backend | RSS peak C/W | RSS steady C/W | Rust L/P cold; warm | C P C/W | File cache C/W | Instructions C/W |
|---|---|---:|---:|---|---:|---:|---:|
| samples / point | sqlite | 5.52 / 5.52 | 5.52 / 5.52 | 0.001/0.004; 0.001/0.004 | 0.099 / 0.099 | 1.05 / 534.59 | 0.116 / 0.104 |
| samples / point | proseql | 280.62 / 485.13 | 280.62 / 387.59 | 147.366/230.032; 147.366/365.764 | — | 226.62 / 226.62 | 35435.960 / 32057.424 |
| samples / point | spike | 4.19 / 4.20 | 4.19 / 4.19 | 0.187/0.252; 0.187/0.252 | — | 226.73 / 226.73 | 3066.175 / 3066.171 |
| samples / hour | sqlite | 5.78 / 5.80 | 5.77 / 5.79 | 0.001/0.178; 0.001/0.178 | 0.143 / 0.143 | 1.14 / 534.59 | 3.478 / 3.427 |
| samples / hour | proseql | 203.25 / 195.72 | 195.71 / 195.72 | 147.366/166.355; 147.366/147.544 | — | 23.11 / 226.62 | 4003.086 / 2.346 |
| samples / hour | spike | 4.41 / 4.40 | 4.40 / 4.40 | 0.187/0.422; 0.187/0.422 | — | 0.37 / 226.73 | 3.135 / 3.172 |
| samples / month | sqlite | 9.27 / 9.42 | 7.45 / 9.41 | 0.004/0.005; 0.004/0.005 | 4.037 / 4.037 | 28.75 / 534.59 | 278.512 / 278.151 |
| samples / month | proseql | 208.96 / 381.88 | 208.96 / 294.95 | 143.152/167.308; 143.152/309.486 | — | 45.47 / 226.62 | 7875.827 / 4335.793 |
| samples / month | spike | 4.20 / 4.20 | 4.19 / 4.19 | 0.189/0.252; 0.189/0.252 | — | 23.48 / 226.73 | 330.756 / 330.750 |
| samples / ten | sqlite | 9.27 / 9.50 | 7.54 / 9.50 | 0.057/0.059; 0.057/0.059 | 4.113 / 4.113 | 268.77 / 534.59 | 4504.894 / 4504.515 |
| samples / ten | proseql | 320.91 / 460.89 | 320.91 / 457.30 | 147.422/230.389; 147.422/365.997 | — | 226.62 / 226.62 | 39960.734 / 36618.471 |
| samples / ten | spike | 4.21 / 4.27 | 4.21 / 4.27 | 0.243/0.281; 0.243/0.281 | — | 226.73 / 226.73 | 3508.644 / 3508.641 |
| samples / append (supplement: 900 new + 100 duplicates) | sqlite | 8.68 / 8.67 | 8.67 / 8.67 | 0.001/1.952; 0.001/1.952 | 0.771 / 0.771 | 3.16 / 534.96 | 65.193 / 65.194 |
| samples / append (supplement: 900 new + 100 duplicates) | proseql | 207.95 / 207.95 | 201.18 / 201.18 | 150.877/170.118; 150.877/170.118 | — | 23.42 / 226.93 | 3813.179 / 3813.198 |
| samples / append (supplement: 900 new + 100 duplicates) | spike | 6.57 / 6.57 | 6.56 / 6.56 | 0.187/2.142; 0.187/2.142 | — | 23.54 / 227.05 | 707.865 / 707.827 |
| samples / open | sqlite | 5.23 / 5.23 | 5.23 / 5.23 | 0.001/0.003; 0.001/0.003 | 0.068 / 0.068 | 0.12 / 534.59 | 0.344 / 0.312 |
| samples / open | proseql | 5.57 / 5.82 | 5.57 / 5.82 | 0.018/0.024; 0.018/0.024 | — | 0.00 / 226.62 | 0.757 / 0.802 |
| samples / open | spike | 3.94 / 3.94 | 3.94 / 3.94 | 0.187/0.197; 0.187/0.197 | — | 0.12 / 226.73 | 2.423 / 2.428 |
| samples / idle | sqlite | 5.23 / 5.23 | 5.23 / 5.23 | 0.001/0.003; 0.001/0.003 | 0.066 / 0.066 | 0.12 / 534.59 | 0.000 / 0.000 |
| samples / idle | proseql | 5.57 / 5.57 | 5.56 / 5.57 | 0.018/0.020; 0.018/0.020 | — | 0.00 / 226.62 | 0.000 / 0.000 |
| samples / idle | spike | 3.93 / 3.94 | 3.93 / 3.93 | 0.187/0.189; 0.187/0.189 | — | 0.12 / 226.73 | 0.000 / 0.000 |
| raw / point | sqlite | 5.52 / 5.52 | 5.52 / 5.52 | 0.001/0.004; 0.001/0.004 | 0.099 / 0.099 | 0.50 / 534.59 | 0.123 / 0.111 |
| raw / point | proseql | 13.61 / 13.52 | 13.52 / 13.52 | 5.851/6.404; 5.851/6.114 | — | 0.92 / 235.25 | 149.654 / 2.424 |
| raw / point | spike | 4.28 / 4.28 | 4.28 / 4.28 | 0.229/0.295; 0.229/0.295 | — | 1.92 / 236.25 | 12.914 / 12.910 |
| raw / hour | sqlite | 5.78 / 5.79 | 5.78 / 5.79 | 0.001/0.179; 0.001/0.179 | 0.143 / 0.143 | 0.62 / 534.59 | 3.737 / 3.680 |
| raw / hour | proseql | 91.32 / 109.62 | 74.46 / 109.62 | 5.884/75.416; 5.884/80.955 | — | 235.25 / 235.25 | 38867.464 / 38912.260 |
| raw / hour | spike | 4.49 / 4.49 | 4.49 / 4.49 | 0.229/0.465; 0.229/0.465 | — | 76.02 / 236.25 | 242.023 / 242.048 |
| raw / month | sqlite | 9.39 / 9.42 | 7.46 / 9.42 | 0.003/0.005; 0.003/0.005 | 4.037 / 4.037 | 30.44 / 534.59 | 278.514 / 278.154 |
| raw / month | proseql | 90.98 / 108.67 | 74.26 / 108.67 | 5.887/75.258; 5.887/80.797 | — | 235.25 / 235.25 | 39229.365 / 39267.323 |
| raw / month | spike | 4.28 / 4.28 | 4.28 / 4.28 | 0.232/0.294; 0.232/0.294 | — | 77.88 / 236.25 | 586.991 / 586.985 |
| raw / ten | sqlite | 9.39 / 9.50 | 7.54 / 9.50 | 0.057/0.059; 0.057/0.059 | 4.113 / 4.113 | 267.36 / 534.59 | 4504.897 / 4504.518 |
| raw / ten | proseql | 91.23 / 109.02 | 74.61 / 109.02 | 5.940/75.612; 5.940/81.151 | — | 235.25 / 235.25 | 41566.227 / 41593.831 |
| raw / ten | spike | 4.30 / 4.35 | 4.30 / 4.35 | 0.286/0.323; 0.286/0.323 | — | 236.25 / 236.25 | 3603.213 / 3603.213 |
| raw / append (supplement: 900 new + 100 duplicates) | sqlite | 8.80 / 8.80 | 8.80 / 8.80 | 0.001/1.959; 0.001/1.959 | 0.771 / 0.771 | 1.61 / 534.96 | 69.433 / 69.433 |
| raw / append (supplement: 900 new + 100 duplicates) | proseql | killed / killed | killed / killed | killed; killed | — | killed / killed | killed / killed |
| raw / append (supplement: 900 new + 100 duplicates) | spike | 6.73 / 6.73 | 6.73 / 6.73 | 0.233/2.191; 0.233/2.191 | — | 236.57 / 236.57 | 6854.538 / 6854.547 |
| raw / open | sqlite | 5.23 / 5.23 | 5.23 / 5.23 | 0.001/0.003; 0.001/0.003 | 0.068 / 0.068 | 0.12 / 534.59 | 0.344 / 0.312 |
| raw / open | proseql | 5.69 / 5.96 | 5.69 / 5.96 | 0.053/0.066; 0.053/0.066 | — | 0.00 / 235.25 | 15.799 / 16.559 |
| raw / open | spike | 4.02 / 4.02 | 4.02 / 4.02 | 0.229/0.241; 0.229/0.241 | — | 1.00 / 236.25 | 4.643 / 4.638 |
| raw / idle | sqlite | 5.23 / 5.23 | 5.23 / 5.23 | 0.001/0.003; 0.001/0.003 | 0.066 / 0.066 | 0.12 / 534.59 | 0.000 / 0.000 |
| raw / idle | proseql | 5.69 / 5.69 | 5.69 / 5.69 | 0.053/0.055; 0.053/0.055 | — | 0.00 / 235.25 | 0.000 / 0.000 |
| raw / idle | spike | 4.02 / 4.02 | 4.02 / 4.02 | 0.229/0.231; 0.229/0.231 | — | 1.00 / 236.25 | 0.000 / 0.000 |

Source data: `bench/stage0/results/trials.jsonl`; exact numeric summaries: `bench/stage0/results/summary.csv`. The idle wall is a one-second observation interval. Warm append is file-cache-warm, not a duplicate replay. No complete heap/RSS reading is available for killed operations.

### Append, headline: 1,000 genuinely new rows (strict)

Every requested ID is new and is checked for a duplicate. Cells are **cold / warm**. Runs are completed timing trials / SIGKILLed trials / skipped trials (a cell is not repeated after a kill). Units as in the memory table.

| Shape | Implementation and duplicate-check scope | Wall ms C/W | Runs ok/killed/skipped C; W | RSS peak C/W | RSS steady C/W | Rust L/P cold; warm | C P C/W | File cache C/W | Instructions C/W |
|---|---|---:|---|---:|---:|---|---:|---:|---:|
| samples | global: primary-key B-tree lookup per row | 27.94 / 16.33 | 3/0/0; 3/0/0 | 8.81 / 8.81 | 8.81 / 8.81 | 0.001/1.953; 0.001/1.953 | 0.784 / 0.784 | 2.37 / 535.00 | 65.390 / 65.388 |
| samples | native as shipped: `create_many` alone; checks loaded/routed partitions only | 788.37 / 755.20 | 3/0/0; 3/0/0 | 207.95 / 207.95 | 202.33 / 201.99 | 151.097/170.119; 151.097/170.119 | — | 23.46 / 226.96 | 3816.182 / 3816.130 |
| samples | native + global preflight: one `query_bounded` `id $in` **scan** of every partition, then `create_many` (benchmark-only) | 13235.44 / 13271.75 | 3/0/0; 3/0/0 | 302.34 / 302.34 | 302.34 / 302.33 | 151.097/232.427; 151.097/232.427 | — | 226.96 / 226.96 | 75595.328 / 75595.088 |
| samples | global: full scan of every file, exact record compare | 714.86 / 617.67 | 3/0/0; 3/0/0 | 6.58 / 6.58 | 6.58 / 6.58 | 0.187/2.188; 0.187/2.188 | — | 227.08 / 227.08 | 3629.463 / 3629.338 |
| raw | global: primary-key B-tree lookup per row | 30.41 / 17.25 | 3/0/0; 3/0/0 | 8.87 / 8.87 | 8.87 / 8.87 | 0.001/1.959; 0.001/1.959 | 0.784 / 0.784 | 1.57 / 535.00 | 69.493 / 69.494 |
| raw | native as shipped: `create_many` alone; checks loaded/routed partitions only | killed / killed | 0/1/3; 0/1/3 | killed / killed | killed / killed | killed; killed | — | killed / killed | killed / killed |
| raw | native + global preflight: one `query_bounded` `id $in` **scan** of every partition, then `create_many` (benchmark-only) | killed / killed | 0/1/3; 0/1/3 | killed / killed | killed / killed | killed; killed | — | killed / killed | killed / killed |
| raw | global: full scan of every file, exact record compare | 2365.41 / 1729.07 | 3/0/0; 3/0/0 | 6.78 / 6.78 | 6.78 / 6.78 | 0.233/2.242; 0.233/2.242 | — | 236.61 / 236.61 | 6831.166 / 6830.914 |

Source data: `bench/stage0/results/append-new/trials.jsonl`, `skipped.jsonl` and `summary.csv`. The preflight builds no membership structure, so it has no separate build time or resident structure bytes; its scan cost is inside the wall time.

### Sparse-index density supplement (same binary, same source records)

Raw sparse sidecars grow from 115,338 B (stride 256) to 1,495,550 B (stride 16). All 32 supplementary trials match the main matrix's canonical answers. This changes only the disposable time index, not production code or a column cache.

| Raw workload | SQLite ms C/W | Spike stride 256 ms C/W | Spike stride 16 ms C/W | Stride 16 peak RSS MiB C/W | Stride 16 Rust peak MiB C/W |
|---|---:|---:|---:|---:|---:|
| hour | 5.50 / 0.61 | 372.63 / 32.35 | 217.79 / 5.29 | 7.55 / 7.54 | 3.220 / 3.220 |
| month | 90.27 / 37.77 | 427.10 / 73.45 | 245.03 / 46.68 | 7.34 / 7.34 | 3.049 / 3.049 |
| ten | 878.66 / 607.81 | 962.92 / 439.50 | 977.11 / 440.41 | 7.36 / 7.36 | 3.079 / 3.079 |
| open | 1.67 / 0.24 | 4.13 / 1.67 | 126.54 / 6.44 | 7.08 / 7.09 | 3.002 / 3.002 |

### #12 targets on yari (proxy)

Ratios are implementation / SQLite, **cold / warm**, from the medians above. A cell passes only if cold and warm both pass. yari is a proxy: #12 sets the targets on rakku, which this stage does not measure.

| Target (#12) | Limit | Shape | ProseQL `61c4322` | Spike |
|---|---|---|---|---|
| Memory, open and idle (steady RSS) | ≤ SQLite + 20 MiB | samples | +0.34 / +0.60 MiB: pass | -1.29 / -1.29 MiB: pass |
| Memory, open and idle (steady RSS) | ≤ SQLite + 20 MiB | raw | +0.46 / +0.73 MiB: pass | -1.21 / -1.21 MiB: pass |
| Peak RSS, any listed read (point/hour/month/ten) | ≤ 2 × SQLite peak | samples | worst 50.81× / 87.83×: **miss** | worst 0.76× / 0.76×: pass |
| Peak RSS, any listed read (point/hour/month/ten) | ≤ 2 × SQLite peak | raw | worst 15.80× / 18.92×: **miss** | worst 0.78× / 0.78×: pass |
| Ten-month aggregate by day, 2 metrics (wall) | ≤ 1 × SQLite | samples | 10.46× / 14.63×: **miss** | 0.60× / 0.68×: pass |
| Ten-month aggregate by day, 2 metrics (wall) | ≤ 1 × SQLite | raw | 9.84× / 14.35×: **miss** | 1.10× / 0.72×: **miss** |
| One-month aggregate by day (wall) | ≤ 1 × SQLite | samples | 19.41× / 24.37×: **miss** | 0.61× / 1.04×: **miss** |
| One-month aggregate by day (wall) | ≤ 1 × SQLite | raw | 89.04× / 214.95×: **miss** | 4.73× / 1.94×: **miss** |
| 1-hour range read (wall) | ≤ 1.5 × SQLite | samples | 159.09× / 1.26×: **miss** | 0.26× / 0.77×: pass |
| 1-hour range read (wall) | ≤ 1.5 × SQLite | raw | 1458.90× / 12973.29×: **miss** | 67.79× / 52.87×: **miss** |
| Point lookup by ID (wall) | ≤ 2 × SQLite | samples | 2113.80× / 198914.66×: **miss** | 131.74× / 9101.66×: **miss** |
| Point lookup by ID (wall) | ≤ 2 × SQLite | raw | 6.10× / 14.26×: **miss** | 0.81× / 36.78×: **miss** |
| Append 1,000 new rows with duplicate checks (wall) | ≤ 1 × SQLite | samples | as shipped 28.21× / 46.24×: **miss**; + global preflight 473.67× / 812.64×: **miss** | 25.58× / 37.82×: **miss** |
| Append 1,000 new rows with duplicate checks (wall) | ≤ 1 × SQLite | raw | as shipped killed / killed: **miss** (killed); + global preflight killed / killed: **miss** (killed) | 77.77× / 100.22×: **miss** |
| Memory 1 s after a read returns | back to idle (judged: ≤ max(SQLite's own retained delta, 1 MiB)) | samples | worst +451.73 MiB above idle: **miss** | worst +0.47 MiB above idle: pass |
| Memory 1 s after a read returns | back to idle (judged: ≤ max(SQLite's own retained delta, 1 MiB)) | raw | worst +103.93 MiB above idle: **miss** | worst +0.47 MiB above idle: pass |
| Open, Logbook real shape on rakku | ≤ 1 s | — | **unmeasured** (rakku-only; no rakku access, no real data) | **unmeasured** |
| Peak RSS not growing with partition count | — | samples (10 files) vs raw (256 files) | compare peak rows above; not a controlled partition-count sweep | same |

### Append: what the two batches measure

| Batch | Purpose | Duplicate-check scope in this run |
|---|---|---|
| Headline: 1,000 genuinely new rows (`append-new/`) | The #12 append target | SQLite: global (primary key). Spike: global full scan. Native as shipped: loaded/routed partitions only. Native + global preflight: global `query_bounded` scan. |
| Supplement: 900 new + 100 exact duplicates (main matrix) | Rejection path for identical duplicates | SQLite: global. Spike (built at `03d0cb0`): routed destination files only. Native: loaded/routed partitions only. |

The supplement spike value on samples (249.93 / 241.83 ms) is therefore not a global check; the headline value (714.86 / 617.67 ms) is. On raw, 1,000 hashed IDs route to nearly every shard (all 256 in the headline run, measured), so the supplement spike probably already read almost every raw file (inferred; the older driver did not record the file count). The headline spike cost is a full scan of all 656,640 rows for 1,000 IDs. It shows that a scan cannot meet the append target (25.58× / 37.82× SQLite on samples). An exact ID membership structure with source verification (#15/#16) is required; this stage did not build or measure one.

"Native + global preflight" is one public `query_bounded` call with `where: { id: { $in: [1,000 IDs] } }`, then `create_many`. It uses a **scan**, not a membership structure, so it has no separate build time or resident structure bytes. On samples it costs 13,235.44 / 13,271.75 ms, 302.34 MiB peak RSS and 75,595 M instructions. The preflight exists only in this benchmark. It is not atomic with the write and it does not fix the production cross-partition duplicate gap (#16). No production source changed.

### Native raw append: OOM at 1 GiB (measured result)

Every native raw append trial (as shipped and with the global preflight, cold and warm, both batches) was killed by the scope's OOM killer at `MemoryMax=1G`. The limit was not raised.

| Diagnostic | Supplement batch (`03d0cb0` binary) | Headline batch (`4d2937b` binary) |
|---|---:|---:|
| Sampled process RSS before the kill (lower bound) | 1,068,244,992 B (1,018.76 MiB) | 1,067,421,696 B (1,017.98 MiB) |
| cgroup `memory.peak` | 1,073,741,824 B (the limit) | 1,073,741,824 B (the limit) |
| Sampled cgroup anon peak | 1,070,477,312 B | 1,069,768,704 B |
| `memory.events` `oom_kill` before → after | 0 → 1 | 0 → 1 |
| Time to kill | 63.60 s | 69.15 s |

Floor: the operation needs **more than 1,018.76 MiB** of resident memory (verified lower bound). The true peak is above the 1 GiB limit and is unmeasured, because the rules forbid a larger scope.

Likely cause (inferred from source reading and the numbers; not instrumented): the 1,000 new raw rows hash-route to **all 256 shards** (the spike appended to 256 files in every raw trial). In `crates/proseql-native` at `61c4322`, the mutation path calls `lazy_ensure_for_record` for each record. That calls `lazy_ensure` with no reclaim context, so it loads without eviction; `lazy_trim` runs only after the operation. `max_loaded_partitions=1` therefore does not bound a mutation, and the batch loads the whole 656,640-row collection. The measured resident cost per row is about 2,300 B (samples append as shipped: 151.10 MiB live Rust heap with one month of 66,960 + 1,000 rows loaded), so the full collection needs about 1.4 GiB. The global preflight completed (its stderr records `matched: 0` before `create_many`), so the kill happens in `create_many`, not in the preflight scan. Cheapest way past it: Stage 3 (#16) appends without resident rows (append bytes to the routed file plus a compact ID check); the spike does this in 6.78 MiB peak RSS.

### Level 2 (#18): recommendation

**Not needed for the month-partitioned `samples` shape; do not start #18 now.** The level-1 spike already beats SQLite on the ten-month aggregate: 530.87 / 418.63 ms against 889.31 / 617.95 ms (0.60× / 0.68×), with 3,508.6 M against 4,504.9 M user instructions and 4.21 MiB against 9.27 MiB peak RSS. One-month warm is the only samples aggregate miss: 40.08 ms against 38.41 ms (1.04×; trial ranges 38.85–40.37 against 37.90–38.79 ms). Stage 1 code tuning is the cheaper first step for that gap.

**The 256-shard `raw` shape is where level 1 fails.** Range reads fan out over 256 files. A denser time index helps but does not close the gap:

| Raw workload | SQLite ms C/W | Spike stride 256 C/W (× SQLite) | Spike stride 16 C/W (× SQLite) | Limit |
|---|---:|---:|---:|---:|
| 1-hour range | 5.50 / 0.61 | 372.63 / 32.35 (67.8× / 52.9×) | 217.79 / 5.29 (39.6× / 8.7×) | 1.5× |
| One month by day | 90.27 / 37.77 | 427.10 / 73.45 (4.73× / 1.94×) | 245.03 / 46.68 (2.71× / 1.24×) | 1× |
| Ten months by day | 878.66 / 607.81 | 962.92 / 439.50 (1.10× / 0.72×) | 977.11 / 440.41 (1.11× / 0.72×) | 1× |

The same 656,640 rows cost 530.87 ms cold in 10 month files and 962.92 ms cold in 256 shard files, so about 430 ms of the cold raw ten-month time is file fan-out, not parsing (inferred from the difference). A disposable time-ordered column cache (level 2) is the likely fix for raw range reads, because it removes both the fan-out and most of the parse. A cross-shard time-to-(shard, offset) index under #15 is a cheaper text-only option that this stage did **not** test.

Recommendation (opinion): keep #18 conditional. Re-measure after #14/#15. Raise #18 only if raw-shape range reads are a confirmed consumer workload and the #15 cross-shard index still misses. Cost of waiting: if level 2 is needed, it adds 3–5 agent-days after #15 and needs the README wording decision below. What this does not settle: rakku numbers, and whether Logbook queries the raw collection by time range at all.

### Other misses that level 2 does not address

| Miss | Measured | Cause | Owner |
|---|---|---|---|
| Point lookup, samples | spike 513.37 / 365.16 ms vs 3.90 / 0.04 ms | No ID index: scans every month | #15 exact ID-to-offset index |
| Point lookup, raw warm | spike 1.52 ms vs 0.04 ms (36.78×) | Re-reads one shard per lookup | #15; SQLite's warm path is a cached B-tree probe |
| Append, all shapes | spike 25.58×–100.22× SQLite | Global duplicate scan | #15/#16 ID membership plus verification |
| Raw native append | OOM above 1,018.76 MiB | All 256 partitions resident in one mutation | #16 |

## Architecture recommendation

Use one shared borrowed-row executor with format-specific byte readers. Push filters, projections and folds into the read, materializing only selected output. Keep a bounded query arena for sort/top-k and callback-owned values. Sparse time offsets address small ranges; a separate exact ID-to-source/offset structure addresses point lookup and duplicate checks. Do not expect a time index alone to solve ID lookup.

Source hosts own fingerprints, validated generations, index invalidation and publication. Production fingerprints must be stronger than the spike's size/mtime pair (for example identity/ctime plus a checked read generation, or a content hash where the host requires it). A missing or stale index must select a correct full scan or rebuild. Out-of-order appends must disable ordered seek or rebuild a correct index. Scalar code must remain the qualification path. Native mmap is optional, not an engine dependency; browser hosts need chunked reads through the same executor.

The measured spike is not this architecture's semantic proof. It is a workload-specific scalar reader. In particular, it lacks a primary-key positional index, schema checks, hooks, external-edit conflict handling, watch delivery, crash rollback and arbitrary predicates. It consumes existing UTC day values for native/SQLite aggregates and derives the same day from normalized UTC time in the spike. General timezone/date expression behavior is not benchmarked.

## Semantics that make streaming hard

| Area | Contract that cannot be removed to improve a number | Design cost / follow-up |
|---|---|---|
| Mutations and transactions | Validation, defaults/transforms, hooks, constraints, rollback, conflict detection, source write safety, and exact tagged errors. Current native source batches can quarantine after a write-stage prefix becomes durable; do not invent stronger existing atomicity. | Streaming rewrite plus a reviewed transaction/journal/publication protocol; fault injection before adopting it. |
| Watches | Existing events, last-known-good state on external edits, delivered snapshots and active watch pins have explicit lifetimes. | Source generations and compact change detection; caller-owned snapshots still consume memory. A zero partition counter is not zero watch memory. Last-known-good reads after an invalid edit may require an immutable file-backed text generation; an optional binary cache cannot be the only copy, because deleting a disposable cache must not change answers. |
| Exact duplicates | `ignore_identical` must compare the validated record, not just a fingerprint or Bloom positive. Cross-partition IDs need an explicit policy and tests (#16 references the existing gap). | Compact ID membership plus source verification. Bloom filters can reject definite misses, never prove equality. |
| Ordering, cursors and aggregates | Stable ties, natural/index-union order, first-encounter group order, JS string cursor conversion, strict after/before comparisons, backward tail/limit+1 page flags, validation errors, and IEEE f64 accumulation order. | Keep a stable source ordinal and current cursor rules. Do not merge monthly floating-point partial sums or silently add snapshot guarantees. Canonical benchmark answers do not test output ordering. |
| Schema/error timing | Today a selected partition is decoded/validated before querying. An invalid unused field or a callback can still fail the read. | Predicate pushdown cannot skip required validation/errors. Early Stream output before a later validation error needs an explicit parity audit or additive API. |
| YAML documents | Keyed records, aliases/document structure, unknown sections, provenance, ownership and byte/write-safety boundaries. | Retain the safe document reader/writer initially. Bound fallback by the largest document and report it; do not claim JSONL's line bound for YAML. |
| WASM/browser | Same query and error semantics; no mmap; WASM memory growth is not glibc RSS reclamation. | Host chunk API and separate real-browser memory evidence. A full `readText` fallback is not a bounded browser path. |

## Stages 1–6 and revised effort

Estimates are **judgement**, not measured throughput. One agent-day is 6–8 active hours and includes an independent review/fix round. Stage 0 does not start any row below. Stage 1 and 2 share the scan/index contract before parallel work. Stage 5 remains conditional and requires a separate user decision. These totals exclude Stage 0; the epic's original 15–26 / 18–31 totals included Stage 0's 2–3 days.

| Stage / issue | Prior agent-days | Revised agent-days | Work and gate | Cost / remaining risk |
|---|---:|---:|---|---|
| 1 / #14 | 3–5 | 4–6 | Borrowed scalar executor behind compatible APIs; differential queries, ordering, errors and query-lifetime memory. After user approval. | General predicates, schema callbacks and sort/cursor semantics exceed this spike. |
| 2 / #15 | 1–2 | 2–3 | Sparse time offsets plus exact ID location; source fingerprints and stale/unsorted/deleted-index tests. Parallel with stage 1 after agreeing the seam. | Rebuild/open cost and ID metadata can dominate; disposable persistent artifacts need a policy decision. |
| 3 / #16 | 4–7 | 6–10 | Exact duplicates, bounded batch writes, updates/deletes, watches, rollback/conflicts and crash tests. After stage 1. | Highest risk. Matching SQLite NORMAL timing does not justify weaker durability or watch behavior. |
| 4 / #17 | 2–4 | 3–5 | YAML safety/document bounds and browser chunk path; parity/browser memory tests. After stage 1, parallel with stage 3. | YAML documents may retain a document-sized floor; browser pages do not shrink like native arenas. |
| 5 / #18 | 3–5 | 3–5 conditional | Disposable fixed-width columns and dictionaries only if stage 1/2 still miss aggregate targets and wording is approved. | Invalidation, build cost, disk duplication and native/browser paths. A cache cannot be correctness-critical. |
| 6 / #19 | 3–5 | 4–6 | Remove resident path only after parity; full checks, unedited Coach/Logbook override builds/tests, adoption notes and a tested SHA. | Consumer pins, all formats and host-specific targets remain integration work, not Stage-0 evidence. |
| Future stages only, without / with stage 5 | 13–23 / 16–28 | **19–30 / 22–35** | User approves scope and sequencing first. | No Celeron schedule can be promised without an approved measurement window. |

## User decisions (not adopted)

1. Approve or reject the staged streaming/index plan and revised effort. This report is the stop gate, not approval.
2. If binary ID/offset indexes or a level-2 column cache are allowed, approve this exact replacement for the README opening principle:

   > A Rust-first, type-safe relational database that persists to plain text files. Rust is the only database engine. No server. No binary source of truth. Your data stays in files you can read, edit, `git diff`, and actually understand. ProseQL may create disposable binary indexes or caches, validated against those text files and safe to delete or rebuild. Queries return the same results without them.

   This permits rebuildable artifacts, not a second source of truth. Cost: extra disk, invalidation/versioning rules and cold rebuild time. The README itself is unchanged. The spike's sparse sidecars are text JSON and benchmark-only; they do not adopt a production sidecar policy.
3. Resolve append durability before claiming the same-durability target. SQLite WAL NORMAL does not sync every commit in the same way as native synced appends; the scanner also syncs source files but has no cross-file transaction protocol. The measured NORMAL baseline remains the requested bar. Do not weaken native guarantees quietly to reach it.
4. Decide whether time-range reads on the 256-shard raw shape are a target workload. Level 1 misses them on yari (1-hour 39.6× / 8.7× SQLite even with a stride-16 index). If they are a target and the #15 cross-shard index also misses, #18 is the likely path; if not, #18 can stay closed.
5. Set a tolerance for "back to idle within 1 s". #12 gives none. This report judged a read as back to idle when its retained RSS 1 s after return is at most max(SQLite's own retained delta for the same read, 1 MiB).

## What yari cannot establish about the Celeron

| Question | Status / reason |
|---|---|
| Open ≤1 s on rakku's real Logbook shape | **Unmeasured.** No rakku access and no real health data. Synthetic yari open is not that target. |
| Ten-month aggregate ≤SQLite on rakku | **Unmeasured.** yari ratios are a proxy only; Neoverse N1 is not Silvermont. |
| SSE4.2/no-AVX performance or executable compatibility | **Unmeasured.** Source is portable scalar Rust with serde_json, no intrinsics/SIMD-only parser, but no x86 binary was built or run. |
| Disk and cold-cache floor on the target | **Unmeasured.** Oracle virtual disk/btrfs and its caches do not predict the Celeron's storage/cache hierarchy. |
| Target memory and allocator return within 1 s | **Unmeasured on rakku.** Allocator/page size, CPU cache, memory bandwidth and kernel differ. Native yari RSS and Rust requested bytes answer separate questions. |
| Real consumer latency | **Unmeasured.** Synthetic storage queries exclude Logbook resolution logic and production configuration/payload diversity. Coach/Logbook compatibility belongs to later stages. |
| zao performance | **Not measured by instruction.** zao was used only for file/Git work. |

Even instruction counts cannot be converted directly between aarch64 and x86 instruction sets. A high-level algorithmic reduction is plausible evidence for transfer, not a Celeron speed guarantee. No target is lowered here.

## Verification and cleanup

All checks below ran on yari. zao ran Git and file edits only. Nothing ran on rakku.

| Check | Where / commit | Result |
|---|---|---|
| yari source equals the zao commit | `run.sh checkout` from a Git bundle, then `git log -1` and `git status` on yari | HEAD matched each time (`cb0f9f3`, `a5fa221`, `4393ffc`); only `results/` and this report were untracked |
| Production files unchanged from `61c4322` | `sha256sum -c baseline-files.sha256` (`results/append-new/baseline-check.log`); `git diff 61c4322 HEAD -- crates packages` on zao | every tracked `crates/` file OK; no diff |
| `run.sh check` (cargo check, release `cargo test` in a 1 GiB scope, clippy `-D warnings`, rustfmt `--check`, shellcheck, `py_compile`, ruff check, `nix fmt --check flake.nix`) | yari, `4393ffc` (`results/check.sha`, `check-exit.log`) | **pass**, exit 0. Tests: 5 passed, 0 failed (`tests.log`) |
| Why `check` failed before | `results/python-lint-initial.log`, and `python-lint.log` at `4d2937b` | Both retained failure logs show only ruff findings. The earlier log: 16 findings (C408, EXE001, I001, PLW1510, SIM115), all gone by `4d2937b`. The later log at `4d2937b`: one UP034 (`sum((…))`) in `summarize.py`, fixed in `cb0f9f3`. In that run cargo check, tests, clippy, rustfmt and shellcheck passed; `nix fmt` did not run because the script stops at the first failure |
| Python format | `ruff format --check bench/stage0/` on yari (`results/python-format.log`) | pass after `4393ffc` |
| Strict append correctness | driver in `measure.py` | every successful trial persisted exactly 1,000 rows with new IDs (`append_verified`); answers equal across all implementations (`append-new/equivalence.json`) |
| Strict append completeness | `summarize.py` | 52 trials: 48 successful, 4 SIGKILLed (native raw, as shipped and preflight, cold and warm); 12 repeats skipped after a kill (`skipped.jsonl`); each cell has 4 planned runs |
| Main matrix completeness | `summarize.py` | 336 trials: 328 successful, 8 failed (all native raw append, the OOM) |
| Cold eviction | `summarize.py` | 0 cold trials had resident fixture pages before launch, in both runs |
| OOM attribution | `diagnose.py` with `OOMPolicy=continue`, same 1 GiB/no-swap/nice/timeout scope | cgroup `oom_kill` 0 → 1 for both binaries |
| SQLite temporary files | `diagnose.py sqlite-temp` | observed only under `/home/simon/work/proseql-stage0-data/tmp/` |
| Focused regression tests | `cargo test` | real backends agree on rows, groups and identical duplicates; conflicting duplicates publish nothing; global preflight rejects an ID in another time partition, while native as shipped accepts it (documents the #16 gap); stale-index and equal-timestamp block boundaries are safe; borrowed/escaped field decoding |

Not run, by instruction: the full repository test suite, TypeScript checks, and any measurement on rakku or zao.

Cleanup on yari, after every committed result was copied back and compared by checksum (`rsync -c` dry run: no differences):

| Item | Action | Confirmation |
|---|---|---|
| `/home/simon/work/proseql-stage0-data` (synthetic data, binary copies, about 2 GiB) | `run.sh cleanup` | `du`: "No such file or directory" |
| `bench/stage0/target`, `__pycache__`, `source.bundle` on yari | `run.sh cleanup` | `results/cleanup.log` |
| `/home/simon/work/proseql-stage0` (synced checkout, 1.2 GiB) | `rm -rf` | `du`: "No such file or directory"; `du -sh /home/simon/work` = 0 |
| Transient systemd scopes | none left | `systemctl --user list-units --type=scope`: 0 `run-` units |
| `/home/simon/.cargo` (246 MiB crate download cache, created 2026-10-25 03:41 UTC) | **kept** | Outside the two named directories; probably created by this stage's first build. Remove only on request |

Not committed: `results/initial/lock.log` (475 KB of crates.io index progress output from the excluded initial run; no evidence value). Committed results total about 3.5 MB. Only `results/trials.jsonl` is over 1 MB (1.98 MB). It is the per-trial source of every main-matrix number; `summary.csv`, `tables.md` and `equivalence.json` derive from it, and `summarize.py` needs it to reproduce the tables.
