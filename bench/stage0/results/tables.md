## Results on yari

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
