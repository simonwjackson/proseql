#!/usr/bin/env python3
"""Strict acceptance summaries. Failed/missing cells never become zero/pass."""

import json
import statistics
import sys
from pathlib import Path

from measure import BACKENDS, CACHES, READS, WORKLOADS

MIB = 1024 * 1024


def aggregate(records):
    good = [r for r in records if not r["returncode"] and r["profile"] == "timing"]
    meters = [r for r in records if not r["returncode"] and r["profile"] == "meter"]
    failed = any(r["returncode"] for r in records)
    result = {
        "successful_timing": len(good),
        "failures": sum(bool(r["returncode"]) for r in records),
    }
    for key in (
        "wall_ms",
        "rss_1s",
        "instructions",
        "file_cache_before",
        "file_cache_after",
    ):
        values = [r[key] for r in good if r.get(key) is not None]
        result[key] = statistics.median(values) if values and not failed else None
    result["rss_peak"] = (
        max((r["rss_peak"] for r in good), default=None) if not failed else None
    )
    for key in ("rust_heap_live_peak", "sqlite_c_heap_live_peak"):
        result[key] = meters[0].get(key) if meters else None
    return result


def divide(value, base):
    return value / base if value is not None and base is not None and base > 0 else None


def verdict(values, limit, eligible=True):
    return (
        "pass"
        if eligible and values and all(v is not None and v <= limit for v in values)
        else "miss"
    )


def summarize(root):
    records = [
        json.loads(line) for line in (root / "trials.jsonl").read_text().splitlines()
    ]
    run = json.loads((root / "run.json").read_text())
    if len(records) + run["skipped_after_kill"] != run["expected_trials"]:
        raise ValueError("incomplete matrix")
    probes = json.loads((root / "duplicates.json").read_text())
    keyed = {}
    metrics = []
    for shape in ("samples", "raw", "raw16"):
        for workload in ("ten",) if shape == "raw16" else WORKLOADS:
            for backend in BACKENDS:
                for cache in CACHES:
                    matches = [
                        r
                        for r in records
                        if (r["shape"], r["workload"], r["backend"], r["cache"])
                        == (shape, workload, backend, cache)
                    ]
                    if not matches:
                        raise ValueError(
                            f"missing cell: {shape}/{workload}/{backend}/{cache}"
                        )
                    identities = [(r["profile"], r["repeat"]) for r in matches]
                    if len(set(identities)) != len(identities):
                        raise ValueError("duplicate trial")
                    row = {
                        "type": "metric",
                        "shape": shape,
                        "workload": workload,
                        "backend": backend,
                        "cache": cache,
                        **aggregate(matches),
                    }
                    keyed[shape, workload, backend, cache] = row
                    metrics.append(row)

    def get(shape, workload, backend, cache, field):
        return keyed[shape, workload, backend, cache][field]

    targets = []

    def target(
        name, shape, backend, values, limit, unit="ratio", eligible=True, note=""
    ):
        targets.append(
            {
                "type": "target",
                "target": name,
                "shape": shape,
                "backend": backend,
                "role": "reference baseline"
                if backend == "resident"
                else "acceptance"
                if backend == "streaming"
                else "SQLite baseline",
                "cold_warm": values,
                "limit": limit,
                "unit": unit,
                "status": verdict(values, limit, eligible),
                "note": note,
            }
        )

    for shape in ("samples", "raw"):
        for backend in ("resident", "streaming"):
            for workload, limit in (
                ("point", 2),
                ("hour", 1.5),
                ("month", 1),
                ("ten", 1),
                ("append", 1),
            ):
                ratios = [
                    divide(
                        get(shape, workload, backend, c, "wall_ms"),
                        get(shape, workload, "sqlite", c, "wall_ms"),
                    )
                    for c in CACHES
                ]
                eligible = workload != "append" or probes[f"{backend}/{shape}"]
                target(
                    f"{workload} wall",
                    shape,
                    backend,
                    ratios,
                    limit,
                    eligible=eligible,
                    note=(
                        "public create_many; global-conflict probe "
                        + ("pass" if eligible else "miss")
                        + "; NORMAL is the requested bar, not equal power-loss durability"
                    )
                    if workload == "append"
                    else (
                        "aka proxy; rakku absolute time unmeasured"
                        if workload == "ten"
                        else ""
                    ),
                )
            for workload in ("open", "idle"):
                ratios = []
                for c in CACHES:
                    mine = get(shape, workload, backend, c, "rss_1s")
                    base = get(shape, workload, "sqlite", c, "rss_1s")
                    ratios.append(
                        divide(mine, base + 20 * MIB if base is not None else None)
                    )
                target(f"{workload} RSS / (SQLite + 20 MiB)", shape, backend, ratios, 1)
            for workload in READS:
                target(
                    f"{workload} peak RSS",
                    shape,
                    backend,
                    [
                        divide(
                            get(shape, workload, backend, c, "rss_peak"),
                            get(shape, workload, "sqlite", c, "rss_peak"),
                        )
                        for c in CACHES
                    ],
                    2,
                )
                ratios = []
                for c in CACHES:
                    mine = get(shape, workload, backend, c, "rss_1s")
                    idle = get(shape, "idle", backend, c, "rss_1s")
                    base = get(shape, workload, "sqlite", c, "rss_1s")
                    base_idle = get(shape, "idle", "sqlite", c, "rss_1s")
                    ratios.append(
                        None
                        if any(v is None for v in (mine, idle, base, base_idle))
                        else max(0, mine - idle) / max(base - base_idle, MIB)
                    )
                target(
                    f"{workload} retained RSS at 1 s / tolerance",
                    shape,
                    backend,
                    ratios,
                    1,
                    note="tolerance=max(SQLite retained delta, 1 MiB); backend remains open; no malloc_trim",
                )
    for backend in BACKENDS:
        target(
            "peak RSS growth: 16 to 256 shards",
            "raw",
            backend,
            [
                divide(
                    get("raw", "ten", backend, c, "rss_peak"),
                    get("raw16", "ten", backend, c, "rss_peak"),
                )
                for c in CACHES
            ],
            1,
            note="same row count; strict observed no-growth proxy, no invented tolerance; RSS includes metadata and allocator noise",
        )
    for name in (
        "open real Logbook shape on rakku <= 1 s",
        "absolute Celeron wall times",
        "append equal power-loss durability",
    ):
        targets.append(
            {
                "type": "target",
                "target": name,
                "shape": "all",
                "backend": "all",
                "status": "unmeasured",
                "cold_warm": [],
                "limit": None,
                "unit": "",
                "note": "aka synthetic data only; native synced appends vs SQLite NORMAL are not equal durability"
                if name.startswith("append")
                else "rakku-only; no target access or real health data",
            }
        )
    lines = [
        "# Query-while-scanning acceptance on aka",
        "",
        "Resident is the reference baseline; #12 targets judge Streaming against SQLite. Synthetic x86-64-v2 proxy, not rakku/Celeron qualification. Cold / warm. A failed trial makes its cell a miss; killed trials are not zero. Timing medians; RSS peak maximum; heap is a separate instrumented trial.",
        "",
        f"Timing repeats: {run['repeats']}. Trials: {len(records)}; failures: {sum(bool(r['returncode']) for r in records)}; skipped after kill: {run['skipped_after_kill']}.",
        "",
        "| Shape / workload | Backend | Wall ms C/W | Peak RSS MiB C/W | RSS at 1 s MiB C/W | Rust live/peak MiB cold; warm |",
        "|---|---|---:|---:|---:|---|",
    ]

    def pair(shape, workload, backend, field, scale=1):
        return " / ".join(
            "failed"
            if (v := get(shape, workload, backend, c, field)) is None
            else f"{v / scale:.3f}"
            for c in CACHES
        )

    for shape in ("samples", "raw", "raw16"):
        for workload in ("ten",) if shape == "raw16" else WORKLOADS:
            for backend in BACKENDS:
                heaps = [
                    get(shape, workload, backend, c, "rust_heap_live_peak")
                    for c in CACHES
                ]
                heap = "; ".join(
                    "failed" if h is None else "/".join(f"{v / MIB:.3f}" for v in h)
                    for h in heaps
                )
                lines.append(
                    f"| {shape}/{workload} | {backend} | {pair(shape, workload, backend, 'wall_ms')} | {pair(shape, workload, backend, 'rss_peak', MIB)} | {pair(shape, workload, backend, 'rss_1s', MIB)} | {heap} |"
                )
    lines += [
        "",
        "## Every #12 target",
        "",
        "Ratios use the stated denominator; ≤ the limit passes in both cache modes. Append cannot pass without global duplicate checks. Same-durability qualification is unmeasured, not implied by timing. Partition growth is a controlled raw 16/256-shard aggregate, not the confounded samples/raw comparison.",
        "",
        "| Target | Shape | Backend | Ratio cold / warm | Limit | Status | Note |",
        "|---|---|---|---:|---:|---|---|",
    ]
    for row in targets:
        ratio = " / ".join(
            "failed" if v is None else f"{v:.3f}×" for v in row["cold_warm"]
        )
        lines.append(
            f"| {row['target']} | {row['shape']} | {row['backend']} | {ratio} | {row['limit']} | **{row['status']}** | {row['note']} |"
        )
    (root / "tables.md").write_text("\n".join(lines) + "\n")
    with (root / "summary.jsonl").open("w") as stream:
        for row in [*metrics, *targets]:
            stream.write(json.dumps(row, sort_keys=True) + "\n")
    print("\n".join(lines[-len(targets) - 2 :]))


if __name__ == "__main__":
    summarize(Path(sys.argv[1]))
