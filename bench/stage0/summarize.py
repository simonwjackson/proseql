#!/usr/bin/env python3
"""Summarize one final matrix; never mix initial/discarded trials."""

import csv
import json
import statistics
import sys
from pathlib import Path

KINDS = ("samples", "raw")
WORKLOADS = ("point", "hour", "month", "ten", "append", "open", "idle")
READS = ("point", "hour", "month", "ten")
BACKENDS = ("sqlite", "proseql", "spike")
APPEND_BACKENDS = ("sqlite", "proseql", "proseql-global", "spike")
CACHES = ("cold", "warm")
MIB = 1024 * 1024
KILLED = (-9, 137)
WORKLOAD_LABELS = {"append": "append (supplement: 900 new + 100 duplicates)"}
DUPLICATE_SCOPE = {
    "sqlite": "global: primary-key B-tree lookup per row",
    "proseql": "native as shipped: `create_many` alone; checks loaded/routed partitions only",
    "proseql-global": "native + global preflight: one `query_bounded` `id $in` **scan** of every partition, then `create_many` (benchmark-only)",
    "spike": "global: full scan of every file, exact record compare",
}


def median(records, key):
    return statistics.median(r[key] for r in records) if records else None


def load(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def cell(records, kind, workload, backend, cache):
    matches = [
        r
        for r in records
        if (r["kind"], r["workload"], r["backend"], r["cache"])
        == (kind, workload, backend, cache)
    ]
    times = [r for r in matches if r["profile"] == "timing" and not r["returncode"]]
    heaps = [r for r in matches if r["profile"] == "meter" and not r["returncode"]]
    heap = heaps[0] if heaps else None
    rust = heap["rust_heap_live_peak"] if heap else None
    sqlite = heap["sqlite_c_heap_live_peak"] if heap else None
    return {
        "kind": kind,
        "workload": workload,
        "backend": backend,
        "cache": cache,
        "trials": len(matches),
        "timing_passes": len(times),
        "failures": sum(bool(r["returncode"]) for r in matches),
        "killed": sum(r["returncode"] in KILLED for r in matches),
        "wall_median_ms": median(times, "wall_ms"),
        "wall_min_ms": min((r["wall_ms"] for r in times), default=None),
        "wall_max_ms": max((r["wall_ms"] for r in times), default=None),
        "instructions_median": median(times, "instructions"),
        "rss_peak_max": max((r["rss_peak"] for r in times), default=None),
        "rss_return_median": median(times, "rss_return"),
        "rss_1s_median": median(times, "rss_1s"),
        "rust_heap_live": rust[0] if rust else None,
        "rust_heap_peak": rust[1] if rust else None,
        "sqlite_c_heap_live": sqlite[0] if sqlite else None,
        "sqlite_c_heap_peak": sqlite[1] if sqlite else None,
        "file_cache_before_median": median(times, "file_cache_before"),
        "file_cache_after_median": median(times, "file_cache_after"),
    }


def write_csv(path, rows):
    with path.open("w") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def pair(keyed, kind, workload, backend, key, scale=1, precision=2):
    values = [keyed[kind, workload, backend, cache][key] for cache in CACHES]
    return " / ".join(
        "killed" if value is None else f"{value / scale:.{precision}f}"
        for value in values
    )


def heap_pair(keyed, kind, workload, backend):
    heaps = []
    for cache in CACHES:
        row = keyed[kind, workload, backend, cache]
        heaps.append(
            "killed"
            if row["rust_heap_live"] is None
            else f"{row['rust_heap_live'] / MIB:.3f}/{row['rust_heap_peak'] / MIB:.3f}"
        )
    return "; ".join(heaps)


def summarize_append(root):
    """Headline append: 1,000 genuinely new rows, each checked for duplicates."""
    records = load(root / "trials.jsonl")
    if not records:
        return None, []
    skipped = load(root / "skipped.jsonl")
    rows = []
    for kind in KINDS:
        for backend in APPEND_BACKENDS:
            for cache in CACHES:
                row = cell(records, kind, "append", backend, cache)
                row["skipped"] = sum(
                    (s["kind"], s["backend"], s["cache"]) == (kind, backend, cache)
                    for s in skipped
                )
                if row["trials"] < 1 or row["trials"] + row["skipped"] != 4:
                    raise ValueError(
                        f"strict append cell incomplete: {kind} {backend} {cache}"
                    )
                if row["skipped"] and not row["killed"]:
                    raise ValueError(f"skip without a kill: {kind} {backend} {cache}")
                rows.append(row)
    for record in records:
        if record["workload"] != "append":
            raise ValueError("strict append run contains a non-append trial")
        if not record["returncode"] and not (
            record["append_verified"]
            and record["rows_persisted"] == 1000
            and record["append_new_rows"] == 1000
        ):
            raise ValueError("successful strict append did not persist 1,000 new rows")
    write_csv(root / "summary.csv", rows)
    keyed = {(r["kind"], r["workload"], r["backend"], r["cache"]): r for r in rows}
    lines = [
        "### Append, headline: 1,000 genuinely new rows (strict)",
        "",
        "Every requested ID is new and is checked for a duplicate. Cells are **cold / warm**. Runs are completed timing trials / SIGKILLed trials / skipped trials (a cell is not repeated after a kill). Units as in the memory table.",
        "",
        "| Shape | Implementation and duplicate-check scope | Wall ms C/W | Runs ok/killed/skipped C; W | RSS peak C/W | RSS steady C/W | Rust L/P cold; warm | C P C/W | File cache C/W | Instructions C/W |",
        "|---|---|---:|---|---:|---:|---|---:|---:|---:|",
    ]
    for kind in KINDS:
        for backend in APPEND_BACKENDS:
            runs = "; ".join(
                "{timing_passes}/{killed}/{skipped}".format(
                    **keyed[kind, "append", backend, cache]
                )
                for cache in CACHES
            )
            c_peak = (
                pair(keyed, kind, "append", backend, "sqlite_c_heap_peak", MIB, 3)
                if backend == "sqlite"
                else "—"
            )
            lines.append(
                f"| {kind} | {DUPLICATE_SCOPE[backend]} | {pair(keyed, kind, 'append', backend, 'wall_median_ms')} | {runs} | {pair(keyed, kind, 'append', backend, 'rss_peak_max', MIB)} | {pair(keyed, kind, 'append', backend, 'rss_1s_median', MIB)} | {heap_pair(keyed, kind, 'append', backend)} | {c_peak} | {pair(keyed, kind, 'append', backend, 'file_cache_after_median', MIB)} | {pair(keyed, kind, 'append', backend, 'instructions_median', 1e6, 3)} |"
            )
    lines += [
        "",
        "Source data: `bench/stage0/results/append-new/trials.jsonl`, `skipped.jsonl` and `summary.csv`. The preflight builds no membership structure, so it has no separate build time or resident structure bytes; its scan cost is inside the wall time.",
        "",
    ]
    return keyed, lines


def ratio_pair(values):
    return " / ".join("killed" if v is None else f"{v:.2f}×" for v in values)


def verdict(values, limit):
    if any(v is None for v in values):
        return "**miss** (killed)"
    return "pass" if all(v <= limit for v in values) else "**miss**"


def targets(keyed, strict):
    """#12 targets judged on yari as a proxy; ratios are cold / warm."""

    def get(kind, workload, backend, cache, key, source=None):
        return (source or keyed)[kind, workload, backend, cache][key]

    def wall_ratios(kind, workload, backend, source=None):
        out = []
        for cache in CACHES:
            mine = get(kind, workload, backend, cache, "wall_median_ms", source)
            base = get(kind, workload, "sqlite", cache, "wall_median_ms", source)
            out.append(None if mine is None else mine / base)
        return out

    def worst(values):
        return None if any(v is None for v in values) else max(values)

    lines = [
        "### #12 targets on yari (proxy)",
        "",
        "Ratios are implementation / SQLite, **cold / warm**, from the medians above. A cell passes only if cold and warm both pass. yari is a proxy: #12 sets the targets on rakku, which this stage does not measure.",
        "",
        "| Target (#12) | Limit | Shape | ProseQL `61c4322` | Spike |",
        "|---|---|---|---|---|",
    ]
    for kind in KINDS:
        cells = []
        for backend in ("proseql", "spike"):
            deltas = [
                max(
                    (get(kind, w, backend, c, "rss_1s_median") or 0)
                    - get(kind, w, "sqlite", c, "rss_1s_median")
                    for w in ("open", "idle")
                )
                / MIB
                for c in CACHES
            ]
            cells.append(
                f"{' / '.join(f'{d:+.2f}' for d in deltas)} MiB: {verdict(deltas, 20)}"
            )
        lines.append(
            f"| Memory, open and idle (steady RSS) | ≤ SQLite + 20 MiB | {kind} | {cells[0]} | {cells[1]} |"
        )
    for kind in KINDS:
        cells = []
        for backend in ("proseql", "spike"):
            per_cache = []
            for c in CACHES:
                ratios = []
                for w in READS:
                    mine = get(kind, w, backend, c, "rss_peak_max")
                    ratios.append(
                        None if mine is None else mine / get(kind, w, "sqlite", c, "rss_peak_max")
                    )
                per_cache.append(worst(ratios))
            cells.append(f"worst {ratio_pair(per_cache)}: {verdict(per_cache, 2)}")
        lines.append(
            f"| Peak RSS, any listed read (point/hour/month/ten) | ≤ 2 × SQLite peak | {kind} | {cells[0]} | {cells[1]} |"
        )
    for workload, label, limit in (
        ("ten", "Ten-month aggregate by day, 2 metrics", 1),
        ("month", "One-month aggregate by day", 1),
        ("hour", "1-hour range read", 1.5),
        ("point", "Point lookup by ID", 2),
    ):
        for kind in KINDS:
            cells = []
            for backend in ("proseql", "spike"):
                r = wall_ratios(kind, workload, backend)
                cells.append(f"{ratio_pair(r)}: {verdict(r, limit)}")
            lines.append(
                f"| {label} (wall) | ≤ {limit} × SQLite | {kind} | {cells[0]} | {cells[1]} |"
            )
    if strict:
        for kind in KINDS:
            shipped = wall_ratios(kind, "append", "proseql", strict)
            preflight = wall_ratios(kind, "append", "proseql-global", strict)
            spike = wall_ratios(kind, "append", "spike", strict)
            lines.append(
                f"| Append 1,000 new rows with duplicate checks (wall) | ≤ 1 × SQLite | {kind} | as shipped {ratio_pair(shipped)}: {verdict(shipped, 1)}; + global preflight {ratio_pair(preflight)}: {verdict(preflight, 1)} | {ratio_pair(spike)}: {verdict(spike, 1)} |"
            )
    for kind in KINDS:
        cells = []
        for backend in ("proseql", "spike"):
            ok = True
            worst_delta = 0.0
            killed = False
            for c in CACHES:
                idle_mine = get(kind, "idle", backend, c, "rss_1s_median")
                idle_sql = get(kind, "idle", "sqlite", c, "rss_1s_median")
                for w in READS:
                    after = get(kind, w, backend, c, "rss_1s_median")
                    if after is None:
                        killed = True
                        continue
                    delta = (after - idle_mine) / MIB
                    sql_delta = (
                        get(kind, w, "sqlite", c, "rss_1s_median") - idle_sql
                    ) / MIB
                    worst_delta = max(worst_delta, delta)
                    ok = ok and delta <= max(sql_delta, 1.0)
            cells.append(
                f"worst +{worst_delta:.2f} MiB above idle: "
                + ("**miss** (killed)" if killed else "pass" if ok else "**miss**")
            )
        lines.append(
            f"| Memory 1 s after a read returns | back to idle (judged: ≤ max(SQLite's own retained delta, 1 MiB)) | {kind} | {cells[0]} | {cells[1]} |"
        )
    lines += [
        "| Open, Logbook real shape on rakku | ≤ 1 s | — | **unmeasured** (rakku-only; no rakku access, no real data) | **unmeasured** |",
        "| Peak RSS not growing with partition count | — | samples (10 files) vs raw (256 files) | compare peak rows above; not a controlled partition-count sweep | same |",
        "",
    ]
    return lines


def summarize(root):
    records = load(root / "trials.jsonl")
    if len(records) != 336:
        raise ValueError(f"expected 336 trials, found {len(records)}")
    rows = []
    for kind in KINDS:
        for workload in WORKLOADS:
            for backend in BACKENDS:
                for cache in CACHES:
                    row = cell(records, kind, workload, backend, cache)
                    if row["trials"] != 4:
                        raise ValueError(
                            f"duplicate or missing combination: {kind} {workload} {backend} {cache}"
                        )
                    del row["trials"]
                    del row["killed"]
                    rows.append(row)
    write_csv(root / "summary.csv", rows)
    keyed = {(r["kind"], r["workload"], r["backend"], r["cache"]): r for r in rows}
    strict, strict_lines = summarize_append(root / "append-new")

    lines = [
        "## Results on yari",
        "",
        "All paired cells are **cold / warm**. Wall values are medians of 3 optimized trials. Memory peak is the maximum of those 3 trials; steady RSS is the median one-second sample. Heap is one separate meter trial. `killed` has no completed operation value; do not read it as zero. CSV retains ranges, return RSS, cache-before and separate C heap live/peak values. The append rows in these two tables are the **supplement** (900 new + 100 exact duplicates, rejection path); the strict append headline is a separate table.",
        "",
        "| Shape / workload | SQLite ms | ProseQL ms | Spike ms |",
        "|---|---:|---:|---:|",
    ]
    for kind in KINDS:
        for workload in WORKLOADS:
            values = " | ".join(
                pair(keyed, kind, workload, backend, "wall_median_ms")
                for backend in BACKENDS
            )
            lines.append(
                f"| {kind} / {WORKLOAD_LABELS.get(workload, workload)} | {values} |"
            )
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
                c_peak = (
                    pair(keyed, kind, workload, backend, "sqlite_c_heap_peak", MIB, 3)
                    if backend == "sqlite"
                    else "—"
                )
                lines.append(
                    f"| {kind} / {WORKLOAD_LABELS.get(workload, workload)} | {backend} | {pair(keyed, kind, workload, backend, 'rss_peak_max', MIB)} | {pair(keyed, kind, workload, backend, 'rss_1s_median', MIB)} | {heap_pair(keyed, kind, workload, backend)} | {c_peak} | {pair(keyed, kind, workload, backend, 'file_cache_after_median', MIB)} | {pair(keyed, kind, workload, backend, 'instructions_median', 1e6, 3)} |"
                )
    lines += [
        "",
        "Source data: `bench/stage0/results/trials.jsonl`; exact numeric summaries: `bench/stage0/results/summary.csv`. The idle wall is a one-second observation interval. Warm append is file-cache-warm, not a duplicate replay. No complete heap/RSS reading is available for killed operations.",
        "",
    ]
    lines += strict_lines
    dense_path = root / "dense" / "trials.jsonl"
    if dense_path.exists():
        dense = load(dense_path)
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
            for cache in CACHES:
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
                f"| {workload} | {pair(keyed, 'raw', workload, 'sqlite', 'wall_median_ms')} | {pair(keyed, 'raw', workload, 'spike', 'wall_median_ms')} | {' / '.join(wall)} | {' / '.join(rss)} | {' / '.join(heap)} |"
            )
        lines.append("")
    lines += targets(keyed, strict)
    (root / "tables.md").write_text("\n".join(lines))

    def oom_diagnostic(path):
        if not path.exists():
            return None
        diagnostic = json.loads(path.read_text())
        if not (
            diagnostic["returncode"] == -9
            and diagnostic["memory_events_after"]["oom_kill"]
            > diagnostic["memory_events_before"]["oom_kill"]
        ):
            raise ValueError(f"native abort diagnostic did not confirm an OOM kill: {path}")
        return {
            k: diagnostic[k]
            for k in (
                "returncode",
                "rss_sampled_peak_lower_bound",
                "cgroup_peak_bytes",
                "cgroup_anon_sampled_peak",
                "cgroup_file_sampled_peak",
                "memory_events_before",
                "memory_events_after",
                "wall_s",
            )
        }

    def temp_paths(path):
        if not path.exists():
            return None
        temp_check = json.loads(path.read_text())
        if (
            temp_check["returncode"] != 0
            or not temp_check["temporary_file_paths"]
            or any(
                not p.startswith("/home/simon/work/proseql-stage0-data/tmp/")
                for p in temp_check["temporary_file_paths"]
            )
        ):
            raise ValueError(
                "SQLite temporary-file location was not observed under the owned data directory"
            )
        return temp_check["temporary_file_paths"]

    strict_records = load(root / "append-new" / "trials.jsonl")
    print(
        json.dumps(
            {
                "native_raw_append_diagnostic": oom_diagnostic(
                    root / "raw-append-diagnostic.json"
                ),
                "native_raw_append_diagnostic_strict": oom_diagnostic(
                    root / "append-new" / "raw-append-diagnostic.json"
                ),
                "sqlite_temporary_file_paths": temp_paths(
                    root / "sqlite-temp-diagnostic.json"
                ),
                "sqlite_temporary_file_paths_strict_build": temp_paths(
                    root / "append-new" / "sqlite-temp-diagnostic.json"
                ),
                "trials": len(records),
                "successful": sum(not r["returncode"] for r in records),
                "failed": sum(bool(r["returncode"]) for r in records),
                "cold_trials_with_resident_pages_before_launch": sum(
                    r["cache"] == "cold" and r["file_cache_before"] != 0
                    for r in records
                ),
                "strict_append_trials": len(strict_records),
                "strict_append_successful": sum(
                    not r["returncode"] for r in strict_records
                ),
                "strict_append_killed": sum(
                    r["returncode"] in KILLED for r in strict_records
                ),
                "strict_append_skipped": len(
                    load(root / "append-new" / "skipped.jsonl")
                ),
                "strict_append_cold_with_resident_pages_before_launch": sum(
                    r["cache"] == "cold" and r["file_cache_before"] != 0
                    for r in strict_records
                ),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    summarize(Path(sys.argv[1]))
