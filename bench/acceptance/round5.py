#!/usr/bin/env python3
"""Aka-only round-5 acceptance: missing/present indexes and monthly raw."""

import hashlib
import json
import os
import shutil
import statistics
import subprocess
import threading
import time
from pathlib import Path

import measure as m

DATA = Path("/home/simonwjackson/work/qws-harness-data/bench5")
OUT = Path("/home/simonwjackson/work/qws-bench5-results")
MODES = ("sqlite", "missing", "present")
SHAPES = ("samples", "raw", "raw16", "raw_month")


def run(args, limit=180):
    command = m.scope(limit) + [str(a) for a in args]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(
            f"{command}: {result.returncode}\n{result.stdout}\n{result.stderr}"
        )
    return json.loads(result.stdout)


def summarize(rows):
    summaries = []
    for shape in SHAPES:
        workloads = (
            ("ten",)
            if shape == "raw16"
            else ("hour",)
            if shape == "raw_month"
            else m.WORKLOADS
        )
        for workload in workloads:
            for mode in MODES:
                for cache in m.CACHES:
                    cells = [
                        r
                        for r in rows
                        if (
                            r["shape"],
                            r["workload"],
                            r["mode"],
                            r["cache"],
                            r["profile"],
                        )
                        == (shape, workload, mode, cache, "timing")
                    ]
                    assert len(cells) == 3
                    meter = next(
                        r
                        for r in rows
                        if (
                            r["shape"],
                            r["workload"],
                            r["mode"],
                            r["cache"],
                            r["profile"],
                        )
                        == (shape, workload, mode, cache, "meter")
                    )
                    summaries.append(
                        dict(
                            shape=shape,
                            workload=workload,
                            mode=mode,
                            cache=cache,
                            median_ms=statistics.median(r["wall_ms"] for r in cells),
                            floor_ms=min(r["wall_ms"] for r in cells),
                            rss_peak=max(r["rss_peak"] for r in cells),
                            rss_peak_floor=min(r["rss_peak"] for r in cells),
                            rss_1s=statistics.median(r["rss_1s"] for r in cells),
                            rss_1s_floor=min(r["rss_1s"] for r in cells),
                            release_ms=statistics.median(r["release_ms"] for r in cells)
                            if cells[0]["release_ms"] is not None
                            else None,
                            rss_release_1s=statistics.median(
                                r["rss_release_1s"] for r in cells
                            )
                            if cells[0]["rss_release_1s"] is not None
                            else None,
                            sync_stages_ms=[
                                statistics.median(r["sync_stages_ms"][i] for r in cells)
                                for i in (0, 1)
                            ]
                            if cells[0]["sync_stages_ms"]
                            else None,
                            rust_heap_live_peak=meter["rust_heap_live_peak"],
                            sqlite_c_heap_live_peak=meter["sqlite_c_heap_live_peak"],
                            instructions=meter["instructions"],
                            file_cache_before=statistics.median(
                                r["file_cache_before"] for r in cells
                            ),
                        )
                    )
    return summaries


def block(out):
    assert not DATA.exists(), "fresh owned data directory required"
    DATA.mkdir(parents=True)
    (DATA / "tmp").mkdir()
    os.environ["SQLITE_TMPDIR"] = "/home/simonwjackson/work/qws-harness-data/bench5/tmp"
    os.environ["TMPDIR"] = os.environ["SQLITE_TMPDIR"]
    timing, meter, probe = (
        OUT / name for name in ("timing", "meter", "persist_lifecycle")
    )
    expected, rows = {}, []
    try:
        run([timing, "prepare", DATA / "base"], 600)
        run([timing, "prepare16", DATA / "base16"], 600)
        duplicates = {}
        for backend in ("sqlite", "streaming"):
            for kind in ("samples", "raw", "raw_month"):
                root = DATA / f"probe-{backend}-{kind}"
                result = run([timing, "duplicate-check", root, backend, kind])
                assert result["global_duplicate_checks"], (backend, kind)
                duplicates[f"{backend}/{kind}"] = True
                shutil.rmtree(root)
        (out / "duplicates.json").write_text(json.dumps(duplicates, indent=2))
        # Read modes have independent inodes. Publish only on each exact destination.
        for suffix in ("", "16"):
            subprocess.run(
                [
                    "cp",
                    "-a",
                    "--reflink=auto",
                    str(DATA / f"base{suffix}"),
                    str(DATA / f"present{suffix}"),
                ],
                check=True,
            )
            for kind in ("raw",) if suffix else ("samples", "raw", "raw_month"):
                run([probe, DATA / f"present{suffix}", kind, "time"])
        for profile in ("timing", "meter"):
            for repeat in range(3 if profile == "timing" else 1):
                for shape in SHAPES:
                    kind = "raw" if shape == "raw16" else shape
                    suffix = "16" if shape == "raw16" else ""
                    workloads = (
                        ("ten",)
                        if shape == "raw16"
                        else ("hour",)
                        if shape == "raw_month"
                        else m.WORKLOADS
                    )
                    for wi, workload in enumerate(workloads):
                        rotation = (repeat + wi + (profile == "meter")) % len(MODES)
                        for mode in MODES[rotation:] + MODES[:rotation]:
                            for cache in m.CACHES:
                                backend = "sqlite" if mode == "sqlite" else "streaming"
                                base = (
                                    DATA
                                    / f"{'present' if mode == 'present' else 'base'}{suffix}"
                                )
                                root = base
                                mutation = workload in ("append", "append-range")
                                if mutation:
                                    root = DATA / "trial"
                                    subprocess.run(
                                        [
                                            "cp",
                                            "-a",
                                            "--reflink=auto",
                                            str(DATA / f"base{suffix}"),
                                            str(root),
                                        ],
                                        check=True,
                                    )
                                if mode == "missing" or mutation:
                                    shutil.rmtree(
                                        root / kind / ".proseql-index",
                                        ignore_errors=True,
                                    )
                                if mode == "present" and mutation:
                                    run([probe, root, kind, "time"])
                                relevant = m.files(root, backend, kind)
                                m.evict(
                                    sorted(p for p in root.rglob("*") if p.is_file())
                                )
                                if cache == "warm":
                                    m.warm(relevant)
                                before = m.residency(relevant)
                                sizes = {
                                    p: p.stat().st_size
                                    for p in (root / kind).glob("*.jsonl")
                                }
                                row = run(
                                    [
                                        timing if profile == "timing" else meter,
                                        root,
                                        backend,
                                        kind,
                                        workload,
                                        cache,
                                    ]
                                )
                                key = (shape, workload)
                                if key in expected and expected[key] != row["answer"]:
                                    reproduction = dict(
                                        shape=shape,
                                        workload=workload,
                                        mode=mode,
                                        cache=cache,
                                        expected=expected[key],
                                        actual=row["answer"],
                                        root=str(root),
                                    )
                                    (out / "MISMATCH.json").write_text(
                                        json.dumps(reproduction, indent=2)
                                    )
                                    raise AssertionError(
                                        f"BUG: answer mismatch: {reproduction}"
                                    )
                                expected[key] = row["answer"]
                                if mutation:
                                    row["rows_persisted"] = m.verify_append(
                                        root, kind, backend, sizes
                                    )
                                    assert row["rows_persisted"] == 1000
                                row.update(
                                    shape=shape,
                                    mode=mode,
                                    repeat=repeat,
                                    profile=profile,
                                    file_cache_before=before,
                                    file_cache_after=m.residency(
                                        m.files(root, backend, kind)
                                    ),
                                    load=os.getloadavg(),
                                )
                                rows.append(row)
                                with (out / "trials.jsonl").open("a") as stream:
                                    stream.write(json.dumps(row) + "\n")
                                print(
                                    profile,
                                    repeat,
                                    shape,
                                    workload,
                                    mode,
                                    cache,
                                    row["wall_ms"],
                                    flush=True,
                                )
                                if mutation:
                                    shutil.rmtree(root)
        summary = summarize(rows)
        (out / "summary.json").write_text(json.dumps(summary, indent=2))
        (out / "equivalence.json").write_text(
            json.dumps({"/".join(k): v for k, v in expected.items()}, indent=2)
        )
        assert len(rows) == 432
    finally:
        shutil.rmtree(DATA)
        print("BENCH5_DATA_REMOVED", not DATA.exists(), flush=True)


def main():
    assert os.uname().nodename.split(".")[0] == "aka"
    assert os.environ["RUSTFLAGS"] == "-C target-cpu=x86-64-v2"
    OUT.mkdir(exist_ok=True)
    source_files = (
        sorted(Path("crates").rglob("*.rs"))
        + sorted(Path("crates").rglob("Cargo.toml"))
        + list(Path("bench/acceptance/src").glob("*.rs"))
        + list(Path("bench/acceptance").glob("*.py"))
        + [Path("bench/acceptance/Cargo.lock"), Path("bench/acceptance/Cargo.toml")]
    )
    provenance = dict(
        source_sha=os.environ.get("QWS_SOURCE_SHA", "unknown"),
        rustflags=os.environ["RUSTFLAGS"],
        sha256={
            str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in source_files
            + [OUT / name for name in ("timing", "meter", "persist_lifecycle")]
        },
    )
    (OUT / "provenance.json").write_text(json.dumps(provenance, indent=2))
    blocks = []
    for attempt in range(1, 4):
        while os.getloadavg()[0] > 1:
            time.sleep(5)
        out = OUT / f"block-{attempt}"
        out.mkdir()
        samples = []
        stop = threading.Event()

        def sample():
            while not stop.is_set():
                samples.append(dict(time=time.time(), load=os.getloadavg()))
                stop.wait(5)

        monitor = threading.Thread(target=sample, daemon=True)
        monitor.start()
        try:
            block(out)
        finally:
            stop.set()
            monitor.join()
            samples.append(dict(time=time.time(), load=os.getloadavg()))
            accepted = max(s["load"][0] for s in samples) <= 2
            blocks.append(dict(attempt=attempt, accepted=accepted, samples=samples))
            (OUT / "load.json").write_text(json.dumps(blocks, indent=2))
        if accepted:
            for name in ("summary.json", "duplicates.json", "equivalence.json"):
                shutil.copyfile(out / name, OUT / name)
            return
        print("HIGH LOAD: repeat whole block", attempt, flush=True)
    raise RuntimeError("three high-load blocks rejected")


if __name__ == "__main__":
    main()
