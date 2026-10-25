# Observed miss floors

Cold / warm. Timing: fastest of three completed trials. Peak: smallest observed timing-trial peak. Retained: smallest post-read RSS delta against the median fresh-idle baseline. These are observed bounds, not physical or optimized-code lower bounds. Status still uses medians / maximum peak, not these minima. SIGKILL has no completed operation value. The OOM RSS bounds below come from six independent reproductions, not the matrix trials; see [oom.json](oom.json). A fresh scope reached its 1 GiB cgroup charge limit and recorded `oom_kill=1` in every reproduction. RSS and cgroup charge differ: RSS can include shared pages charged elsewhere. No completed wall-time or retained-RSS floor exists for a killed operation. Causes and cheapest next steps are in docs/benchmarks/query-while-scanning-aka.md; recommendations are not measured fixes.

| Missed target | Shape | Backend | Observed floor C/W | Target ratios C/W |
|---|---|---|---:|---:|
| point wall | samples | resident | OOM; RSS ≥1027.125 MiB; no completed value / OOM; RSS ≥969.004 MiB; no completed value | unavailable / unavailable |
| hour wall | samples | resident | 544.453 ms / 0.456 ms | 348.579× / 1.272× |
| month wall | samples | resident | 1056.596 ms / 613.016 ms | 32.228× / 31.143× |
| ten wall | samples | resident | 5196.712 ms / 4880.276 ms | 12.789× / 16.689× |
| append wall | samples | resident | 505.319 ms / 496.594 ms | 48.504× / 67.017× |
| point peak RSS | samples | resident | OOM; RSS ≥1027.125 MiB; no completed value / OOM; RSS ≥969.004 MiB; no completed value | unavailable / unavailable |
| point retained RSS at 1 s / tolerance | samples | resident | OOM; RSS ≥1027.125 MiB; no completed value / OOM; RSS ≥969.004 MiB; no completed value | unavailable / unavailable |
| hour peak RSS | samples | resident | 206.004 MiB / 198.973 MiB | 31.399× / 30.248× |
| hour retained RSS at 1 s / tolerance | samples | resident | +191.805 MiB / +191.805 MiB | 191.805× / 191.805× |
| month peak RSS | samples | resident | 211.645 MiB / 384.996 MiB | 20.863× / 37.632× |
| month retained RSS at 1 s / tolerance | samples | resident | +204.477 MiB / +283.297 MiB | 91.674× / 71.620× |
| ten peak RSS | samples | resident | 279.523 MiB / 460.453 MiB | 27.570× / 46.063× |
| ten retained RSS at 1 s / tolerance | samples | resident | +272.355 MiB / +409.703 MiB | 118.046× / 95.962× |
| point wall | samples | streaming | 2549.778 ms / 0.247 ms | 1593.910× / 7.829× |
| hour wall | samples | streaming | 104.335 ms / 1.462 ms | 65.948× / 4.684× |
| month wall | samples | streaming | 292.585 ms / 91.314 ms | 8.952× / 4.643× |
| ten wall | samples | streaming | 1770.724 ms / 835.365 ms | 4.380× / 2.856× |
| append wall | samples | streaming | 478.523 ms / 435.037 ms | 47.702× / 61.862× |
| point peak RSS | samples | streaming | 22.578 MiB / 22.578 MiB | 3.581× / 3.581× |
| point retained RSS at 1 s / tolerance | samples | streaming | +15.410 MiB / +15.410 MiB | 15.410× / 15.410× |
| ten retained RSS at 1 s / tolerance | samples | streaming | +1.188 MiB / +11.227 MiB | 0.514× / 2.629× |
| point wall | raw | resident | OOM; RSS ≥1008.785 MiB; no completed value / OOM; RSS ≥1000.961 MiB; no completed value | unavailable / unavailable |
| hour wall | raw | resident | 3228.488 ms / 3119.411 ms | 1757.071× / 10584.820× |
| month wall | raw | resident | 3266.192 ms / 3165.662 ms | 94.046× / 162.384× |
| ten wall | raw | resident | 3435.892 ms / 3307.582 ms | 8.663× / 11.625× |
| append wall | raw | resident | OOM; RSS ≥1017.391 MiB; no completed value / OOM; RSS ≥1001.668 MiB; no completed value | unavailable / unavailable |
| point peak RSS | raw | resident | OOM; RSS ≥1008.785 MiB; no completed value / OOM; RSS ≥1000.961 MiB; no completed value | unavailable / unavailable |
| point retained RSS at 1 s / tolerance | raw | resident | OOM; RSS ≥1008.785 MiB; no completed value / OOM; RSS ≥1000.961 MiB; no completed value | unavailable / unavailable |
| hour peak RSS | raw | resident | 92.266 MiB / 110.555 MiB | 14.085× / 16.818× |
| hour retained RSS at 1 s / tolerance | raw | resident | +68.871 MiB / +103.301 MiB | 68.871× / 103.309× |
| month peak RSS | raw | resident | 92.008 MiB / 110.289 MiB | 9.092× / 10.748× |
| month retained RSS at 1 s / tolerance | raw | resident | +68.531 MiB / +103.035 MiB | 30.725× / 24.605× |
| ten peak RSS | raw | resident | 92.449 MiB / 109.664 MiB | 9.125× / 10.690× |
| ten retained RSS at 1 s / tolerance | raw | resident | +68.863 MiB / +102.410 MiB | 29.829× / 23.986× |
| point wall | raw | streaming | 2808.221 ms / 3.167 ms | 2221.696× / 96.639× |
| hour wall | raw | streaming | 1429.980 ms / 312.981 ms | 778.212× / 1063.554× |
| month wall | raw | streaming | 1674.457 ms / 564.343 ms | 48.197× / 28.971× |
| ten wall | raw | streaming | 2005.805 ms / 888.151 ms | 5.067× / 3.138× |
| append wall | raw | streaming | 846.510 ms / 735.106 ms | 77.293× / 93.689× |
| point peak RSS | raw | streaming | 22.836 MiB / 22.840 MiB | 3.622× / 3.623× |
| point retained RSS at 1 s / tolerance | raw | streaming | +15.582 MiB / +15.586 MiB | 15.582× / 15.586× |
| hour retained RSS at 1 s / tolerance | raw | streaming | +1.082 MiB / +5.133 MiB | 1.082× / 5.133× |
| month retained RSS at 1 s / tolerance | raw | streaming | +0.777 MiB / +8.156 MiB | 0.349× / 1.948× |
| ten retained RSS at 1 s / tolerance | raw | streaming | +1.418 MiB / +11.398 MiB | 0.614× / 2.670× |
| peak RSS growth: 16 to 256 shards | raw | streaming | 17.738→17.988 MiB / 18.348→18.652 MiB | 1.014× / 1.017× |
