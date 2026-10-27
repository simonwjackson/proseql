#!/usr/bin/env python3
"""Focused aka-only #18 sidecar comparisons through the acceptance public API."""

import importlib.util
import json
import os
import shutil
import statistics
import subprocess
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("measure", "bench/acceptance/measure.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert os.uname().nodename.split(".")[0] == "aka"
data = Path("/home/simonwjackson/work/qws-harness-data/persist")
out = Path(
    os.environ.get("PERSIST_RESULTS", "/home/simonwjackson/work/qws-persist-results")
)
repeats = int(os.environ.get("PERSIST_REPEATS", "3"))
workloads = os.environ.get("PERSIST_WORKLOADS", "point,append,open,idle").split(",")
assert repeats > 0 and all(w in ("point", "append", "open", "idle") for w in workloads)
out.mkdir(exist_ok=True)
data.mkdir(parents=True, exist_ok=True)
(data / "tmp").mkdir(exist_ok=True)
os.environ["SQLITE_TMPDIR"] = str(data / "tmp")
os.environ["TMPDIR"] = str(data / "tmp")
binary = Path(os.environ["CARGO_TARGET_DIR"]) / "release/proseql-acceptance"
probe = binary.parent / "examples/persist_lifecycle"
base = data / "base"
assert not base.exists(), "prepare requires fresh data"


def run(args, limit=180):
    result = subprocess.run(
        m.scope(limit) + [str(a) for a in args],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


run([binary, "prepare", base], 600)
expected = {}
rows = []
lifecycle = []
loads = []
while os.getloadavg()[0] > 1:
    time.sleep(5)
try:
    for kind in ("samples", "raw"):
        # First-build publication alternatives; reset sidecars before each.
        for action in ("release", "close"):
            shutil.rmtree(base / kind / ".proseql-index", ignore_errors=True)
            lifecycle.append(run([probe, base, kind, action]))
        lifecycle.append(run([probe, base, kind, "time"]))
    sizes = {
        kind: {
            "logical_bytes": sum(
                p.stat().st_size
                for p in (base / kind / ".proseql-index").rglob("*")
                if p.is_file()
            ),
            "allocated_bytes": sum(
                p.stat().st_blocks * 512
                for p in (base / kind / ".proseql-index").rglob("*")
                if p.is_file()
            ),
            "files": len(list((base / kind / ".proseql-index").glob("*.idx"))),
        }
        for kind in ("samples", "raw")
    }
    for repeat in range(repeats):
        for kind in ("samples", "raw"):
            for workload in workloads:
                if repeat and workload in ("open", "idle"):
                    continue
                modes = ["sqlite", "missing", "sidecars"]
                modes = modes[repeat:] + modes[:repeat]
                for mode in modes:
                    for cache in ("cold", "warm"):
                        root = data / "trial"
                        subprocess.run(
                            ["cp", "-a", "--reflink=auto", str(base), str(root)],
                            check=True,
                        )
                        try:
                            backend = "sqlite" if mode == "sqlite" else "streaming"
                            sidecars = root / kind / ".proseql-index"
                            shutil.rmtree(sidecars, ignore_errors=True)
                            if mode == "sidecars":
                                # Copying changes inode tokens. Publish checked metadata
                                # for THIS directory before launching the fresh process.
                                run([probe, root, kind, "close"])
                            relevant = m.files(root, backend, kind)
                            m.evict(sorted(p for p in root.rglob("*") if p.is_file()))
                            if cache == "warm":
                                m.warm(relevant)
                            before = m.residency(relevant)
                            sizes_before = {
                                p: p.stat().st_size
                                for p in (root / kind).glob("*.jsonl")
                            }
                            row = run([binary, root, backend, kind, workload, cache])
                            if workload == "append":
                                assert (
                                    m.verify_append(root, kind, backend, sizes_before)
                                    == 1000
                                )
                            key = (kind, workload)
                            if key in expected:
                                assert expected[key] == row["answer"], (key, mode)
                            expected[key] = row["answer"]
                            row.update(
                                mode=mode,
                                repeat=repeat,
                                file_cache_before=before,
                                load=os.getloadavg(),
                            )
                            rows.append(row)
                            loads.append(os.getloadavg()[0])
                            with (out / "trials.json").open("w") as f:
                                json.dump(rows, f)
                            print(
                                kind,
                                workload,
                                mode,
                                cache,
                                repeat,
                                row["wall_ms"],
                                flush=True,
                            )
                        finally:
                            shutil.rmtree(root)
    summaries = []
    for kind in ("samples", "raw"):
        for workload in workloads:
            for mode in ("sqlite", "missing", "sidecars"):
                for cache in ("cold", "warm"):
                    cell = [
                        r
                        for r in rows
                        if (r["kind"], r["workload"], r["mode"], r["cache"])
                        == (kind, workload, mode, cache)
                    ]
                    summaries.append(
                        dict(
                            kind=kind,
                            workload=workload,
                            mode=mode,
                            cache=cache,
                            median_ms=statistics.median(r["wall_ms"] for r in cell),
                            floor_ms=min(r["wall_ms"] for r in cell),
                            peak=max(r["rss_peak"] for r in cell),
                            rss_1s=max(r["rss_1s"] for r in cell),
                            release_ms=statistics.median(
                                r["release_ms"]
                                for r in cell
                                if r["release_ms"] is not None
                            )
                            if workload == "point" and mode != "sqlite"
                            else None,
                        )
                    )
    result = dict(
        summary=summaries,
        lifecycle=lifecycle,
        sizes=sizes,
        load_max=max(loads),
        all_answers_match=True,
        all_append_counts=1000,
    )
    (out / "summary.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    assert max(loads) <= 2, "load block rejected; rerun on fresh data"
finally:
    shutil.rmtree(data)
    print("PERSIST_DATA_CLEANED", not data.exists(), flush=True)
