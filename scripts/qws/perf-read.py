#!/usr/bin/env python3
"""Focused #20 reads: rotating public-API timings, perf and separate heap trials."""

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("measure", "bench/acceptance/measure.py")
measure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measure)
if os.uname().nodename.split(".")[0] != "aka":
    raise RuntimeError("measurements are allowed only on aka")
data = Path("/home/simonwjackson/work/qws-perf-read-data")
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=False)
(out / "source.sha").write_text(os.environ.get("QWS_SOURCE_SHA", "unknown") + "\n")
source_files = sorted(
    path
    for root in (Path("crates"), Path("bench/acceptance/src"))
    for path in root.rglob("*")
    if path.is_file()
    and (path.suffix == ".rs" or path.name in ("Cargo.toml", "Cargo.lock"))
)
(out / "source-files.sha256").write_text(
    "".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path}\n"
        for path in source_files
    )
)
workloads = [
    ("samples", "ten"),
    ("samples", "month"),
    ("samples", "hour"),
    ("samples", "point"),
    ("raw", "ten"),
    ("raw", "hour"),
]
expected = {}
with (out / "trials.jsonl").open("w") as output:
    for profile in os.environ.get("READ_PROFILES", "timing,meter").split(","):
        repeats = int(os.environ.get("READ_REPEATS", "3")) if profile == "timing" else 1
        backends = (
            os.environ.get("READ_BACKENDS", "sqlite,streaming").split(",")
            if profile == "timing"
            else ["streaming"]
        )
        for repeat in range(repeats):
            for wi, (kind, workload) in enumerate(workloads):
                rotation = (repeat + wi) % len(backends)
                for backend in backends[rotation:] + backends[:rotation]:
                    for cache in ("cold", "warm"):
                        root = data / "base"
                        relevant = measure.files(root, backend, kind)
                        measure.evict(relevant)
                        if cache == "warm":
                            measure.warm(relevant)
                        before = measure.residency(relevant)
                        name = f"{profile}-{kind}-{workload}-{backend}-{cache}-{repeat}"
                        command = measure.scope(180)
                        if profile == "timing" and repeat == 0:
                            command += [
                                "perf",
                                "stat",
                                "-e",
                                "instructions:u",
                                "-o",
                                str(out / f"{name}.perf"),
                                "--",
                            ]
                        command += [
                            str(data / profile),
                            str(root),
                            backend,
                            kind,
                            workload,
                            cache,
                        ]
                        result = subprocess.run(
                            command, text=True, capture_output=True, check=True
                        )
                        row = json.loads(result.stdout)
                        key = (kind, workload)
                        if key in expected:
                            assert expected[key] == row["answer"], name
                        expected[key] = row["answer"]
                        row.update(
                            profile=profile,
                            repeat=repeat,
                            load=os.getloadavg(),
                            file_cache_before=before,
                            file_cache_after=measure.residency(relevant),
                        )
                        output.write(json.dumps(row) + "\n")
                        output.flush()
                        print(
                            name,
                            row["wall_ms"],
                            row["instructions"],
                            row["rust_heap_live_peak"],
                            flush=True,
                        )
