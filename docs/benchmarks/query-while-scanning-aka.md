# Query while scanning: integrated acceptance on aka

**Streaming misses #12 on aka: 12 measured target rows pass, 19 miss.**
The three rakku/durability qualifications remain unmeasured. This is not a cutover approval.

## Contract and method

Source: `267427c69c819a7612e50b596be12409019e0ba5` (`qws/integration`).
Streaming is opt-in; Resident remains the default. No engine code changed for
this verification. The [acceptance harness](../../bench/acceptance/README.md)
uses the public native APIs and SQLite NORMAL/WAL on the same synthetic records.

aka is x86_64, AMD Ryzen 5 7600X. Rust builds use
`RUSTFLAGS='-C target-cpu=x86-64-v2'`, the Celeron's instruction level, but aka
has a much faster CPU. These are proxy results, not Celeron qualification.
The [Stage 0 report](sqlite-baseline.md) ran on yari/aarch64. Its absolute times
are not compared with these aka times.

Each shape has 656,640 rows: January–October samples in 10 month files, or the
same records in 256 raw hash shards. Each cell plans three timing trials in
rotating backend order, plus an independent counting-allocator trial. Cold
trials evict only owned file pages; warm reads also prime the operation on the
same open runtime. Warm append warms file pages, not the ID locator or mutation.
Every measured process has a 1 GiB/no-swap systemd scope and nice 10. Matrix
operations time out at 180 s; fixture preparation at 600 s. Independent OOM
diagnostics keep the same limit, with an outer 185 s timeout and inner 180 s
operation timeout. The memory limit was never raised. No consumer `malloc_trim`
was used.

Verified: 342 matrix trials executed, 336 succeeded, six Resident trials were
SIGKILLed, and 18 later repetitions were skipped after those kills. Every
successful answer matched; all 40 successful appends persisted exactly 1,000
new rows. Streaming passed both cross-partition conflict probes. Resident's
sample probe failed; its raw probe does not prove a general global guarantee.
Six independent reproductions confirmed OOM in the six killed cells, with
`memory.peak=1,073,741,824` and `oom_kill=1` in each new scope.

## Target table

Cold / warm. Wall: median of three timing trials. Peak: maximum of three.
RSS at 1 s: median. The verdict pair is **Resident / Streaming**. SQLite is the
reference, not a separate contender. Limits stay unchanged: point ≤2×; hour
≤1.5×; month, ten and append ≤1×; read peak ≤2×; open/idle ≤SQLite +20 MiB.
For retained rows only, the ratio column divides the Streaming retained delta
by **max(SQLite's retained delta, 1 MiB)**, not by SQLite's raw RSS.
Verdicts use unrounded JSON values. A killed cell has no completed timing or
peak, never a zero-valued pass.

| #12 workload | Shape | SQLite | Resident | Streaming | Streaming / SQLite | Resident / Streaming |
|---|---|---:|---:|---:|---:|---|
| point wall ms | samples | 1.600 / 0.032 | killed / killed | 2550.776 / 0.249 | 1593.910× / 7.829× | miss / miss |
| hour wall ms | samples | 1.598 / 0.365 | 557.187 / 0.464 | 105.415 / 1.709 | 65.948× / 4.684× | miss / miss |
| month wall ms | samples | 32.871 / 19.805 | 1059.388 / 616.783 | 294.275 / 91.962 | 8.952× / 4.643× | miss / miss |
| ten wall ms | samples | 406.403 / 292.580 | 5197.456 / 4883.010 | 1779.972 / 835.600 | 4.380× / 2.856× | miss / miss |
| append wall ms | samples | 10.690 / 7.475 | 518.536 / 500.945 | 509.959 / 462.410 | 47.702× / 61.862× | miss / miss |
| open RSS MiB | samples | 6.074 / 6.074 | 7.230 / 7.297 | 7.230 / 7.297 | 1.190× / 1.201× | pass / pass |
| idle RSS MiB | samples | 6.074 / 6.074 | 7.230 / 7.230 | 7.230 / 7.230 | 1.190× / 1.190× | pass / pass |
| point peak MiB | samples | 6.305 / 6.305 | killed / killed | 22.578 / 22.578 | 3.581× / 3.581× | miss / miss |
| point retained MiB at 1 s | samples | 0.230 / 0.230 | killed / killed | 15.410 / 15.410 | 15.410× / 15.410× tolerance | miss / miss |
| hour peak MiB | samples | 6.562 / 6.578 | 206.055 / 198.973 | 7.836 / 7.840 | 1.194× / 1.192× | miss / pass |
| hour retained MiB at 1 s | samples | 0.488 / 0.504 | 191.805 / 191.805 | 0.668 / 0.672 | 0.668× / 0.672× tolerance | miss / pass |
| month peak MiB | samples | 10.145 / 10.262 | 211.645 / 386.172 | 8.613 / 8.855 | 0.849× / 0.863× | miss / pass |
| month retained MiB at 1 s | samples | 2.230 / 4.188 | 204.477 / 299.910 | 0.516 / 1.688 | 0.231× / 0.403× tolerance | miss / pass |
| ten peak MiB | samples | 10.145 / 10.344 | 279.688 / 476.469 | 17.738 / 18.395 | 1.749× / 1.778× | miss / pass |
| ten retained MiB at 1 s | samples | 2.309 / 4.270 | 272.520 / 409.711 | 1.188 / 11.227 | 0.514× / 2.629× tolerance | miss / miss |
| point wall ms | raw | 1.296 / 0.034 | killed / killed | 2879.890 / 3.254 | 2221.696× / 96.639× | miss / miss |
| hour wall ms | raw | 1.854 / 0.296 | 3257.378 / 3134.927 | 1442.702 / 314.995 | 778.212× / 1063.554× | miss / miss |
| month wall ms | raw | 34.904 / 19.507 | 3282.601 / 3167.672 | 1682.301 / 565.154 | 48.197× / 28.971× | miss / miss |
| ten wall ms | raw | 397.536 / 285.081 | 3443.967 / 3313.977 | 2014.165 / 894.623 | 5.067× / 3.138× | miss / miss |
| append wall ms | raw | 11.156 / 7.898 | killed / killed | 862.254 / 739.943 | 77.293× / 93.689× | miss / miss |
| open RSS MiB | raw | 6.074 / 6.074 | 7.316 / 7.383 | 7.316 / 7.383 | 1.205× / 1.215× | pass / pass |
| idle RSS MiB | raw | 6.074 / 6.074 | 7.316 / 7.316 | 7.316 / 7.316 | 1.205× / 1.205× | pass / pass |
| point peak MiB | raw | 6.305 / 6.305 | killed / killed | 22.836 / 22.840 | 3.622× / 3.623× | miss / miss |
| point retained MiB at 1 s | raw | 0.230 / 0.230 | killed / killed | 15.582 / 15.586 | 15.582× / 15.586× tolerance | miss / miss |
| hour peak MiB | raw | 6.566 / 6.574 | 92.488 / 110.566 | 11.988 / 12.387 | 1.826× / 1.884× | miss / pass |
| hour retained MiB at 1 s | raw | 0.492 / 0.500 | 68.871 / 103.309 | 1.082 / 5.133 | 1.082× / 5.133× tolerance | miss / miss |
| month peak MiB | raw | 10.145 / 10.262 | 92.234 / 110.293 | 14.965 / 15.410 | 1.475× / 1.502× | miss / pass |
| month retained MiB at 1 s | raw | 2.230 / 4.188 | 68.531 / 103.035 | 0.777 / 8.156 | 0.349× / 1.948× tolerance | miss / miss |
| ten peak MiB | raw | 10.145 / 10.344 | 92.566 / 110.578 | 17.988 / 18.652 | 1.773× / 1.803× | miss / pass |
| ten retained MiB at 1 s | raw | 2.309 / 4.270 | 68.863 / 102.410 | 1.418 / 11.398 | 0.614× / 2.670× tolerance | miss / miss |

Equal-row-count peak RSS, 16→256 raw shards. Ratios are 256/16, cold / warm; limit ≤1 with no invented tolerance. This is a controlled observed proxy, not a scaling proof.

| Backend | 16-shard peak MiB C/W | 256-shard peak MiB C/W | Growth C/W | Status |
|---|---:|---:|---:|---|
| sqlite | 10.145 / 10.344 | 10.145 / 10.344 | 1.000000× / 1.000000× | pass |
| resident | 211.219 / 322.246 | 92.566 / 110.578 | 0.438249× / 0.343148× | pass |
| streaming | 17.738 / 18.348 | 17.988 / 18.652 | 1.014094× / 1.016606× | miss |

## Misses: floors, causes and cheapest next steps

The [per-target floor table](../../bench/acceptance/results/floors.md) covers
every measured miss. A floor there is the best observed trial, not a proof that
an optimized text engine cannot do better. Performance status still uses the
median and maximum peak. No target is lowered. Causes below are inferred from
source inspection and the measurements; proposed remedies are not measured fixes.

| Miss category | Reason | Cheapest next step and cost |
|---|---|---|
| First-use point latency | `locate::lookup` validates every payload once per generation, then builds global ID membership. A timestamp in an ID is not a routing guarantee. | Fuse validation/index work and use a prepared decoder first. A persistent checked locator/validation cache needs policy approval, schema/generation invalidation and extra disk; moving work into open does not remove it. |
| Warm point latency | Public lookup lists partitions and checks generations for validation and the locator. A SQLite cached primary-key probe does less host work. | Fuse repeated generation/stat work. The 256-shard case still needs fewer trustworthy host probes; do not silently trust a stale index or change this ID-only workload to a hinted lookup. |
| Range/aggregate wall time | First use builds time indexes by decoding full owned JSON values, then scans again. Warm reads still validate borrowed rows, check duplicates and fold. Raw ranges fan out across 256 files; stride 1,024 is coarse beside 2,565 rows/shard on average. | Test field-only index decoding and avoid redundant index work for full-file scans, preserving validation/error contracts. Then profile validation/folding and denser or cross-shard raw checkpoints; denser checkpoints retain more metadata. Persistent indexes or level 2 remain approval-gated and add invalidation/disk costs. No fix is proved here. |
| Point peak and retained RSS | The ID locator retains about 24 bytes per row, independently of record payloads; this metadata counts against the strict fresh-idle delta. | Compact or make the locator evictable. Eviction helps retained RSS, not the build peak, and trades it for repeat build/validation latency. A bounded/paged build may be needed for peak; a persistent artifact needs approval. No compaction size is proved sufficient here. |
| Other read peak/retained RSS | Query-local identity entries cost about 16 bytes per visited row. Freed requested heap and allocator-retained RSS are different quantities. | Compact/reuse identity workspace; test a query-scoped release policy without consumer trim. Keeping scratch capacity can improve speed but worsens the stated retained-RSS target. |
| Append wall time | A fresh runtime builds global membership. Preparation and conflict checks read target bytes; durable raw appends touch many files. SQLite NORMAL WAL has a different power-loss contract. | Reuse a checked locator and avoid repeated prefix work with a trustworthy host generation token. Persistent metadata needs approval. Do not add an untimed benchmark preflight or weaken native sync guarantees; equal durability is still unqualified. |
| Partition-count peak growth | Same-row-count 16/256-shard RSS includes per-file metadata and allocator variation, not just row workspace. A strict observed ≤1 ratio has no invented tolerance. | Compact per-file metadata and repeat a controlled sweep. This may increase manifest/stat work; one proxy sweep cannot prove constant memory. |
| Resident misses | Resident materializes/indexes full partitions. ID lookup loads its full scope; raw batch append can hold all routed shards at once. Its sample conflict probe does not provide global duplicate safety. | Adopt the opt-in Streaming API where consumer semantics permit, then address its remaining misses above. This is not a completed consumer cutover or a remedy for every target. |

## Counting-allocator evidence

| Streaming workload | Rust live/peak MiB cold; warm | RSS at 1 s MiB C/W |
|---|---:|---:|
| samples/point | 15.123/15.313; 15.123/15.129 | 22.641 / 22.641 |
| samples/ten | 0.185/10.594; 0.185/10.594 | 8.418 / 18.457 |
| raw/point | 15.300/15.510; 15.300/15.358 | 22.898 / 22.902 |
| raw/ten | 0.412/10.841; 0.412/10.841 | 8.734 / 18.715 |
| raw/append | 17.463/29.326; 17.463/29.326 | 39.730 / 39.730 |

Rust live/peak bytes are requested allocations, not RSS or glibc arenas. The
meter is a separate binary; its wall times do not enter the timing medians.
SQLite C heap is recorded separately in JSONL. The full table also has Resident
and the other shape/workload cells. A low live heap does not prove return to
idle when freed pages remain in the allocator.

## Qualifications and evidence

| Target | Status | Reason |
|---|---|---|
| Open ≤1 s on Logbook's real shape on rakku | **Unmeasured** | No rakku access by user rule; synthetic aka open is not this target. |
| Absolute Celeron times, including ten-month ≤SQLite on rakku | **Unmeasured** | No rakku access by user rule. x86-64-v2 on a Ryzen does not establish Celeron latency. |
| Equal-durability append qualification | **Unmeasured** | No rakku access by user rule; native synced text and SQLite NORMAL WAL also have different power-loss guarantees. The timing comparison does not make them equal. |

Full tables and numeric verdicts: [Markdown](../../bench/acceptance/results/latest.md),
[JSONL](../../bench/acceptance/results/latest.jsonl). Exact source, load blocks,
checks and cleanup: [provenance](../../bench/acceptance/results/provenance.md) and
[evidence JSON](../../bench/acceptance/results/evidence.json).
