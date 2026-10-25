# Query-while-scanning acceptance on aka

Resident is the reference baseline; #12 targets judge Streaming against SQLite. Synthetic x86-64-v2 proxy, not rakku/Celeron qualification. Cold / warm. A failed trial makes its cell a miss; killed trials are not zero. Timing medians; RSS peak maximum; heap is a separate instrumented trial.

Timing repeats: 3. Trials: 342; failures: 6; skipped after kill: 18.

| Shape / workload | Backend | Wall ms C/W | Peak RSS MiB C/W | RSS at 1 s MiB C/W | Rust live/peak MiB cold; warm |
|---|---|---:|---:|---:|---|
| samples/point | sqlite | 1.600 / 0.032 | 6.305 / 6.305 | 6.305 / 6.305 | 0.001/0.004; 0.001/0.004 |
| samples/point | resident | failed / failed | failed / failed | failed / failed | failed; failed |
| samples/point | streaming | 2550.776 / 0.249 | 22.578 / 22.578 | 22.641 / 22.641 | 15.123/15.313; 15.123/15.129 |
| samples/hour | sqlite | 1.598 / 0.365 | 6.562 / 6.578 | 6.562 / 6.578 | 0.001/0.179; 0.001/0.179 |
| samples/hour | resident | 557.187 / 0.464 | 206.055 / 198.973 | 199.035 / 199.035 | 147.882/166.871; 147.882/148.060 |
| samples/hour | streaming | 105.415 / 1.709 | 7.836 / 7.840 | 7.898 / 7.902 | 0.039/0.443; 0.039/0.443 |
| samples/month | sqlite | 32.871 / 19.805 | 10.145 / 10.262 | 8.305 / 10.262 | 0.004/0.005; 0.004/0.005 |
| samples/month | resident | 1059.388 / 616.783 | 211.645 / 386.172 | 211.707 / 307.141 | 143.652/167.807; 143.652/310.496 |
| samples/month | streaming | 294.275 / 91.962 | 8.613 / 8.855 | 7.746 / 8.918 | 0.049/1.311; 0.049/1.311 |
| samples/ten | sqlite | 406.403 / 292.580 | 10.145 / 10.344 | 8.383 / 10.344 | 0.057/0.059; 0.057/0.059 |
| samples/ten | resident | 5197.456 / 4883.010 | 279.688 / 476.469 | 279.750 / 416.941 | 147.938/230.909; 147.938/367.011 |
| samples/ten | streaming | 1779.972 / 835.600 | 17.738 / 18.395 | 8.418 / 18.457 | 0.185/10.594; 0.185/10.594 |
| samples/append | sqlite | 10.690 / 7.475 | 9.551 / 9.551 | 9.551 / 9.551 | 0.001/1.960; 0.001/1.960 |
| samples/append | resident | 518.536 / 500.945 | 210.941 / 211.016 | 205.539 / 205.535 | 151.621/170.650; 151.621/170.650 |
| samples/append | streaming | 509.959 / 462.410 | 39.398 / 39.398 | 39.461 / 39.461 | 15.271/28.896; 15.271/28.896 |
| samples/open | sqlite | 0.587 / 0.198 | 6.074 / 6.074 | 6.074 / 6.074 | 0.001/0.003; 0.001/0.003 |
| samples/open | resident | 0.410 / 0.178 | 7.168 / 7.234 | 7.230 / 7.297 | 0.023/0.031; 0.023/0.031 |
| samples/open | streaming | 0.406 / 0.256 | 7.168 / 7.234 | 7.230 / 7.297 | 0.023/0.031; 0.023/0.031 |
| samples/idle | sqlite | 1000.066 / 1000.337 | 6.074 / 6.074 | 6.074 / 6.074 | 0.001/0.003; 0.001/0.003 |
| samples/idle | resident | 1000.078 / 1000.252 | 7.230 / 7.230 | 7.230 / 7.230 | 0.023/0.025; 0.023/0.025 |
| samples/idle | streaming | 1000.433 / 1000.440 | 7.230 / 7.230 | 7.230 / 7.230 | 0.023/0.025; 0.023/0.025 |
| raw/point | sqlite | 1.296 / 0.034 | 6.305 / 6.305 | 6.305 / 6.305 | 0.001/0.004; 0.001/0.004 |
| raw/point | resident | failed / failed | failed / failed | failed / failed | failed; failed |
| raw/point | streaming | 2879.890 / 3.254 | 22.836 / 22.840 | 22.898 / 22.902 | 15.300/15.510; 15.300/15.358 |
| raw/hour | sqlite | 1.854 / 0.296 | 6.566 / 6.574 | 6.566 / 6.574 | 0.001/0.180; 0.001/0.180 |
| raw/hour | resident | 3257.378 / 3134.927 | 92.488 / 110.566 | 76.188 / 110.625 | 5.910/75.444; 5.910/81.003 |
| raw/hour | streaming | 1442.702 / 314.995 | 11.988 / 12.387 | 8.398 / 12.449 | 0.356/4.791; 0.356/4.791 |
| raw/month | sqlite | 34.904 / 19.507 | 10.145 / 10.262 | 8.305 / 10.262 | 0.004/0.005; 0.004/0.005 |
| raw/month | resident | 3282.601 / 3167.672 | 92.234 / 110.293 | 75.848 / 110.352 | 5.913/75.286; 5.913/80.844 |
| raw/month | streaming | 1682.301 / 565.154 | 14.965 / 15.410 | 8.094 / 15.473 | 0.359/7.642; 0.359/7.642 |
| raw/ten | sqlite | 397.536 / 285.081 | 10.145 / 10.344 | 8.383 / 10.344 | 0.057/0.059; 0.057/0.059 |
| raw/ten | resident | 3443.967 / 3313.977 | 92.566 / 110.578 | 76.180 / 109.727 | 5.966/75.644; 5.966/81.203 |
| raw/ten | streaming | 2014.165 / 894.623 | 17.988 / 18.652 | 8.734 / 18.715 | 0.412/10.841; 0.412/10.841 |
| raw/append | sqlite | 11.156 / 7.898 | 9.609 / 9.609 | 9.609 / 9.609 | 0.001/1.967; 0.001/1.967 |
| raw/append | resident | failed / failed | failed / failed | failed / failed | failed; failed |
| raw/append | streaming | 862.254 / 739.943 | 39.668 / 39.668 | 39.730 / 39.730 | 17.463/29.326; 17.463/29.326 |
| raw/open | sqlite | 0.551 / 0.186 | 6.074 / 6.074 | 6.074 / 6.074 | 0.001/0.003; 0.001/0.003 |
| raw/open | resident | 2.682 / 2.386 | 7.254 / 7.320 | 7.316 / 7.383 | 0.059/0.068; 0.059/0.068 |
| raw/open | streaming | 2.694 / 2.430 | 7.254 / 7.320 | 7.316 / 7.383 | 0.059/0.068; 0.059/0.068 |
| raw/idle | sqlite | 1000.078 / 1000.081 | 6.074 / 6.074 | 6.074 / 6.074 | 0.001/0.003; 0.001/0.003 |
| raw/idle | resident | 1000.346 / 1000.329 | 7.316 / 7.316 | 7.316 / 7.316 | 0.059/0.061; 0.059/0.061 |
| raw/idle | streaming | 1000.335 / 1000.071 | 7.316 / 7.316 | 7.316 / 7.316 | 0.059/0.061; 0.059/0.061 |
| raw16/ten | sqlite | 390.034 / 288.193 | 10.145 / 10.344 | 8.383 / 10.344 | 0.057/0.059; 0.057/0.059 |
| raw16/ten | resident | 5112.768 / 5216.591 | 211.219 / 322.246 | 194.492 / 281.805 | 93.216/168.211; 93.216/258.072 |
| raw16/ten | streaming | 1909.727 / 929.127 | 17.738 / 18.348 | 8.434 / 18.410 | 0.195/10.604; 0.195/10.604 |

## Every #12 target

Ratios use the stated denominator; ≤ the limit passes in both cache modes. Append cannot pass without global duplicate checks. Same-durability qualification is unmeasured, not implied by timing. Partition growth is a controlled raw 16/256-shard aggregate, not the confounded samples/raw comparison.

| Target | Shape | Backend | Ratio cold / warm | Limit | Status | Note |
|---|---|---|---:|---:|---|---|
| point wall | samples | resident | failed / failed | 2 | **miss** |  |
| hour wall | samples | resident | 348.579× / 1.272× | 1.5 | **miss** |  |
| month wall | samples | resident | 32.228× / 31.143× | 1 | **miss** |  |
| ten wall | samples | resident | 12.789× / 16.689× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | samples | resident | 48.504× / 67.017× | 1 | **miss** | public create_many; global-conflict probe miss; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | samples | resident | 0.277× / 0.280× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | samples | resident | 0.277× / 0.277× | 1 | **pass** |  |
| point peak RSS | samples | resident | failed / failed | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | samples | resident | failed / failed | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | samples | resident | 31.399× / 30.248× | 2 | **miss** |  |
| hour retained RSS at 1 s / tolerance | samples | resident | 191.805× / 191.805× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | samples | resident | 20.863× / 37.632× | 2 | **miss** |  |
| month retained RSS at 1 s / tolerance | samples | resident | 91.674× / 71.620× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | samples | resident | 27.570× / 46.063× | 2 | **miss** |  |
| ten retained RSS at 1 s / tolerance | samples | resident | 118.046× / 95.962× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point wall | samples | streaming | 1593.910× / 7.829× | 2 | **miss** |  |
| hour wall | samples | streaming | 65.948× / 4.684× | 1.5 | **miss** |  |
| month wall | samples | streaming | 8.952× / 4.643× | 1 | **miss** |  |
| ten wall | samples | streaming | 4.380× / 2.856× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | samples | streaming | 47.702× / 61.862× | 1 | **miss** | public create_many; global-conflict probe pass; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | samples | streaming | 0.277× / 0.280× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | samples | streaming | 0.277× / 0.277× | 1 | **pass** |  |
| point peak RSS | samples | streaming | 3.581× / 3.581× | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | samples | streaming | 15.410× / 15.410× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | samples | streaming | 1.194× / 1.192× | 2 | **pass** |  |
| hour retained RSS at 1 s / tolerance | samples | streaming | 0.668× / 0.672× | 1 | **pass** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | samples | streaming | 0.849× / 0.863× | 2 | **pass** |  |
| month retained RSS at 1 s / tolerance | samples | streaming | 0.231× / 0.403× | 1 | **pass** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | samples | streaming | 1.749× / 1.778× | 2 | **pass** |  |
| ten retained RSS at 1 s / tolerance | samples | streaming | 0.514× / 2.629× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point wall | raw | resident | failed / failed | 2 | **miss** |  |
| hour wall | raw | resident | 1757.071× / 10584.820× | 1.5 | **miss** |  |
| month wall | raw | resident | 94.046× / 162.384× | 1 | **miss** |  |
| ten wall | raw | resident | 8.663× / 11.625× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | raw | resident | failed / failed | 1 | **miss** | public create_many; global-conflict probe pass; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | raw | resident | 0.281× / 0.283× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | raw | resident | 0.281× / 0.281× | 1 | **pass** |  |
| point peak RSS | raw | resident | failed / failed | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | raw | resident | failed / failed | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | raw | resident | 14.085× / 16.818× | 2 | **miss** |  |
| hour retained RSS at 1 s / tolerance | raw | resident | 68.871× / 103.309× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | raw | resident | 9.092× / 10.748× | 2 | **miss** |  |
| month retained RSS at 1 s / tolerance | raw | resident | 30.725× / 24.605× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | raw | resident | 9.125× / 10.690× | 2 | **miss** |  |
| ten retained RSS at 1 s / tolerance | raw | resident | 29.829× / 23.986× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point wall | raw | streaming | 2221.696× / 96.639× | 2 | **miss** |  |
| hour wall | raw | streaming | 778.212× / 1063.554× | 1.5 | **miss** |  |
| month wall | raw | streaming | 48.197× / 28.971× | 1 | **miss** |  |
| ten wall | raw | streaming | 5.067× / 3.138× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | raw | streaming | 77.293× / 93.689× | 1 | **miss** | public create_many; global-conflict probe pass; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | raw | streaming | 0.281× / 0.283× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | raw | streaming | 0.281× / 0.281× | 1 | **pass** |  |
| point peak RSS | raw | streaming | 3.622× / 3.623× | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | raw | streaming | 15.582× / 15.586× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | raw | streaming | 1.826× / 1.884× | 2 | **pass** |  |
| hour retained RSS at 1 s / tolerance | raw | streaming | 1.082× / 5.133× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | raw | streaming | 1.475× / 1.502× | 2 | **pass** |  |
| month retained RSS at 1 s / tolerance | raw | streaming | 0.349× / 1.948× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | raw | streaming | 1.773× / 1.803× | 2 | **pass** |  |
| ten retained RSS at 1 s / tolerance | raw | streaming | 0.614× / 2.670× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| peak RSS growth: 16 to 256 shards | raw | sqlite | 1.000× / 1.000× | 1 | **pass** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| peak RSS growth: 16 to 256 shards | raw | resident | 0.438× / 0.343× | 1 | **pass** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| peak RSS growth: 16 to 256 shards | raw | streaming | 1.014× / 1.017× | 1 | **miss** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| open real Logbook shape on rakku <= 1 s | all | all |  | None | **unmeasured** | rakku-only; no target access or real health data |
| absolute Celeron wall times | all | all |  | None | **unmeasured** | rakku-only; no target access or real health data |
| append equal power-loss durability | all | all |  | None | **unmeasured** | aka synthetic data only; native synced appends vs SQLite NORMAL are not equal durability |
