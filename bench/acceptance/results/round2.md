# Query-while-scanning acceptance on aka

The removed Resident backend is omitted; #12 targets judge Streaming against SQLite. Synthetic x86-64-v2 proxy, not rakku/Celeron qualification. Cold / warm. A failed trial makes its cell a miss; killed trials are not zero. Timing medians; RSS peak maximum; heap is a separate instrumented trial.

Timing repeats: 3. Trials: 272; failures: 0; skipped after kill: 0.

| Shape / workload | Backend | Wall ms C/W | Peak RSS MiB C/W | RSS at 1 s MiB C/W | Rust live/peak MiB cold; warm |
|---|---|---:|---:|---:|---|
| samples/point | sqlite | 1.135 / 0.029 | 6.227 / 6.227 | 6.227 / 6.227 | 0.001/0.004; 0.001/0.004 |
| samples/point | streaming | 650.096 / 0.248 | 17.809 / 17.809 | 17.871 / 17.871 | 10.091/10.287; 10.091/10.098 |
| samples/hour | sqlite | 1.658 / 0.410 | 6.480 / 6.500 | 6.480 / 6.500 | 0.001/0.179; 0.001/0.179 |
| samples/hour | streaming | 52.752 / 0.342 | 8.473 / 8.047 | 8.109 / 8.109 | 0.418/1.288; 0.418/0.730 |
| samples/month | sqlite | 33.570 / 19.544 | 10.004 / 10.184 | 8.227 / 10.184 | 0.004/0.005; 0.004/0.005 |
| samples/month | streaming | 105.703 / 46.760 | 8.973 / 8.820 | 8.246 / 8.883 | 0.639/1.880; 0.639/1.381 |
| samples/ten | sqlite | 413.099 / 287.973 | 10.129 / 10.266 | 8.305 / 10.266 | 0.057/0.059; 0.057/0.059 |
| samples/ten | streaming | 530.105 / 432.924 | 13.098 / 13.605 | 8.816 / 13.668 | 0.474/6.053; 0.474/6.053 |
| samples/append | sqlite | 10.205 / 7.803 | 9.473 / 9.473 | 9.473 / 9.473 | 0.001/1.960; 0.001/1.960 |
| samples/append | streaming | 370.443 / 316.396 | 34.848 / 34.973 | 34.359 / 34.359 | 10.116/26.919; 10.116/26.919 |
| samples/append-range | sqlite | 12.467 / 10.271 | 9.516 / 9.516 | 9.516 / 9.516 | 0.001/2.202; 0.001/2.202 |
| samples/append-range | streaming | 365.828 / 320.429 | 35.152 / 35.160 | 34.492 / 34.488 | 10.519/27.314; 10.519/27.314 |
| samples/open | sqlite | 0.617 / 0.184 | 5.996 / 5.996 | 5.996 / 5.996 | 0.001/0.003; 0.001/0.003 |
| samples/open | streaming | 0.409 / 0.170 | 6.969 / 7.160 | 7.094 / 7.223 | 0.023/0.031; 0.023/0.031 |
| samples/idle | sqlite | 1000.083 / 1000.346 | 5.996 / 5.996 | 5.996 / 5.996 | 0.001/0.003; 0.001/0.003 |
| samples/idle | streaming | 1000.336 / 1000.097 | 7.094 / 7.094 | 7.094 / 7.094 | 0.023/0.025; 0.023/0.025 |
| raw/point | sqlite | 1.229 / 0.029 | 6.227 / 6.227 | 6.227 / 6.227 | 0.001/0.004; 0.001/0.004 |
| raw/point | streaming | 835.128 / 3.055 | 18.113 / 18.113 | 18.176 / 18.176 | 10.277/10.616; 10.277/10.338 |
| raw/hour | sqlite | 2.245 / 0.297 | 6.488 / 6.496 | 6.488 / 6.496 | 0.001/0.180; 0.001/0.180 |
| raw/hour | streaming | 616.902 / 10.361 | 16.371 / 11.559 | 11.555 / 11.621 | 3.482/8.897; 3.482/3.898 |
| raw/month | sqlite | 31.621 / 19.303 | 10.129 / 10.184 | 8.227 / 10.184 | 0.004/0.005; 0.004/0.005 |
| raw/month | streaming | 612.672 / 54.556 | 16.348 / 11.980 | 11.387 / 12.043 | 3.485/8.758; 3.485/4.320 |
| raw/ten | sqlite | 412.871 / 284.169 | 10.254 / 10.266 | 8.305 / 10.266 | 0.057/0.059; 0.057/0.059 |
| raw/ten | streaming | 659.825 / 476.976 | 16.723 / 17.062 | 12.270 / 17.125 | 3.538/9.147; 3.538/9.147 |
| raw/append | sqlite | 11.737 / 8.266 | 9.531 / 9.531 | 9.531 / 9.531 | 0.001/1.967; 0.001/1.967 |
| raw/append | streaming | 771.813 / 632.619 | 34.762 / 34.688 | 34.750 / 34.750 | 12.452/24.318; 12.452/24.318 |
| raw/append-range | sqlite | 13.760 / 10.924 | 9.625 / 9.629 | 9.625 / 9.625 | 0.001/2.209; 0.001/2.209 |
| raw/append-range | streaming | 624.332 / 622.926 | 38.512 / 38.512 | 38.574 / 38.574 | 15.085/27.745; 15.085/27.745 |
| raw/open | sqlite | 0.693 / 0.186 | 5.996 / 5.996 | 5.996 / 5.996 | 0.001/0.003; 0.001/0.003 |
| raw/open | streaming | 2.886 / 2.425 | 7.070 / 7.203 | 7.133 / 7.266 | 0.061/0.069; 0.061/0.069 |
| raw/idle | sqlite | 1000.348 / 1000.068 | 5.996 / 5.996 | 5.996 / 5.996 | 0.001/0.003; 0.001/0.003 |
| raw/idle | streaming | 1000.341 / 1000.291 | 7.133 / 7.133 | 7.133 / 7.133 | 0.061/0.063; 0.061/0.063 |
| raw16/ten | sqlite | 418.980 / 286.214 | 10.129 / 10.266 | 8.305 / 10.266 | 0.057/0.059; 0.057/0.059 |
| raw16/ten | streaming | 573.631 / 454.637 | 15.223 / 15.988 | 11.031 / 16.051 | 3.314/8.893; 3.314/8.894 |

## Every #12 target

Ratios use the stated denominator; ≤ the limit passes in both cache modes. Append cannot pass without global duplicate checks. Same-durability qualification is unmeasured, not implied by timing. Partition growth is a controlled raw 16/256-shard aggregate, not the confounded samples/raw comparison.

| Target | Shape | Backend | Ratio cold / warm | Limit | Status | Note |
|---|---|---|---:|---:|---|---|
| point wall | samples | streaming | 572.941× / 8.465× | 2 | **miss** |  |
| hour wall | samples | streaming | 31.823× / 0.835× | 1.5 | **miss** |  |
| month wall | samples | streaming | 3.149× / 2.393× | 1 | **miss** |  |
| ten wall | samples | streaming | 1.283× / 1.503× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | samples | streaming | 36.301× / 40.546× | 1 | **miss** | public create_many; global-conflict probe pass; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | samples | streaming | 0.273× / 0.278× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | samples | streaming | 0.273× / 0.273× | 1 | **pass** |  |
| point peak RSS | samples | streaming | 2.860× / 2.860× | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | samples | streaming | 10.777× / 10.777× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | samples | streaming | 1.307× / 1.238× | 2 | **pass** |  |
| hour retained RSS at 1 s / tolerance | samples | streaming | 1.016× / 1.016× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | samples | streaming | 0.897× / 0.866× | 2 | **pass** |  |
| month retained RSS at 1 s / tolerance | samples | streaming | 0.517× / 0.427× | 1 | **pass** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | samples | streaming | 1.293× / 1.325× | 2 | **pass** |  |
| ten retained RSS at 1 s / tolerance | samples | streaming | 0.746× / 1.540× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point wall | raw | streaming | 679.563× / 106.616× | 2 | **miss** |  |
| hour wall | raw | streaming | 274.828× / 34.925× | 1.5 | **miss** |  |
| month wall | raw | streaming | 19.375× / 2.826× | 1 | **miss** |  |
| ten wall | raw | streaming | 1.598× / 1.678× | 1 | **miss** | aka proxy; rakku absolute time unmeasured |
| append wall | raw | streaming | 65.762× / 76.537× | 1 | **miss** | public create_many; global-conflict probe pass; NORMAL is the requested bar, not equal power-loss durability |
| open RSS / (SQLite + 20 MiB) | raw | streaming | 0.274× / 0.279× | 1 | **pass** |  |
| idle RSS / (SQLite + 20 MiB) | raw | streaming | 0.274× / 0.274× | 1 | **pass** |  |
| point peak RSS | raw | streaming | 2.909× / 2.909× | 2 | **miss** |  |
| point retained RSS at 1 s / tolerance | raw | streaming | 11.043× / 11.043× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| hour peak RSS | raw | streaming | 2.523× / 1.779× | 2 | **miss** |  |
| hour retained RSS at 1 s / tolerance | raw | streaming | 4.422× / 4.488× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| month peak RSS | raw | streaming | 1.614× / 1.176× | 2 | **pass** |  |
| month retained RSS at 1 s / tolerance | raw | streaming | 1.907× / 1.173× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| ten peak RSS | raw | streaming | 1.631× / 1.662× | 2 | **pass** |  |
| ten retained RSS at 1 s / tolerance | raw | streaming | 2.225× / 2.340× | 1 | **miss** | tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim |
| point retained RSS after release at 1 s / tolerance | samples | streaming | 0.754× / 0.754× | 1 | **pass** | one second after explicit release; no trim; warm point includes a prior lookup |
| point retained RSS after release at 1 s / tolerance | raw | streaming | 1.020× / 1.020× | 1 | **miss** | one second after explicit release; no trim; warm point includes a prior lookup |
| peak RSS growth: 16 to 256 shards | raw | sqlite | 1.012× / 1.000× | 1 | **miss** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| peak RSS growth: 16 to 256 shards | raw | streaming | 1.099× / 1.067× | 1 | **miss** | same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise |
| open real Logbook shape on rakku <= 1 s | all | all |  | None | **unmeasured** | rakku-only; no target access or real health data |
| absolute Celeron wall times | all | all |  | None | **unmeasured** | rakku-only; no target access or real health data |
| append equal power-loss durability | all | all |  | None | **unmeasured** | aka synthetic data only; native synced appends vs SQLite NORMAL are not equal durability |
