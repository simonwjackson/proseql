# Query-while-scanning acceptance on aka

Resident is the reference baseline; #12 targets judge Streaming against SQLite. Synthetic x86-64-v2 proxy, not rakku/Celeron qualification. Cold / warm. A failed trial makes its cell a miss; killed trials are not zero. Timing medians; RSS peak maximum; heap is a separate instrumented trial.

Timing repeats: 3. Trials: 324; failures: 12; skipped after kill: 36.

| Shape / workload | Backend | Wall ms C/W | Peak RSS MiB C/W | RSS at 1 s MiB C/W | Rust live/peak MiB cold; warm |
|---|---|---:|---:|---:|---|
| samples/point | sqlite | 1.563 / 0.034 | 6.129 / 6.129 | 6.129 / 6.129 | 0.001/0.004; 0.001/0.004 |
| samples/point | resident | failed / failed | failed / failed | failed / failed | failed; failed |
| samples/point | streaming | failed / failed | failed / failed | failed / failed | failed; failed |
| samples/hour | sqlite | 1.702 / 0.310 | 6.387 / 6.402 | 6.387 / 6.402 | 0.001/0.179; 0.001/0.179 |
| samples/hour | resident | 563.737 / 0.395 | 205.750 / 198.418 | 198.484 / 198.480 | 147.877/166.866; 147.877/148.056 |
| samples/hour | streaming | 559.398 / 0.473 | 205.691 / 198.418 | 198.484 / 198.480 | 147.877/166.866; 147.877/148.056 |
| samples/month | sqlite | 34.167 / 19.997 | 9.836 / 10.086 | 8.129 / 10.086 | 0.004/0.005; 0.004/0.005 |
| samples/month | resident | 1042.775 / 624.294 | 210.910 / 384.816 | 210.973 / 306.668 | 143.647/167.802; 143.647/310.491 |
| samples/month | streaming | 1029.516 / 622.374 | 210.910 / 385.625 | 210.973 / 306.645 | 143.647/167.802; 143.647/310.491 |
| samples/ten | sqlite | 401.005 / 296.138 | 9.961 / 10.168 | 8.207 / 10.168 | 0.057/0.059; 0.057/0.059 |
| samples/ten | resident | 5258.020 / 4895.632 | 279.320 / 475.879 | 279.383 / 426.719 | 147.933/230.904; 147.933/367.006 |
| samples/ten | streaming | 5258.688 / 4880.813 | 279.320 / 464.723 | 279.383 / 459.891 | 147.933/230.904; 147.933/367.006 |
| samples/append | sqlite | 10.765 / 7.970 | 9.375 / 9.375 | 9.375 / 9.375 | 0.001/1.960; 0.001/1.960 |
| samples/append | resident | 520.666 / 493.136 | 210.340 / 210.488 | 204.984 / 204.984 | 151.616/170.645; 151.616/170.645 |
| samples/append | streaming | 507.994 / 495.969 | 210.414 / 210.523 | 204.984 / 204.984 | 151.616/170.645; 151.616/170.645 |
| samples/open | sqlite | 0.592 / 0.209 | 5.949 / 5.949 | 5.949 / 5.949 | 0.001/0.003; 0.001/0.003 |
| samples/open | resident | 0.373 / 0.254 | 6.734 / 6.863 | 6.797 / 6.926 | 0.018/0.024; 0.018/0.024 |
| samples/open | streaming | 0.379 / 0.303 | 6.734 / 6.863 | 6.797 / 6.926 | 0.018/0.024; 0.018/0.024 |
| samples/idle | sqlite | 1000.066 / 1000.078 | 5.949 / 5.949 | 5.949 / 5.949 | 0.001/0.003; 0.001/0.003 |
| samples/idle | resident | 1000.088 / 1000.081 | 6.797 / 6.797 | 6.797 / 6.797 | 0.018/0.020; 0.018/0.020 |
| samples/idle | streaming | 1000.078 / 1000.078 | 6.797 / 6.797 | 6.797 / 6.797 | 0.018/0.020; 0.018/0.020 |
| raw/point | sqlite | 1.647 / 0.034 | 6.129 / 6.129 | 6.129 / 6.129 | 0.001/0.004; 0.001/0.004 |
| raw/point | resident | failed / failed | failed / failed | failed / failed | failed; failed |
| raw/point | streaming | failed / failed | failed / failed | failed / failed | failed; failed |
| raw/hour | sqlite | 1.971 / 0.356 | 6.391 / 6.398 | 6.391 / 6.398 | 0.001/0.180; 0.001/0.180 |
| raw/hour | resident | 3286.599 / 3173.430 | 92.020 / 109.992 | 75.660 / 110.051 | 5.905/75.439; 5.905/80.997 |
| raw/hour | streaming | 3396.858 / 3159.732 | 91.941 / 110.004 | 75.660 / 110.055 | 5.905/75.439; 5.905/80.997 |
| raw/month | sqlite | 34.590 / 19.361 | 9.961 / 10.086 | 8.129 / 10.086 | 0.004/0.005; 0.004/0.005 |
| raw/month | resident | 3308.903 / 3201.186 | 91.820 / 109.797 | 75.477 / 109.844 | 5.908/75.281; 5.908/80.839 |
| raw/month | streaming | 3300.048 / 3225.037 | 91.777 / 109.801 | 75.477 / 109.863 | 5.908/75.281; 5.908/80.839 |
| raw/ten | sqlite | 394.876 / 288.482 | 9.836 / 10.168 | 8.207 / 10.168 | 0.057/0.059; 0.057/0.059 |
| raw/ten | resident | 3451.300 / 3372.341 | 91.977 / 110.832 | 75.742 / 110.891 | 5.961/75.639; 5.961/81.198 |
| raw/ten | streaming | 3464.331 / 3354.531 | 92.102 / 110.840 | 75.742 / 110.902 | 5.961/75.639; 5.961/81.198 |
| raw/append | sqlite | 11.423 / 8.162 | 9.434 / 9.434 | 9.434 / 9.434 | 0.001/1.967; 0.001/1.967 |
| raw/append | resident | failed / failed | failed / failed | failed / failed | failed; failed |
| raw/append | streaming | failed / failed | failed / failed | failed / failed | failed; failed |
| raw/open | sqlite | 0.585 / 0.247 | 5.949 / 5.949 | 5.949 / 5.949 | 0.001/0.003; 0.001/0.003 |
| raw/open | resident | 2.751 / 2.631 | 6.824 / 6.953 | 6.887 / 7.016 | 0.054/0.060; 0.054/0.060 |
| raw/open | streaming | 2.769 / 2.507 | 6.824 / 6.953 | 6.887 / 7.016 | 0.054/0.060; 0.054/0.060 |
| raw/idle | sqlite | 1000.073 / 1000.090 | 5.949 / 5.949 | 5.949 / 5.949 | 0.001/0.003; 0.001/0.003 |
| raw/idle | resident | 1000.078 / 1000.083 | 6.887 / 6.887 | 6.887 / 6.887 | 0.054/0.056; 0.054/0.056 |
| raw/idle | streaming | 1000.078 / 1000.067 | 6.887 / 6.887 | 6.887 / 6.887 | 0.054/0.056; 0.054/0.056 |
| raw16/ten | sqlite | 381.521 / 297.017 | 9.961 / 10.168 | 8.207 / 10.168 | 0.057/0.059; 0.057/0.059 |
| raw16/ten | resident | 6811.492 / 5559.357 | 218.305 / 344.621 | 187.109 / 281.832 | 93.211/168.206; 93.211/258.067 |
| raw16/ten | streaming | 5098.298 / 5983.517 | 218.422 / 350.422 | 187.109 / 281.824 | 93.211/168.206; 93.211/258.067 |

## Every #12 target

Ratios use the stated denominator; ≤ the limit passes in both cache modes. Append cannot pass without global duplicate checks. Same-durability qualification is unmeasured, not implied by timing. Partition growth is a controlled raw 16/256-shard aggregate, not the confounded samples/raw comparison.

| Target | Shape | Backend | Ratio cold / warm | Limit | Status | Note |
|---|---|---|---:|---:|---|---|
| point wall | samples | resident | failed / failed | 2 | **miss** |  |
| hour wall | samples | resident | 331.190× / 1.275× | 1.5 | **miss** |  |
| month wall | samples | resident | 30.520× / 31.220× | 1 | **miss** |  |
| ten wall | samples | resident | 13.112× / 16.532× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | samples | resident | 48.366× / 61.878× | 1 | **miss** | public create_many; global-conflict probe miss; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | samples | resident | 0.262× / 0.267× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | samples | resident | 0.262× / 0.262× | 1 | **pass** |  |
| point peak RSS | samples | resident | failed / failed | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | samples | resident | failed / failed | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | samples | resident | 32.215× / 30.991× | 2 | **miss** |  |
| hour retained RSS at 1 s / tolerance | samples | resident | 191.688× / 191.684× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | samples | resident | 21.443× / 38.154× | 2 | **miss** |  |
| month retained RSS at 1 s / tolerance | samples | resident | 93.672× / 72.490× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | samples | resident | 28.042× / 46.802× | 2 | **miss** |  |
| ten retained RSS at 1 s / tolerance | samples | resident | 120.730× / 99.537× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point wall | samples | streaming | failed / failed | 2 | **miss** |  |
| hour wall | samples | streaming | 328.641× / 1.527× | 1.5 | **miss** |  |
| month wall | samples | streaming | 30.132× / 31.124× | 1 | **miss** |  |
| ten wall | samples | streaming | 13.114× / 16.482× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | samples | streaming | 47.189× / 62.233× | 1 | **miss** | public create_many; global-conflict probe miss; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | samples | streaming | 0.262× / 0.267× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | samples | streaming | 0.262× / 0.262× | 1 | **pass** |  |
| point peak RSS | samples | streaming | failed / failed | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | samples | streaming | failed / failed | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | samples | streaming | 32.206× / 30.991× | 2 | **miss** |  |
| hour retained RSS at 1 s / tolerance | samples | streaming | 191.688× / 191.684× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | samples | streaming | 21.443× / 38.234× | 2 | **miss** |  |
| month retained RSS at 1 s / tolerance | samples | streaming | 93.672× / 72.484× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | samples | streaming | 28.042× / 45.705× | 2 | **miss** |  |
| ten retained RSS at 1 s / tolerance | samples | streaming | 120.730× / 107.400× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point wall | raw | resident | failed / failed | 2 | **miss** |  |
| hour wall | raw | resident | 1667.687× / 8905.249× | 1.5 | **miss** |  |
| month wall | raw | resident | 95.660× / 165.342× | 1 | **miss** |  |
| ten wall | raw | resident | 8.740× / 11.690× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | raw | resident | failed / failed | 1 | **miss** | public create_many; global-conflict probe pass; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | raw | resident | 0.265× / 0.270× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | raw | resident | 0.265× / 0.265× | 1 | **pass** |  |
| point peak RSS | raw | resident | failed / failed | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | raw | resident | failed / failed | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | raw | resident | 14.399× / 17.190× | 2 | **miss** |  |
| hour retained RSS at 1 s / tolerance | raw | resident | 68.773× / 103.164× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | raw | resident | 9.218× / 10.886× | 2 | **miss** |  |
| month retained RSS at 1 s / tolerance | raw | resident | 31.468× / 24.889× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | raw | resident | 9.351× / 10.900× | 2 | **miss** |  |
| ten retained RSS at 1 s / tolerance | raw | resident | 30.497× / 24.653× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point wall | raw | streaming | failed / failed | 2 | **miss** |  |
| hour wall | raw | streaming | 1723.635× / 8866.811× | 1.5 | **miss** |  |
| month wall | raw | streaming | 95.404× / 166.574× | 1 | **miss** |  |
| ten wall | raw | streaming | 8.773× / 11.628× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | raw | streaming | failed / failed | 1 | **miss** | public create_many; global-conflict probe pass; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | raw | streaming | 0.265× / 0.270× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | raw | streaming | 0.265× / 0.265× | 1 | **pass** |  |
| point peak RSS | raw | streaming | failed / failed | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | raw | streaming | failed / failed | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | raw | streaming | 14.387× / 17.192× | 2 | **miss** |  |
| hour retained RSS at 1 s / tolerance | raw | streaming | 68.773× / 103.168× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | raw | streaming | 9.214× / 10.887× | 2 | **miss** |  |
| month retained RSS at 1 s / tolerance | raw | streaming | 31.468× / 24.893× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | raw | streaming | 9.364× / 10.901× | 2 | **miss** |  |
| ten retained RSS at 1 s / tolerance | raw | streaming | 30.497× / 24.656× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| peak RSS growth: 16 to 256 shards | raw | sqlite | 0.987× / 1.000× | 1 | **pass** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| peak RSS growth: 16 to 256 shards | raw | resident | 0.421× / 0.322× | 1 | **pass** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| peak RSS growth: 16 to 256 shards | raw | streaming | 0.422× / 0.316× | 1 | **pass** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| open real Logbook shape on rakku <= 1 s | all | all |  | None | **unmeasured** | rakku-only; no target access or real health data |
| absolute Celeron wall times | all | all |  | None | **unmeasured** | rakku-only; no target access or real health data |
| append equal power-loss durability | all | all |  | None | **unmeasured** | aka synthetic data only; native synced appends vs SQLite NORMAL are not equal durability |
