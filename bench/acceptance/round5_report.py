#!/usr/bin/env python3
"""Render round-5 evidence on aka, without re-running measurements."""

import hashlib
import json
import os
from pathlib import Path

OUT = Path("/home/simonwjackson/work/qws-bench5-results")
DEST = Path("bench/acceptance/results")
MIB = 1024 * 1024
CACHES = ("cold", "warm")
MODES = ("missing", "present")


def main():
    assert os.uname().nodename.split(".")[0] == "aka"
    summary = json.loads((OUT / "summary.json").read_text())
    duplicates = json.loads((OUT / "duplicates.json").read_text())
    assert len(duplicates) == 6 and all(duplicates.values())
    keyed = {(r["shape"], r["workload"], r["mode"], r["cache"]): r for r in summary}
    prior = {}
    for filename in (
        "query-while-scanning-persist-round4.json",
        "query-while-scanning-persist-round4-rv4.json",
    ):
        for row in json.loads((Path("docs/benchmarks") / filename).read_text())[
            "summary"
        ]:
            prior[row["kind"], row["workload"], row["mode"], row["cache"]] = row

    def get(shape, work, mode, cache, field):
        return keyed[shape, work, mode, cache][field]

    def pair(values, suffix=""):
        return " / ".join(f"{v:.3f}{suffix}" for v in values)

    def values(shape, work, mode, field="median_ms", scale=1):
        return [get(shape, work, mode, c, field) / scale for c in CACHES]

    def old(shape, work, field="median_ms", scale=1):
        rows = [prior.get((shape, work, "sidecars", c)) for c in CACHES]
        return pair([r[field] / scale for r in rows]) if all(rows) else "unmeasured"

    def status(ratios, limits):
        return " / ".join(
            "pass" if v <= limit else "miss"
            for v, limit in zip(ratios, limits, strict=True)
        )

    targets = []
    misses = []
    lines = [
        "# Query while scanning: aka round 5",
        "",
        "SUMMARY_PLACEHOLDER",
        "",
        "## Source and protocol",
        "",
        "Runtime **881a9c3**, including append-lite, index-load, validated-skip and leap-second routing 303beb8. Harness **14b4339** adds only measurement code. Actual source and binary SHA-256 values are in `bench/acceptance/results/round5-provenance.json`. No engine code changed in Verify.",
        "",
        "All builds and measurements ran on aka, native `RUSTFLAGS='-C target-cpu=x86-64-v2'`, through `scripts/qws/aka-run bench5 --x86-64-v2`. No WASM build, rakku/yari access, real data or push ran. Each preparation, priming and measured process used `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 nice -n 10 timeout` (600 seconds preparation, 180 seconds otherwise). Builds/checks held `flock -s /home/simonwjackson/work/qws5-aka.lock`; the entire accepted matrix held `flock -x` on the same lock. Load waits and five-second samples ran inside that exclusive lock.",
        "",
        "The fresh fixture has 656,640 rows per shape, January–October 2025. Samples use ten months; raw uses 256 hash shards. The added `raw_month` uses the identical complete raw rows, including `shard`, routed by `atUtc` `TimeBucket::Month` with ordered `atUtc`. It matches Logbook's partition/index layout, not its private payload, receipt frequency or revision-link writer. SQLite imports the same typed rows, TEXT primary keys, non-covering `(metric,time)` indexes, NORMAL/WAL, default cache and no mmap. Its third table holds monthly raw. `SQLITE_TMPDIR` is literally `/home/simonwjackson/work/qws-harness-data/bench5/tmp`. Synced text and NORMAL WAL do not have equal power-loss durability.",
        "",
        "Each cell has three rotating timing trials plus one independent counting-allocator trial. SQLite/missing/present order rotates by workload, repetition and profile. Missing means no saved indexes before launch; warm reads still prime the operation on the same runtime. Present means a separate process builds ID/validation indexes plus May-hour ordered indexes and closes on the exact destination inode before launch. Copying old sidecars is not treated as valid. First lookup means a fresh process, with open excluded. Cold syncs/evicts only owned file pages, including sidecars; warm prewarms relevant pages. Inode/controller caches remain. Mutation trials have independent `cp -a --reflink=auto` copies; append has no membership preflight in the measured process.",
        "",
        "Read timing includes complete-row digest or every aggregate group. Peaks are maximum timing-trial VmHWM; one-second RSS is the median with backend still open, without trim or teardown. Floors below are fastest completed trials, not physical limits. Meter timing never enters a median. All answers, including every group and full-row digest, must match SQLite; every successful mutation must independently persist exactly 1,000 rows. Requested Rust heap is not RSS; null instruction counts mean unmeasured, not zero. This fixture does not qualify general ordering, schema-error or fractional-f64 parity.",
        "",
        "Round 4 is the supplied historical measurement, not a fresh baseline build. Point/append use the latest rv4 single observations; open/idle use the original round-4 observations. Round 4 did not measure the hour/month/ten cells, so those entries stay unmeasured. The supplied design file at 881a9c3 contains no validated-skip timing table; this report measures the combined code directly. Logbook's read-only report uses different rows and warm filesystem pages for its cold column, so its times are not substituted for this matrix.",
        "",
        "## Wall time by workload",
        "",
        "Milliseconds cold / warm. Ratios and verdicts are also cold / warm. A pass must meet both cache modes. R5 first-lookup ≤5×, warm-month ≤1.5× and samples-append ≤3× are subgoals; original #12 limits remain below. Where no new cold target was given, the original #12 limit remains the bar.",
        "",
    ]

    names = {
        "point": "Point lookup",
        "hour": "One-hour full rows",
        "month": "One month, steps by UTC day",
        "ten": "Ten months, two metrics by UTC day",
        "append": "Append 1,000",
        "open": "Fresh open",
    }
    for work in ("point", "hour", "month", "ten", "append", "open"):
        lines += [
            "",
            f"### {names[work]}",
            "",
            "| Shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / SQLite | Present / SQLite | R5 limit C/W | Missing verdict | Present verdict |",
            "|---|---:|---:|---:|---:|---:|---:|---|---|---|",
        ]
        shapes = (
            ("samples", "raw", "raw_month") if work == "hour" else ("samples", "raw")
        )
        for shape in shapes:
            limits = (
                (5, 2)
                if work == "point"
                else (1.5, 1.5)
                if work == "hour"
                else (1, 1.5)
                if work == "month"
                else (3, 3)
                if work == "append" and shape == "samples"
                else (1, 1)
            )
            ratios = {
                mode: [
                    get(shape, work, mode, c, "median_ms")
                    / get(shape, work, "sqlite", c, "median_ms")
                    for c in CACHES
                ]
                for mode in MODES
            }
            lines.append(
                f"| {shape} | {pair(values(shape, work, 'sqlite'))} | {old(shape, work)} | {pair(values(shape, work, 'missing'))} | {pair(values(shape, work, 'present'))} | {pair(ratios['missing'], '×')} | {pair(ratios['present'], '×')} | {'unmeasured real-shape ≤1 s' if work == 'open' else pair(limits, '×')} | {'unmeasured' if work == 'open' else status(ratios['missing'], limits)} | {'unmeasured' if work == 'open' else status(ratios['present'], limits)} |"
            )
            if work != "open":
                for mode in MODES:
                    for c, ratio, limit in zip(
                        CACHES, ratios[mode], limits, strict=True
                    ):
                        targets.append(
                            dict(
                                family="round5",
                                shape=shape,
                                workload=work,
                                mode=mode,
                                cache=c,
                                ratio=ratio,
                                limit=limit,
                                status="pass" if ratio <= limit else "miss",
                            )
                        )

    lines += [
        "",
        "## Fresh open and idle memory",
        "",
        "MiB cold / warm. Ratio denominator is SQLite +20 MiB, not raw SQLite RSS.",
        "",
        "| Workload / shape | SQLite | Round 4, saved | R5 missing | R5 present | Missing / bar | Present / bar | Missing verdict | Present verdict |",
        "|---|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for work in ("open", "idle"):
        for shape in ("samples", "raw"):
            ratios = {
                mode: [
                    get(shape, work, mode, c, "rss_1s")
                    / (get(shape, work, "sqlite", c, "rss_1s") + 20 * MIB)
                    for c in CACHES
                ]
                for mode in MODES
            }
            lines.append(
                f"| {work}/{shape} | {pair(values(shape, work, 'sqlite', 'rss_1s', MIB))} | {old(shape, work, 'rss_1s', MIB)} | {pair(values(shape, work, 'missing', 'rss_1s', MIB))} | {pair(values(shape, work, 'present', 'rss_1s', MIB))} | {pair(ratios['missing'], '×')} | {pair(ratios['present'], '×')} | {status(ratios['missing'], (1, 1))} | {status(ratios['present'], (1, 1))} |"
            )

    lines += [
        "",
        "## Read peak and back-to-idle values",
        "",
        "MiB cold / warm. Retained is RSS above the matching fresh idle. Historical point/append peak memory comes from their latest round-4 observations. rv4 did not remeasure fresh idle, so its retained delta stays unmeasured rather than mixing blocks; other absent historical cells also stay unmeasured. Append and append-range retention are diagnostics in addition to the read requirement.",
        "",
        "| Shape / workload / metric | SQLite | Round 4, saved | R5 missing | R5 present |",
        "|---|---:|---:|---:|---:|",
    ]
    for shape in ("samples", "raw"):
        for work in (*m_reads, "append", "append-range"):
            for metric in (("peak", "rss_peak"), ("retained", "rss_1s")):
                name, field = metric
                current = {}
                for mode in ("sqlite", *MODES):
                    current[mode] = [
                        max(
                            0,
                            get(shape, work, mode, c, field)
                            - (
                                get(shape, "idle", mode, c, "rss_1s")
                                if name == "retained"
                                else 0
                            ),
                        )
                        / MIB
                        for c in CACHES
                    ]
                history = [prior.get((shape, work, "sidecars", c)) for c in CACHES]
                historical = (
                    pair([r["peak"] / MIB for r in history])
                    if all(history) and name == "peak"
                    else "unmeasured"
                )
                lines.append(
                    f"| {shape}/{work} {name} | {pair(current['sqlite'])} | {historical} | {pair(current['missing'])} | {pair(current['present'])} |"
                )

    def add_target(shape, work, mode, cache, name, ratio, limit, floor, unit, reason):
        row = dict(
            family="diagnostic"
            if name == "retained" and work in ("append", "append-range")
            else "number12",
            shape=shape,
            workload=work,
            mode=mode,
            cache=cache,
            target=name,
            ratio=ratio,
            limit=limit,
            status="pass" if ratio <= limit else "miss",
            floor=floor,
            unit=unit,
            reason=reason,
        )
        targets.append(row)
        if ratio > limit:
            misses.append(row)

    lines += [
        "",
        "## Every #12 target and back-to-idle",
        "",
        "Cold / warm ratios. Retained = max(0, RSS at 1 s − fresh idle); tolerance = max(SQLite retained, 1 MiB). Fresh-open/idle ratios divide by SQLite +20 MiB. Peak limit is 2×; all other memory ratios have limit 1×. Wall limits remain point 2×, hour 1.5×, month/ten/append 1×. Appended and append-range retained rows are extra diagnostics, not newly invented #12 requirements.",
        "",
        "| Shape / target | R5 missing ratio | R5 present ratio | Limit | Missing verdict | Present verdict |",
        "|---|---:|---:|---:|---|---|",
    ]
    for shape in ("samples", "raw"):
        for work in (
            "point",
            "hour",
            "month",
            "ten",
            "append",
            "open",
            "idle",
            "append-range",
        ):
            kinds = (
                ("wall", "peak", "retained")
                if work in m_reads
                else ("wall", "retained")
                if work == "append"
                else ("retained",)
                if work == "append-range"
                else ("fresh RSS",)
            )
            for kind in kinds:
                limit = (
                    (2 if work == "point" else 1.5 if work == "hour" else 1)
                    if kind == "wall"
                    else 2
                    if kind == "peak"
                    else 1
                )
                ratios = {mode: [] for mode in MODES}
                for mode in MODES:
                    for c in CACHES:
                        mine = keyed[shape, work, mode, c]
                        sql = keyed[shape, work, "sqlite", c]
                        if kind == "wall":
                            ratio, floor, unit, reason = (
                                mine["median_ms"] / sql["median_ms"],
                                mine["floor_ms"],
                                "ms",
                                "P"
                                if work == "point"
                                else "A"
                                if work == "append"
                                else "R",
                            )
                        elif kind == "peak":
                            ratio, floor, unit, reason = (
                                mine["rss_peak"] / sql["rss_peak"],
                                mine["rss_peak_floor"] / MIB,
                                "MiB",
                                "M",
                            )
                        elif kind == "fresh RSS":
                            ratio, floor, unit, reason = (
                                mine["rss_1s"] / (sql["rss_1s"] + 20 * MIB),
                                mine["rss_1s_floor"] / MIB,
                                "MiB",
                                "M",
                            )
                        else:
                            idle = get(shape, "idle", mode, c, "rss_1s")
                            tolerance = max(
                                sql["rss_1s"]
                                - get(shape, "idle", "sqlite", c, "rss_1s"),
                                MIB,
                            )
                            ratio, floor, unit, reason = (
                                max(0, mine["rss_1s"] - idle) / tolerance,
                                max(0, mine["rss_1s_floor"] - idle) / MIB,
                                "MiB retained",
                                "M",
                            )
                        ratios[mode].append(ratio)
                        add_target(
                            shape,
                            work,
                            mode,
                            c,
                            kind,
                            ratio,
                            limit,
                            floor,
                            unit,
                            reason,
                        )
                lines.append(
                    f"| {shape}/{work} {kind} | {pair(ratios['missing'], '×')} | {pair(ratios['present'], '×')} | {limit}× | {status(ratios['missing'], (limit, limit))} | {status(ratios['present'], (limit, limit))} |"
                )
    lines += [
        "",
        "### Controlled 16→256-shard peak growth",
        "",
        "Same 656,640 rows, ten-month aggregate. Strict observed ratio ≤1, no tolerance or scaling claim.",
        "",
        "| Mode | 16 shards peak MiB C/W | 256 shards peak MiB C/W | Ratio C/W | Verdict C/W |",
        "|---|---:|---:|---:|---|",
    ]
    for mode in ("sqlite", *MODES):
        ratios = [
            get("raw", "ten", mode, c, "rss_peak")
            / get("raw16", "ten", mode, c, "rss_peak")
            for c in CACHES
        ]
        lines.append(
            f"| {mode} | {pair(values('raw16', 'ten', mode, 'rss_peak', MIB))} | {pair(values('raw', 'ten', mode, 'rss_peak', MIB))} | {pair(ratios, '×')} | {status(ratios, (1, 1))} |"
        )
        if mode != "sqlite":
            for c, ratio in zip(CACHES, ratios, strict=True):
                floor = get("raw", "ten", mode, c, "rss_peak_floor") / get(
                    "raw16", "ten", mode, c, "rss_peak"
                )
                add_target(
                    "raw",
                    "ten",
                    mode,
                    c,
                    "16→256 growth",
                    ratio,
                    1,
                    floor,
                    "ratio",
                    "M",
                )
    lines += [
        "",
        "## Ordered append then range",
        "",
        "October last-hour prime, append 1,000 new IDs at the last October timestamp, then range on the same runtime. Returned rows must be 1,090. Cold/warm describes starting file pages; neither is an untouched cold append. All values are ms C/W; this diagnostic does not replace ordinary append.",
        "",
        "| Shape / mode | Combined | Append stage | Following range |",
        "|---|---:|---:|---:|",
    ]
    for shape in ("samples", "raw"):
        for mode in ("sqlite", *MODES):
            stages = [
                get(shape, "append-range", mode, c, "sync_stages_ms") for c in CACHES
            ]
            lines.append(
                f"| {shape}/{mode} | {pair(values(shape, 'append-range', mode))} | {pair([s[0] for s in stages])} | {pair([s[1] for s in stages])} |"
            )

    lines += [
        "",
        "## Every miss: floor, reason and next step",
        "",
        "Each row names its observed floor and a reason/next-step code below. Missing-index warm reads have already paid their first scan before the timer. Reasons are inferred from code and builder phase profiles, not isolated stage timers in this matrix. No target is lowered.",
        "",
        "| Code | Reason | Next step and cost |",
        "|---|---|---|",
        "| P | Missing restart builds full validation/membership; saved restart still reads/checks every locator and a global uniqueness proof. Warm lookup freshly observes all 10/256 files and verifies the hit. | Page-checkable locators plus a generation-set uniqueness certificate; profile prepared host calls. New format/proof/race work. Removing fresh metadata is unsafe without stronger host evidence. |",
        "| R | First-use range validates/builds checkpoints; indexed raw still fans out to 256 files. Large aggregates still decode/fold all matching rows, with schema/identity guards and canonical ordering. | Profile decoder/fold and cold I/O separately. Monthly raw reduces range fanout, but costs consumer migration and does not close the 256-shard target. Further skip work needs the exact-generation and error-parity proofs. |",
        "| A | Fresh membership, first baseline hashing, checked post-sync prefix reads and durable target fanout remain. Raw synchronizes 256 files. | Serializable baseline hash state and prepared target handles; versioning and race/fault tests required. No-prefix proof is blocked without enforced write ownership or per-range filesystem evidence. Do not remove sync. |",
        "| M | Locators/time checkpoints, transient identity/output buffers and allocator-held pages raise peak/retained RSS. More files add metadata. Release does not force glibc to return pages. | Profile allocation sites and bound scratch storage; page-checkable locators may lower the transient uniqueness set. Costs format/proof complexity; no guaranteed OS reclamation, trim or teardown substituted. |",
        "",
        "| Shape / workload / mode / cache | Missed target | Observed floor | Median or peak ratio / limit | Reason and next step |",
        "|---|---|---:|---:|---|",
    ]
    # Include round-5-only misses, not just the stricter original wall target.
    for row in targets:
        if row["family"] == "round5" and row["status"] == "miss":
            floor = get(
                row["shape"], row["workload"], row["mode"], row["cache"], "floor_ms"
            )
            misses.append(
                dict(
                    row,
                    target="R5 wall",
                    floor=floor,
                    unit="ms",
                    reason="P"
                    if row["workload"] == "point"
                    else "A"
                    if row["workload"] == "append"
                    else "R",
                )
            )
    for row in misses:
        lines.append(
            f"| {row['shape']}/{row['workload']}/{row['mode']}/{row['cache']} | {row['target']} | {row['floor']:.3f} {row['unit']} | {row['ratio']:.3f}× / {row['limit']}× | {row['reason']} |"
        )

    load = json.loads((OUT / "load.json").read_text())
    accepted = next(b for b in load if b["accepted"])
    trials = [
        json.loads(line)
        for line in (OUT / f"block-{accepted['attempt']}" / "trials.jsonl")
        .read_text()
        .splitlines()
    ]
    assert len(trials) == 432
    assert sum(r.get("rows_persisted") == 1000 for r in trials) == 96
    load_max = max(
        [s["load"][0] for s in accepted["samples"]] + [r["load"][0] for r in trials]
    )
    assert load_max <= 2, "reject and repeat block: trial-boundary load exceeded 2"
    provenance = json.loads((OUT / "provenance.json").read_text())
    for name, expected_hash in provenance["sha256"].items():
        assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected_hash, (
            name
        )
    provenance["final_source_hashes_match"] = True
    provenance["runtime_sha"] = "881a9c3d579cb0c6bf212d257e7698a824fcbe77"
    provenance["harness_sha"] = "14b433958d0821be1dfa8176eefd9e1419bde5be"
    provenance["lifecycle_source_sha256"] = hashlib.sha256(
        Path("bench/acceptance/examples/persist_lifecycle.rs").read_bytes()
    ).hexdigest()
    answers = json.loads((OUT / "equivalence.json").read_text())
    for trial in trials:
        assert trial["answer"] == answers[f"{trial['shape']}/{trial['workload']}"], (
            trial
        )
    assert not Path("/home/simonwjackson/work/qws-harness-data/bench5").exists()
    lines += [
        "",
        "## Target totals",
        "",
        "A target row passes only when both cold and warm pass. Diagnostic append retention is excluded from these totals.",
        "",
        "| Family / mode | Passed rows | Missed rows |",
        "|---|---:|---:|",
    ]
    for family in ("round5", "number12"):
        for mode in MODES:
            grouped = {}
            for target in targets:
                if target["family"] == family and target["mode"] == mode:
                    grouped.setdefault(
                        (
                            target["shape"],
                            target["workload"],
                            target.get("target", "wall"),
                        ),
                        [],
                    ).append(target)
            passes = sum(
                all(t["status"] == "pass" for t in group) for group in grouped.values()
            )
            lines.append(f"| {family}/{mode} | {passes} | {len(grouped) - passes} |")
    lines += [
        "",
        "## Checks, load and cleanup",
        "",
        f"Accepted block {accepted['attempt']}; maximum sampled one-minute load **{load_max:.6f}**. {len(load) - 1} high-load blocks rejected. Start load {accepted['samples'][0]['load'][0]:.6f}; final load {accepted['samples'][-1]['load'][0]:.6f}. All **432** public-path trials completed: 324 timing and 108 independent meter trials. All **96** mutation trials persisted exactly 1,000 rows. All six backend/shape global-conflict controls passed. No answer mismatch occurred.",
        "",
        "Load coordination note: the parent's follow-on consumer check briefly ran outside its shared lock near the start of attempt 1. The parent confirmed it had finished during the first repetition and ran nothing else on aka afterward. Verify held its exclusive lock throughout. The recorded load policy, rather than a claim of perfect host isolation, decides block acceptance; all per-trial loads are checked as well as five-second samples. This remains a source of shared-host variation if attempt 1 is accepted.",
        "",
        "Focused harness `cargo check` all-target/all-feature, release tests (**6 passed**), clippy `-D warnings`, Rust format, Python unit tests (**6 passed**), Ruff check/format and all three native release builds passed on aka. The monthly fixture regression checks complete-row SQLite/hash-shard equality and exactly one examined month. No full repository suite ran in Verify; the parent owns the combined release gate.",
        "",
        "Final cleanup verified `FINAL_BENCH5_DATA_AND_COPIED_BINARIES_ABSENT`. Synthetic source/SQLite/temp data and per-trial copies under `/home/simonwjackson/work/qws-harness-data/bench5`, the separate check temp directory and all three copied benchmark binaries are absent. Small raw logs/evidence remain under `/home/simonwjackson/work/qws-bench5-results`; Cargo caches remain. No shared source data or service was changed.",
        "",
        "Absolute Celeron latency, real Logbook open ≤1 second, equal-power-loss-durability comparison, consumer deployment and the missed targets remain open. aka's Ryzen 5 7600X is only a synthetic same-machine SQLite proxy.",
    ]
    summary_lines = []
    for work in ("point", "hour", "month", "ten", "append"):
        ratios = [
            get(shape, work, "present", "warm", "median_ms")
            / get(shape, work, "sqlite", "warm", "median_ms")
            for shape in ("samples", "raw")
        ]
        summary_lines.append(f"{work}: {ratios[0]:.2f}× / {ratios[1]:.2f}×")
    monthly = get("raw_month", "hour", "present", "warm", "median_ms") / get(
        "raw_month", "hour", "sqlite", "warm", "median_ms"
    )
    fresh = (
        max(
            get(shape, work, "present", c, "rss_1s")
            for shape in ("samples", "raw")
            for work in ("open", "idle")
            for c in CACHES
        )
        / MIB
    )
    sql_fresh = (
        max(
            get(shape, work, "sqlite", c, "rss_1s")
            for shape in ("samples", "raw")
            for work in ("open", "idle")
            for c in CACHES
        )
        / MIB
    )
    first = [
        get(shape, "point", "present", "cold", "median_ms")
        / get(shape, "point", "sqlite", "cold", "median_ms")
        for shape in ("samples", "raw")
    ]
    lines[2] = (
        "**Monthly raw puts the warm hour near SQLite; 256-shard raw does not. Lookup, aggregates and append remain slower.** Warm, saved-index samples / 256-shard raw versus SQLite: "
        + "; ".join(summary_lines)
        + f". Monthly raw hour: **{monthly:.2f}×**. First lookup: {first[0]:.1f}× / {first[1]:.1f}×. Fresh open/idle reaches {fresh:.2f} MiB versus SQLite {sql_fresh:.2f} MiB; back-to-idle is a separate target below. All answers match."
    )
    Path("docs/benchmarks/query-while-scanning-aka-round5.md").write_text(
        "\n".join(lines) + "\n"
    )
    with (DEST / "round5.jsonl").open("w") as stream:
        for row in summary + targets:
            stream.write(json.dumps(row, separators=(",", ":")) + "\n")
    (DEST / "round5-provenance.json").write_text(
        json.dumps(
            dict(
                provenance,
                load_max=load_max,
                accepted_block=accepted["attempt"],
                rejected_blocks=len(load) - 1,
                trials=432,
                all_answers_match=True,
                mutations=96,
                all_persisted=1000,
                answer_checks={
                    k: dict(
                        count=v["count"],
                        sum=v["sum"],
                        sha256=hashlib.sha256(
                            json.dumps(v, sort_keys=True).encode()
                        ).hexdigest(),
                    )
                    for k, v in answers.items()
                },
            ),
            indent=2,
        )
        + "\n"
    )
    print(lines[2])
    print(
        "REPORT_RENDERED",
        len(lines),
        "lines",
        len(targets),
        "targets",
        len(misses),
        "miss rows",
    )


m_reads = ("point", "hour", "month", "ten")
if __name__ == "__main__":
    main()
