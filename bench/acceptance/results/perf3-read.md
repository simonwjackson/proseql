# Round-3 focused read evidence on aka

Baseline and intermediate stages have one timing trial per cell. Final has three rotating timing trials and one independent meter trial per cell. All complete answers match SQLite across every stage. Wall is median; floor is minimum; peak is maximum timing-trial RSS. No target is lowered.

Final runtime: `41896b98f5fd93afe8f8b8ea7a78aef51022cd5b`. Baseline: `112817e`. Native x86-64-v2, 1 GiB/no-swap scopes, nice 10, timeout 180 s. Synthetic 656,640-row samples/raw shapes. SQLite NORMAL/WAL. Not Celeron qualification.

| Read | Baseline C/W ms | Final C/W ms | SQLite C/W ms | Floor C/W ms | Wall status C/W | Native peak C/W MiB | SQLite peak C/W MiB | Peak status C/W |
|---|---:|---:|---:|---:|---|---:|---:|---|
| samples/ten | 516.070 / 434.693 | 502.432 / 424.631 | 409.873 / 293.628 | 491.461 / 414.100 | miss / miss | 13.094 / 13.543 | 10.074 / 10.320 | pass / pass |
| samples/month | 103.724 / 46.398 | 104.254 / 47.010 | 33.305 / 19.588 | 95.156 / 46.036 | miss / miss | 8.969 / 8.695 | 10.184 / 10.238 | pass / pass |
| samples/hour | 53.891 / 0.254 | 56.943 / 0.257 | 1.434 / 0.289 | 53.437 / 0.255 | miss / pass | 8.594 / 8.043 | 6.539 / 6.555 | pass / pass |
| samples/point | 659.442 / 0.169 | 562.411 / 0.083 | 1.055 / 0.021 | 507.610 / 0.082 | miss / miss | 17.805 / 17.805 | 6.281 / 6.281 | miss / miss |
| raw/ten | 642.760 / 474.708 | 619.626 / 484.756 | 401.179 / 292.054 | 600.693 / 478.697 | miss / miss | 16.555 / 16.938 | 10.059 / 10.320 | pass / pass |
| raw/point | 792.076 / 2.909 | 712.321 / 0.727 | 1.091 / 0.042 | 704.147 / 0.710 | miss / miss | 18.359 / 18.340 | 6.281 / 6.281 | miss / miss |
| raw/hour | 605.870 / 9.868 | 607.227 / 10.408 | 1.651 / 0.297 | 578.063 / 10.244 | miss / miss | 16.469 / 11.496 | 6.543 / 6.551 | miss / pass |

## Per-stage operation instructions (billions C/W)

| Read | Baseline | Field positions | Shared observations | Listing metadata | Decoded IDs | Final |
|---|---:|---:|---:|---:|---:|---:|
| samples/ten | 8.829757 / 8.792311 | 8.527146 / 8.489610 | 8.527148 / 8.489559 | 8.527149 / 8.489592 | 8.527147 / 8.489643 | 8.526487 / 8.488941 |
| samples/month | 1.729664 / 0.864555 | 1.708430 / 0.846295 | 1.708430 / 0.846295 | 1.708430 / 0.846295 | 1.708430 / 0.846295 | 1.708280 / 0.846121 |
| samples/hour | 0.856301 / 0.003384 | 0.853124 / 0.003484 | 0.853125 / 0.003484 | 0.853124 / 0.003484 | 0.853124 / 0.003484 | 0.853052 / 0.003412 |
| samples/point | 11.805060 / 0.000505 | 11.852339 / 0.000505 | 11.877831 / 0.000446 | 12.125288 / 0.000354 | 9.113801 / 0.000354 | 9.111019 / 0.000369 |
| raw/ten | 9.826092 / 9.450406 | 9.499157 / 9.124963 | 9.499141 / 9.124981 | 9.499156 / 9.124987 | 9.499168 / 9.124988 | 9.497183 / 9.121734 |
| raw/point | 14.160501 / 0.009729 | 14.207790 / 0.009731 | 14.236975 / 0.008843 | 14.483283 / 0.006660 | 11.219450 / 0.006661 | 11.217561 / 0.007123 |
| raw/hour | 8.806306 / 0.117941 | 8.774817 / 0.117587 | 8.774817 / 0.117586 | 8.774834 / 0.117595 | 8.774833 / 0.117594 | 8.772833 / 0.115968 |

## Requested allocations, live/peak MiB (not RSS)

| Read | Baseline cold | Baseline warm | Final cold | Final warm |
|---|---:|---:|---:|---:|
| samples/ten | 0.474 / 6.053 | 0.474 / 6.053 | 0.474 / 6.062 | 0.474 / 6.062 |
| samples/month | 0.639 / 1.880 | 0.639 / 1.381 | 0.639 / 1.882 | 0.639 / 1.383 |
| samples/hour | 0.418 / 1.288 | 0.418 / 0.730 | 0.418 / 1.289 | 0.418 / 0.731 |
| samples/point | 10.092 / 10.288 | 10.092 / 10.098 | 10.092 / 10.292 | 10.092 / 10.101 |
| raw/ten | 3.542 / 9.152 | 3.542 / 9.152 | 3.542 / 9.161 | 3.542 / 9.162 |
| raw/point | 10.282 / 10.625 | 10.282 / 10.345 | 10.282 / 10.764 | 10.282 / 10.455 |
| raw/hour | 3.486 / 8.902 | 3.486 / 3.903 | 3.486 / 8.903 | 3.486 / 3.904 |

## Single-trial intermediate wall times, ms C/W

| Read | Fields | Observed | Listing | Decoded |
|---|---:|---:|---:|---:|
| samples/ten | 489.660 / 414.765 | 475.796 / 421.192 | 467.822 / 425.769 | 471.474 / 419.306 |
| samples/month | 105.646 / 46.150 | 103.958 / 46.492 | 106.408 / 46.628 | 106.586 / 46.713 |
| samples/hour | 52.577 / 0.260 | 52.522 / 0.262 | 53.166 / 0.262 | 53.744 / 0.264 |
| samples/point | 671.333 / 0.173 | 668.866 / 0.138 | 689.431 / 0.076 | 555.246 / 0.087 |
| raw/ten | 635.245 / 465.675 | 657.567 / 471.199 | 653.313 / 469.210 | 667.753 / 480.014 |
| raw/point | 827.686 / 2.964 | 824.887 / 2.109 | 840.369 / 0.676 | 699.044 / 0.674 |
| raw/hour | 563.822 / 10.333 | 604.175 / 10.385 | 616.471 / 10.299 | 630.837 / 10.580 |

Trials: {"baseline": 42, "decoded": 14, "fields": 28, "final": 98, "listing": 14, "observed": 14}; all 210 complete answers checked against the same SQLite answers. Final five-second load samples: first=0.85, last=0.54, maximum=0.87. The final block waited for load <=1 and no sample exceeded 2.
