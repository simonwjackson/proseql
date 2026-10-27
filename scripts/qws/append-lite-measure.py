#!/usr/bin/env python3
"""Focused round-5 append measurements; aka and synthetic owned data only."""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("measure", "bench/acceptance/measure.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert os.uname().nodename.split(".")[0] == "aka"
phase = sys.argv[1]
assert phase in ("before", "after")
data = Path("/home/simonwjackson/work/qws-harness-data/append-lite")
out = Path("/home/simonwjackson/work/qws-append-lite-results")
base = data / "base"
data.mkdir(parents=True, exist_ok=True)
(data / "tmp").mkdir(exist_ok=True)
os.environ["TMPDIR"] = str(data / "tmp")
os.environ["SQLITE_TMPDIR"] = str(data / "tmp")
timing = out / f"{phase}-timing"
profile = out / f"{phase}-profile"
lifecycle = out / "lifecycle"


def run(args, limit=180):
    return subprocess.run(
        m.scope(limit) + [str(a) for a in args],
        check=True,
        text=True,
        capture_output=True,
    )


def copy():
    root = data / "trial"
    assert not root.exists()
    subprocess.run(["cp", "-a", "--reflink=auto", str(base), str(root)], check=True)
    return root


def settle():
    while os.getloadavg()[0] > 1:
        time.sleep(5)


if phase == "before" and "--reuse-base" not in sys.argv:
    assert not base.exists(), "prepare needs a fresh directory"
    run([timing, "prepare", base], 600)
assert base.is_dir()
loads = []
stop = threading.Event()


def sample_load():
    while not stop.is_set():
        loads.append(os.getloadavg()[0])
        stop.wait(5)


settle()
thread = threading.Thread(target=sample_load, daemon=True)
thread.start()
rows = []
expected = {}
for repeat in range(3):
    for kind in ("samples", "raw"):
        modes = ["sqlite", "streaming"]
        if repeat % 2:
            modes.reverse()
        for backend in modes:
            for cache in ("cold", "warm"):
                settle()
                root = copy()
                try:
                    if backend == "streaming":
                        run([lifecycle, root, kind, "close"])
                    relevant = m.files(root, backend, kind)
                    m.evict(sorted(p for p in root.rglob("*") if p.is_file()))
                    if cache == "warm":
                        m.warm(relevant)
                    residency = m.residency(relevant)
                    sizes = {p: p.stat().st_size for p in (root / kind).glob("*.jsonl")}
                    row = json.loads(
                        run([timing, root, backend, kind, "append", cache]).stdout
                    )
                    assert m.verify_append(root, kind, backend, sizes) == 1000
                    if kind in expected:
                        assert expected[kind] == row["answer"]
                    expected[kind] = row["answer"]
                    row.update(
                        repeat=repeat, file_cache_before=residency, load=os.getloadavg()
                    )
                    assert row["load"][0] <= 2
                    rows.append(row)
                    (out / f"{phase}-timing.json").write_text(
                        json.dumps(rows, indent=2)
                    )
                    print(
                        phase, kind, backend, cache, repeat, row["wall_ms"], flush=True
                    )
                finally:
                    shutil.rmtree(root)

# Independent allocation/phase and strace probes; not wall-time qualification.
for kind in ("samples", "raw"):
    for tool in ("profile", "strace1", "strace2"):
        settle()
        root = copy()
        try:
            run([lifecycle, root, kind, "close"])
            m.warm(m.files(root, "streaming", kind))
            batches = 1 if tool == "strace1" else 2
            command = [profile, "repeat", root, kind, str(batches)]
            if tool.startswith("strace"):
                command = [
                    "strace",
                    "-c",
                    "-o",
                    out / f"{phase}-{kind}-{tool}.txt",
                    *command,
                ]
            result = run(command)
            (out / f"{phase}-{kind}-{tool}.jsonl").write_text(result.stdout)
            print(phase, kind, tool, result.stdout.strip(), flush=True)
        finally:
            shutil.rmtree(root)
stop.set()
thread.join()
loads.append(os.getloadavg()[0])
(out / f"{phase}-loads.json").write_text(json.dumps(loads))
assert max(loads) <= 2, "reject and repeat this entire block"
print("LOAD_MAX", max(loads), flush=True)
