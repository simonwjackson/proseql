# Focused round-2 read results on aka

Three timing trials and one independent meter trial for baseline/final. Intermediate stages are single timing trials, not target qualification. All answers matched complete SQLite answers. Wall: median; floor: minimum; peak: maximum timing-trial RSS. Units: ms and MiB. x86-64-v2, 1 GiB/no-swap scopes, nice 10, timeout 180 s. No consumer trim.

Final engine source: `fae3b93b9be2b3991157ed2557a34bf1c6069bb9`, including perf-write `efb0f95`. Baseline: `aed5154`. Full source-file checksums are recorded beside the raw final trials during the run. The committed JSONL retains compact per-stage metrics; it omits repeated answer payloads.

| Shape/read | Baseline C/W ms | Final C/W ms | SQLite final C/W ms | Final floor C/W ms | Peak final C/W MiB | SQLite peak C/W MiB | Wall limit; C/W status | Peak ≤2× C/W |
|---|---:|---:|---:|---:|---:|---:|---|---|
| samples/ten | 1821.087 / 858.326 | 536.944 / 439.050 | 404.387 / 286.100 | 536.932 / 435.770 | 13.211 / 17.629 | 9.992 / 10.191 | ≤1×; miss / miss | pass / pass |
| samples/month | 283.183 / 86.233 | 109.416 / 47.848 | 32.817 / 19.326 | 107.278 / 47.107 | 8.961 / 8.902 | 9.992 / 10.109 | ≤1×; miss / miss | pass / pass |
| samples/hour | 96.731 / 1.371 | 55.268 / 0.349 | 1.664 / 0.279 | 54.037 / 0.258 | 8.586 / 8.160 | 6.410 / 6.426 | ≤1.5×; miss / pass | pass / pass |
| samples/point | 2561.475 / 0.247 | 654.274 / 0.244 | 1.085 / 0.042 | 650.312 / 0.157 | 17.984 / 17.984 | 6.152 / 6.152 | ≤2×; miss / miss | miss / miss |
| raw/ten | 2054.092 / 928.501 | 680.832 / 483.006 | 411.669 / 286.212 | 659.555 / 478.922 | 16.836 / 17.176 | 9.992 / 10.191 | ≤1×; miss / miss | pass / pass |
| raw/hour | 1434.847 / 514.911 | 605.976 / 10.832 | 1.870 / 0.297 | 603.241 / 10.585 | 16.461 / 11.766 | 6.414 / 6.422 | ≤1.5×; miss / miss | miss / pass |

## Requested allocations (live / peak MiB, independent meter)

| Read | Baseline cold | Final cold | Baseline warm | Final warm |
|---|---:|---:|---:|---:|
| samples/ten | 0.186 / 10.594 | 0.474 / 6.053 | 0.186 / 10.594 | 0.474 / 6.053 |
| samples/month | 0.049 / 1.311 | 0.639 / 1.881 | 0.049 / 1.311 | 0.639 / 1.381 |
| samples/hour | 0.039 / 0.443 | 0.418 / 1.288 | 0.039 / 0.443 | 0.418 / 0.730 |
| samples/point | 15.123 / 15.313 | 10.092 / 10.287 | 15.123 / 15.129 | 10.092 / 10.098 |
| raw/ten | 0.414 / 10.843 | 3.533 / 9.141 | 0.414 / 10.843 | 3.533 / 9.141 |
| raw/hour | 0.358 / 4.793 | 3.477 / 8.891 | 0.358 / 4.793 | 3.477 / 3.892 |

## Instructions in the timed public operation (billions, cold / warm)

| Read | Baseline | Field-only | Fused scan | Compact identities | Prepared/fused IDs | Dense checkpoints | Final |
|---|---:|---:|---:|---:|---:|---:|---:|
| samples/ten | 30.1844 / 15.9603 | 21.9069 / 15.9692 | 16.0845 / 15.9604 | 15.5892 / 15.4824 | 12.2441 / 12.1389 | 12.2443 / 12.1381 | 8.8244 / 8.7871 |
| samples/month | 4.4481 / 1.5888 | 2.7681 / 1.5760 | 3.1428 / 1.5919 | 3.0484 / 1.5420 | 2.3829 / 1.1888 | 2.3844 / 1.1736 | 1.7287 / 0.8640 |
| samples/hour | 1.4601 / 0.0240 | 0.6286 / 0.0240 | 1.5229 / 0.0240 | 1.4765 / 0.0234 | 1.1414 / 0.0181 | 1.1421 / 0.0038 | 0.8558 / 0.0035 |
| samples/point | 37.3881 / 0.0005 | 37.4111 / 0.0005 | 37.4071 / 0.0005 | 37.4072 / 0.0005 | 14.9221 / 0.0005 | 14.9247 / 0.0005 | 11.6398 / 0.0005 |
| raw/ten | 32.5509 / 16.7515 | 23.2277 / 16.8857 | 17.9439 / 16.7533 | 17.4558 / 16.5874 | 13.7365 / 12.6673 | 13.7456 / 12.6693 | 9.8219 / 9.4463 |
| raw/hour | 21.6174 / 5.9278 | 12.3147 / 5.9453 | 15.9940 / 5.9280 | 15.4898 / 5.7159 | 11.7542 / 4.2849 | 11.7628 / 0.1465 | 8.8022 / 0.1178 |
