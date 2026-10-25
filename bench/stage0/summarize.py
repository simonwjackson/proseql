#!/usr/bin/env python3
"""Summarize one final matrix; never mix initial/discarded trials."""

import csv
import json
from pathlib import Path
import statistics
import sys

KINDS = ("samples", "raw")
WORKLOADS = ("point", "hour", "month", "ten", "append", "open", "idle")
BACKENDS = ("sqlite", "proseql", "spike")
MIB = 1024 * 1024


def median(records, key):
    return statistics.median(r[key] for r in records) if records else None


def summarize(root):
    records = [
        json.loads(line) for line in (root / "trials.jsonl").read_text().splitlines()
    ]
    if len(records) != 336:
        raise ValueError(f"expected 336 trials, found {len(records)}")
    rows = []
    for kind in KINDS:
        for workload in WORKLOADS:
            for backend in BACKENDS:
                for cache in ("cold", "warm"):
                    matches = [
                        r
                        for r in records
                        if (r["kind"], r["workload"], r["backend"], r["cache"])
                        == (kind, workload, backend, cache)
                    ]
                    times = [
                        r
                        for r in matches
                        if r["profile"] == "timing" and not r["returncode"]
                    ]
                    heaps = [
                        r
                        for r in matches
                        if r["profile"] == "meter" and not r["returncode"]
                    ]
                    if len(matches) != 4:
                        raise ValueError(
                            f"duplicate or missing combination: {kind} {workload} {backend} {cache}"
                        )
                    heap = heaps[0] if heaps else None
                    rust = heap["rust_heap_live_peak"] if heap else None
                    sqlite = heap["sqlite_c_heap_live_peak"] if heap else None
                    rows.append(
                        dict(
                            kind=kind,
                            workload=workload,
                            backend=backend,
                            cache=cache,
                            timing_passes=len(times),
                            failures=sum(bool(r["returncode"]) for r in matches),
                            wall_median_ms=median(times, "wall_ms"),
                            wall_min_ms=min(
                                (r["wall_ms"] for r in times), default=None
                            ),
                            wall_max_ms=max(
                                (r["wall_ms"] for r in times), default=None
                            ),
                            instructions_median=median(times, "instructions"),
                            rss_peak_max=max(
                                (r["rss_peak"] for r in times), default=None
                            ),
                            rss_return_median=median(times, "rss_return"),
                            rss_1s_median=median(times, "rss_1s"),
                            rust_heap_live=rust[0] if rust else None,
                            rust_heap_peak=rust[1] if rust else None,
                            sqlite_c_heap_live=sqlite[0] if sqlite else None,
                            sqlite_c_heap_peak=sqlite[1] if sqlite else None,
                            file_cache_before_median=median(times, "file_cache_before"),
                            file_cache_after_median=median(times, "file_cache_after"),
                        )
                    )
    with (root / "summary.csv").open("w") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    keyed = {(r["kind"], r["workload"], r["backend"], r["cache"]): r for r in rows}

    def pair(kind, workload, backend, key, scale=1, precision=2):
        values = [
            keyed[kind, workload, backend, cache][key] for cache in ("cold", "warm")
        ]
        return " / ".join(
            "killed" if value is None else f"{value / scale:.{precision}f}"
            for value in values
        )

    lines = [
        "## Results on yari",
        "",
        "All paired cells are **cold / warm**. Wall values are medians of 3 optimized trials. Memory peak is the maximum of those 3 trials; steady RSS is the median one-second sample. Heap is one separate meter trial. `killed` has no completed operation value; do not read it as zero. CSV retains ranges, return RSS, cache-before and separate C heap live/peak values.",
        "",
        "| Shape / workload | SQLite ms | ProseQL ms | Spike ms |",
        "|---|---:|---:|---:|",
    ]
    for kind in KINDS:
        for workload in WORKLOADS:
            values = " | ".join(
                pair(kind, workload, backend, "wall_median_ms") for backend in BACKENDS
            )
            lines.append(f"| {kind} / {workload} | {values} |")
    lines += [
        "",
        "### Memory, cache and user instructions",
        "",
        "RSS and heap/cache units are MiB. `Rust L/P` is live/peak requested heap; `C P` is SQLite's separate C heap peak (not included in Rust). Owned-file cache is after process exit; before/after bytes are in the CSV. Instructions are millions, operation-only.",
        "",
        "| Shape / workload | Backend | RSS peak C/W | RSS steady C/W | Rust L/P cold; warm | C P C/W | File cache C/W | Instructions C/W |",
        "|---|---|---:|---:|---|---:|---:|---:|",
    ]
    for kind in KINDS:
        for workload in WORKLOADS:
            for backend in BACKENDS:
                heaps = []
                for cache in ("cold", "warm"):
                    row = keyed[kind, workload, backend, cache]
                    heaps.append(
                        "killed"
                        if row["rust_heap_live"] is None
                        else f"{row['rust_heap_live'] / MIB:.3f}/{row['rust_heap_peak'] / MIB:.3f}"
                    )
                c_peak = (
                    pair(kind, workload, backend, "sqlite_c_heap_peak", MIB, 3)
                    if backend == "sqlite"
                    else "—"
                )
                lines.append(
                    f"| {kind} / {workload} | {backend} | {pair(kind, workload, backend, 'rss_peak_max', MIB)} | {pair(kind, workload, backend, 'rss_1s_median', MIB)} | {'; '.join(heaps)} | {c_peak} | {pair(kind, workload, backend, 'file_cache_after_median', MIB)} | {pair(kind, workload, backend, 'instructions_median', 1e6, 3)} |"
                )
    lines += [
        "",
        "Source data: `bench/stage0/results/trials.jsonl`; exact numeric summaries: `bench/stage0/results/summary.csv`. The idle wall is a one-second observation interval. Warm append is file-cache-warm, not a duplicate replay. No complete heap/RSS reading is available for killed operations.",
        "",
    ]
    dense_path = root / "dense" / "trials.jsonl"
    if dense_path.exists():
        dense = [json.loads(line) for line in dense_path.read_text().splitlines()]
        if len(dense) != 32 or any(r["returncode"] for r in dense):
            raise ValueError("dense supplement must contain 32 successful trials")
        info = json.loads((root / "dense" / "index.json").read_text())
        lines += [
            "### Sparse-index density supplement (same binary, same source records)",
            "",
            f"Raw sparse sidecars grow from {info['original_index_bytes']:,} B (stride 256) to {info['index_bytes']:,} B (stride 16). All 32 supplementary trials match the main matrix's canonical answers. This changes only the disposable time index, not production code or a column cache.",
            "",
            "| Raw workload | SQLite ms C/W | Spike stride 256 ms C/W | Spike stride 16 ms C/W | Stride 16 peak RSS MiB C/W | Stride 16 Rust peak MiB C/W |",
            "|---|---:|---:|---:|---:|---:|",
        ]
        for workload in ("hour", "month", "ten", "open"):
            wall, rss, heap = [], [], []
            for cache in ("cold", "warm"):
                timing = [
                    r
                    for r in dense
                    if r["workload"] == workload
                    and r["cache"] == cache
                    and r["profile"] == "timing"
                ]
                metered = next(
                    r
                    for r in dense
                    if r["workload"] == workload
                    and r["cache"] == cache
                    and r["profile"] == "meter"
                )
                wall.append(f"{median(timing, 'wall_ms'):.2f}")
                rss.append(f"{max(r['rss_peak'] for r in timing) / MIB:.2f}")
                heap.append(f"{metered['rust_heap_live_peak'][1] / MIB:.3f}")
            lines.append(
                f"| {workload} | {pair('raw', workload, 'sqlite', 'wall_median_ms')} | {pair('raw', workload, 'spike', 'wall_median_ms')} | {' / '.join(wall)} | {' / '.join(rss)} | {' / '.join(heap)} |"
            )
        lines.append("")
    (root / "tables.md").write_text("\n".join(lines))
    print(
        json.dumps(
            {
                "trials": len(records),
                "successful": sum(not r["returncode"] for r in records),
                "failed": sum(bool(r["returncode"]) for r in records),
                "cold_trials_with_resident_pages_before_launch": sum(
                    r["cache"] == "cold" and r["file_cache_before"] != 0
                    for r in records
                ),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    summarize(Path(sys.argv[1]))
