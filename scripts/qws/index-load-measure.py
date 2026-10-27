#!/usr/bin/env python3
"""Aka-only saved-ID point timings, independent perf and counting allocator."""

import hashlib
import importlib.util
import json
import os
import shutil
import statistics
import subprocess
import threading
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("measure", "bench/acceptance/measure.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert os.uname().nodename.split(".")[0] == "aka"
data = Path("/home/simonwjackson/work/qws-harness-data/index-load")
stage = os.environ.get("INDEX_LOAD_STAGE", "baseline")
out = Path("/home/simonwjackson/work/qws-index-load-results") / stage
repeats = int(os.environ.get("INDEX_LOAD_REPEATS", "1"))
out.mkdir(parents=True, exist_ok=True)
data.mkdir(parents=True, exist_ok=True)
(data / "tmp").mkdir(exist_ok=True)
os.environ["SQLITE_TMPDIR"] = "/home/simonwjackson/work/qws-harness-data/index-load/tmp"
os.environ["TMPDIR"] = os.environ["SQLITE_TMPDIR"]
base = data / "base"
assert not base.exists(), "prepare requires a fresh directory"
target = Path(os.environ["CARGO_TARGET_DIR"]) / "release"
timing = out / "timing"
meter = out / "meter"
assert timing.is_file() and meter.is_file(), (
    "build both binaries under a shared lock first"
)
probe = target / "examples/persist_lifecycle"


def run(args, limit=180):
    result = subprocess.run(
        m.scope(limit) + [str(a) for a in args],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


provenance = {
    "source_sha": os.environ.get("QWS_SOURCE_SHA", "unknown-rsync-source"),
    "rustflags": os.environ.get("RUSTFLAGS"),
    "sha256": {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in [timing, meter, probe]
        + (
            []
            if stage.startswith("baseline")
            else sorted(Path("crates/proseql-storage/src/index").rglob("*.rs"))
            + [Path("crates/proseql-native/src/locate.rs")]
        )
    },
}
(out / "provenance.json").write_text(json.dumps(provenance, indent=2))
rows = []
loads = []
stop = threading.Event()
expected = {}


def sample_load():
    while not stop.is_set():
        loads.append((time.time(), os.getloadavg()[0]))
        stop.wait(5)


try:
    run([timing, "prepare", base], 600)
    for kind in ("samples", "raw"):
        run([probe, base, kind, "close"])
    while os.getloadavg()[0] > 1:
        time.sleep(5)
    monitor = threading.Thread(target=sample_load, daemon=True)
    monitor.start()
    for profile in ("timing", "meter"):
        for repeat in range(repeats if profile == "timing" else 1):
            for kind in ("samples", "raw"):
                modes = (
                    ("sqlite", "streaming")
                    if repeat % 2 == 0
                    else ("streaming", "sqlite")
                )
                for backend in modes:
                    for cache in ("cold", "warm"):
                        relevant = m.files(base, backend, kind)
                        all_files = sorted(p for p in base.rglob("*") if p.is_file())
                        m.evict(all_files)
                        if cache == "warm":
                            m.warm(relevant)
                        args = [
                            timing if profile == "timing" else meter,
                            base,
                            backend,
                            kind,
                            "point",
                            cache,
                        ]
                        if profile == "meter":
                            args = [
                                "perf",
                                "stat",
                                "-e",
                                "instructions:u",
                                "-o",
                                out / f"{kind}-{backend}-{cache}.perf",
                                "--",
                            ] + args
                        row = run(args)
                        key = kind
                        if key in expected:
                            assert expected[key] == row["answer"], (
                                kind,
                                backend,
                                cache,
                            )
                        expected[key] = row["answer"]
                        row.update(profile=profile, repeat=repeat, load=os.getloadavg())
                        rows.append(row)
                        (out / "trials.json").write_text(json.dumps(rows, indent=2))
                        print(
                            profile,
                            repeat,
                            kind,
                            backend,
                            cache,
                            row["wall_ms"],
                            flush=True,
                        )
    summary = []
    for kind in ("samples", "raw"):
        for backend in ("sqlite", "streaming"):
            for cache in ("cold", "warm"):
                cells = [
                    r
                    for r in rows
                    if (r["kind"], r["backend"], r["cache"], r["profile"])
                    == (kind, backend, cache, "timing")
                ]
                metered = next(
                    r
                    for r in rows
                    if (r["kind"], r["backend"], r["cache"], r["profile"])
                    == (kind, backend, cache, "meter")
                )
                summary.append(
                    dict(
                        kind=kind,
                        backend=backend,
                        cache=cache,
                        median_ms=statistics.median(r["wall_ms"] for r in cells),
                        floor_ms=min(r["wall_ms"] for r in cells),
                        heap=metered["rust_heap_live_peak"],
                        instructions=metered["instructions"],
                        peak=max(r["rss_peak"] for r in cells),
                    )
                )
    stop.set()
    monitor.join()
    (out / "load.json").write_text(json.dumps(loads, indent=2))
    assert max([r["load"][0] for r in rows] + [load for _, load in loads]) <= 2, (
        "load block rejected"
    )
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2), flush=True)
finally:
    stop.set()
    shutil.rmtree(data)
    print("INDEX_LOAD_DATA_CLEANED", not data.exists(), flush=True)
