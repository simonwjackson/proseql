#!/usr/bin/env python3
"""Summarize the focused aka read trials without retaining repeated group payloads."""

import json
import os
import statistics
from collections import defaultdict
from pathlib import Path

if os.uname().nodename.split(".")[0] != "aka":
    raise RuntimeError("summaries are produced on aka")
root = Path("bench/acceptance/results")
stages = ["baseline", "field", "fused", "identity", "prepared", "dense", "final"]
sources = [
    "aed5154",
    "5c76260",
    "c13db73",
    "1ee642d",
    "4e60c43",
    "0342724",
    (root / "perf-read-final/source.sha").read_text().strip(),
]
previous = (
    [json.loads(line) for line in (root / "perf-read.jsonl").read_text().splitlines()]
    if (root / "perf-read.jsonl").exists()
    else []
)
summary = []
for stage, source in zip(stages, sources):
    cells = defaultdict(list)
    raw = root / f"perf-read-{stage}" / "trials.jsonl"
    if not raw.exists():
        summary.extend(row for row in previous if row["stage"] == stage)
        continue
    for line in raw.read_text().splitlines():
        row = json.loads(line)
        if stage == "field" and row["profile"] == "meter":
            continue  # That intermediate timing-only spike reused the baseline meter.
        cells[
            (row["profile"], row["kind"], row["workload"], row["backend"], row["cache"])
        ].append(row)
    for (profile, kind, workload, backend, cache), rows in cells.items():
        summary.append(
            dict(
                stage=stage,
                source=source,
                profile=profile,
                kind=kind,
                workload=workload,
                backend=backend,
                cache=cache,
                trials=len(rows),
                wall_ms=statistics.median(row["wall_ms"] for row in rows),
                floor_ms=min(row["wall_ms"] for row in rows),
                instructions=statistics.median(row["instructions"] for row in rows),
                rss_peak=max(row["rss_peak"] for row in rows),
                rss_peak_floor=min(row["rss_peak"] for row in rows),
                rss_1s=statistics.median(row["rss_1s"] for row in rows),
                rust_heap_live_peak=rows[0]["rust_heap_live_peak"]
                if profile == "meter"
                else None,
            )
        )
(root / "perf-read.jsonl").write_text(
    "".join(json.dumps(row, sort_keys=True) + "\n" for row in summary)
)


def cell(stage, kind, workload, backend, cache, profile="timing"):
    return next(
        row
        for row in summary
        if (
            row["stage"],
            row["kind"],
            row["workload"],
            row["backend"],
            row["cache"],
            row["profile"],
        )
        == (stage, kind, workload, backend, cache, profile)
    )


lines = [
    "# Focused round-2 read results on aka",
    "",
    "Three timing trials and one independent meter trial for baseline/final. Intermediate stages are single timing trials, not target qualification. All answers matched complete SQLite answers. Wall: median; floor: minimum; peak: maximum timing-trial RSS. Units: ms and MiB. x86-64-v2, 1 GiB/no-swap scopes, nice 10, timeout 180 s. No consumer trim.",
    "",
    f"Final engine source: `{sources[-1]}`, including perf-write `efb0f95`. Baseline: `aed5154`. Full source-file checksums are recorded beside the raw final trials during the run. The committed JSONL retains compact per-stage metrics; it omits repeated answer payloads.",
    "",
    "| Shape/read | Baseline C/W ms | Final C/W ms | SQLite final C/W ms | Final floor C/W ms | Peak final C/W MiB | SQLite peak C/W MiB | Wall limit; C/W status | Peak ≤2× C/W |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
]
for kind, workload in [
    ("samples", "ten"),
    ("samples", "month"),
    ("samples", "hour"),
    ("samples", "point"),
    ("raw", "ten"),
    ("raw", "hour"),
]:
    pairs = [
        [cell(stage, kind, workload, backend, cache) for cache in ["cold", "warm"]]
        for stage, backend in [
            ("baseline", "streaming"),
            ("final", "streaming"),
            ("final", "sqlite"),
        ]
    ]
    old, new, sql = pairs
    factor = 2 if workload == "point" else 1.5 if workload == "hour" else 1
    status = [
        "pass" if n["wall_ms"] <= s["wall_ms"] * factor else "miss"
        for n, s in zip(new, sql)
    ]

    def pair(rows, key, scale=1):
        return " / ".join(f"{row[key] / scale:.3f}" for row in rows)

    peak_status = [
        "pass" if n["rss_peak"] <= s["rss_peak"] * 2 else "miss"
        for n, s in zip(new, sql)
    ]
    lines.append(
        f"| {kind}/{workload} | {pair(old, 'wall_ms')} | {pair(new, 'wall_ms')} | {pair(sql, 'wall_ms')} | {pair(new, 'floor_ms')} | {pair(new, 'rss_peak', 1048576)} | {pair(sql, 'rss_peak', 1048576)} | ≤{factor}×; {' / '.join(status)} | {' / '.join(peak_status)} |"
    )
lines += [
    "",
    "## Requested allocations (live / peak MiB, independent meter)",
    "",
    "| Read | Baseline cold | Final cold | Baseline warm | Final warm |",
    "|---|---:|---:|---:|---:|",
]
for kind, workload in [
    ("samples", "ten"),
    ("samples", "month"),
    ("samples", "hour"),
    ("samples", "point"),
    ("raw", "ten"),
    ("raw", "hour"),
]:
    values = []
    for cache in ["cold", "warm"]:
        for stage in ["baseline", "final"]:
            row = cell(stage, kind, workload, "streaming", cache, "meter")
            values.append(
                " / ".join(
                    f"{value / 1048576:.3f}" for value in row["rust_heap_live_peak"]
                )
            )
    lines.append(f"| {kind}/{workload} | {' | '.join(values)} |")
lines += [
    "",
    "## Instructions in the timed public operation (billions, cold / warm)",
    "",
    "| Read | Baseline | Field-only | Fused scan | Compact identities | Prepared/fused IDs | Dense checkpoints | Final |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
]
for kind, workload in [
    ("samples", "ten"),
    ("samples", "month"),
    ("samples", "hour"),
    ("samples", "point"),
    ("raw", "ten"),
    ("raw", "hour"),
]:
    values = []
    for stage in stages:
        values.append(
            " / ".join(
                f"{cell(stage, kind, workload, 'streaming', cache)['instructions'] / 1e9:.4f}"
                for cache in ["cold", "warm"]
            )
        )
    lines.append(f"| {kind}/{workload} | {' | '.join(values)} |")
(root / "perf-read.md").write_text("\n".join(lines) + "\n")
for stage, name in [("baseline", "ten"), ("baseline", "point"), ("dense", "ten")]:
    path = root / f"perf-read-{stage}" / f"profile-{name}.txt"
    if path.exists():
        (root / f"perf-read-profile-{stage}-{name}.txt").write_text(
            "\n".join(path.read_text().splitlines()[:60]) + "\n"
        )
stat_text = []
for stage in ["baseline", "final"]:
    if stage == "baseline" and not (root / "perf-read-baseline").exists():
        stat_text.append(
            (root / "perf-read-perf-stat.txt").read_text().split("## final/", 1)[0]
        )
    for path in sorted((root / f"perf-read-{stage}").glob("*.perf")):
        stat_text.append(f"## {stage}/{path.name}\n{path.read_text()}\n")
(root / "perf-read-perf-stat.txt").write_text("\n".join(stat_text))
print((root / "perf-read.md").read_text())
