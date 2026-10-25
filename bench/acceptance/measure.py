#!/usr/bin/env python3
"""aka-only matrix; fresh bounded scope per trial, owned-file cache probes."""

import ctypes
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.mmap.restype = ctypes.c_void_p
LIBC.mmap.argtypes = [
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_long,
]
LIBC.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
LIBC.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
PAGE = os.sysconf("SC_PAGE_SIZE")
BACKENDS = ("sqlite", "streaming")
READS = ("point", "hour", "month", "ten")
WORKLOADS = (*READS, "append", "append-range", "open", "idle")
CACHES = ("cold", "warm")


def files(root, backend, kind):
    if backend == "sqlite":
        return sorted(p for p in root.glob("sqlite.db*") if p.is_file())
    # Include disposable sidecars if the engine adds them later.
    return sorted(p for p in (root / kind).rglob("*") if p.is_file())


def residency(paths):
    total = 0
    for path in paths:
        size = path.stat().st_size
        if not size:
            continue
        with path.open("rb") as stream:
            ptr = LIBC.mmap(None, size, 1, 1, stream.fileno(), 0)
            if ptr == ctypes.c_void_p(-1).value:
                raise OSError(ctypes.get_errno(), "mmap")
            try:
                vector = (ctypes.c_ubyte * ((size + PAGE - 1) // PAGE))()
                if LIBC.mincore(ptr, size, vector):
                    raise OSError(ctypes.get_errno(), "mincore")
                total += sum(bool(v & 1) for v in vector) * PAGE
            finally:
                LIBC.munmap(ptr, size)
    return total


def evict(paths):
    for path in paths:
        with path.open("rb") as stream:
            os.fsync(stream.fileno())
            os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


def warm(paths):
    for path in paths:
        with path.open("rb") as stream:
            while stream.read(1024 * 1024):
                pass


def verify_append(root, kind, backend, before_sizes):
    if backend == "sqlite":
        initial = json.loads((root / "manifest.json").read_text())["rows_per_kind"]
        with closing(
            sqlite3.connect(f"file:{root / 'sqlite.db'}?mode=ro", uri=True)
        ) as conn:
            return conn.execute(f"SELECT count(*) FROM {kind}").fetchone()[0] - initial
    count = 0
    for path in (root / kind).glob("*.jsonl"):
        old_size = before_sizes.get(path, 0)
        if path.stat().st_size < old_size:
            raise AssertionError("append truncated source")
        with path.open("rb") as stream:
            stream.seek(old_size)
            for line in stream:
                if ":append:" not in json.loads(line)["id"]:
                    raise AssertionError("append did not use new IDs")
                count += 1
    return count


def scope(limit):
    return [
        "systemd-run",
        "--user",
        "--scope",
        "-p",
        "MemoryMax=1G",
        "-p",
        "MemorySwapMax=0",
        "nice",
        "-n",
        "10",
        "timeout",
        str(limit),
    ]


def run(data, out):
    if os.uname().nodename.split(".")[0] != "aka":
        raise RuntimeError("measurements are allowed only on aka")
    if (out / "trials.jsonl").exists():
        raise FileExistsError("never mix trials; select a fresh results directory")
    repeats = int(os.environ.get("ACCEPTANCE_REPEATS", "3"))
    if repeats < 1:
        raise ValueError("ACCEPTANCE_REPEATS must be positive")
    expected = {}
    killed = set()
    skipped = 0
    # Timing has no counting allocator. Meter is a separate process/binary.
    for profile in ("timing", "meter"):
        for repeat in range(repeats if profile == "timing" else 1):
            for shape in ("samples", "raw", "raw16"):
                kind = "raw" if shape == "raw16" else shape
                base = data / ("base16" if shape == "raw16" else "base")
                workloads = ("ten",) if shape == "raw16" else WORKLOADS
                for wi, workload in enumerate(workloads):
                    rotation = (repeat + wi + (profile == "meter")) % len(BACKENDS)
                    order = BACKENDS[rotation:] + BACKENDS[:rotation]
                    for backend in order:
                        for cache in CACHES:
                            cell = (shape, workload, backend, cache)
                            if cell in killed:
                                skipped += 1
                                continue
                            root = base
                            if workload in ("append", "append-range"):
                                root = data / "append-trial"
                                if root.exists():
                                    shutil.rmtree(root)
                                subprocess.run(
                                    [
                                        "cp",
                                        "-a",
                                        "--reflink=auto",
                                        str(base),
                                        str(root),
                                    ],
                                    check=True,
                                )
                            before_sizes = {
                                p: p.stat().st_size
                                for p in (root / kind).glob("*.jsonl")
                            }
                            owned = sorted(p for p in root.rglob("*") if p.is_file())
                            evict(owned)
                            relevant = files(root, backend, kind)
                            if cache == "warm":
                                warm(relevant)
                            before = residency(relevant)
                            command = scope(
                                int(os.environ.get("ACCEPTANCE_TIMEOUT", "180"))
                            ) + [
                                str(data / profile),
                                str(root),
                                backend,
                                kind,
                                workload,
                                cache,
                            ]
                            load_before = os.getloadavg()
                            started = time.monotonic()
                            result = subprocess.run(
                                command, text=True, capture_output=True, check=False
                            )
                            name = f"{profile}-{repeat}-{shape}-{workload}-{backend}-{cache}"
                            record = {
                                "profile": profile,
                                "repeat": repeat,
                                "shape": shape,
                                "kind": kind,
                                "workload": workload,
                                "backend": backend,
                                "cache": cache,
                                "returncode": result.returncode,
                                "process_wall_s": time.monotonic() - started,
                                "file_cache_before": before,
                                "file_cache_after": residency(
                                    files(root, backend, kind)
                                ),
                                "command": command,
                                "load_before": load_before,
                                "load_after": os.getloadavg(),
                            }
                            if result.returncode == 0:
                                record.update(json.loads(result.stdout))
                                key = (shape, workload)
                                answer = record["answer"]
                                if key in expected and expected[key] != answer:
                                    raise AssertionError(f"answer mismatch: {name}")
                                expected[key] = answer
                            else:
                                record["stdout"] = result.stdout
                            if workload in ("append", "append-range"):
                                record["rows_persisted"] = verify_append(
                                    root, kind, backend, before_sizes
                                )
                                if (
                                    result.returncode == 0
                                    and record["rows_persisted"] != 1000
                                ):
                                    raise AssertionError(
                                        f"successful append did not persist 1000 new rows: {name}"
                                    )
                            if result.returncode in (-9, 137):
                                killed.add(cell)
                            (out / f"{name}.stderr").write_text(result.stderr)
                            with (out / "trials.jsonl").open("a") as stream:
                                stream.write(json.dumps(record, sort_keys=True) + "\n")
                            print(
                                name,
                                result.returncode,
                                record.get("wall_ms"),
                                flush=True,
                            )
                            evict(owned)
                            if root != base:
                                shutil.rmtree(root)
    (out / "run.json").write_text(
        json.dumps(
            {
                "repeats": repeats,
                "skipped_after_kill": skipped,
                "expected_trials": (repeats + 1)
                * (2 * len(WORKLOADS) + 1)
                * len(BACKENDS)
                * len(CACHES),
            },
            indent=2,
        )
        + "\n"
    )
    (out / "equivalence.json").write_text(
        json.dumps({"/".join(k): v for k, v in expected.items()}, indent=2) + "\n"
    )


def guarded_run(data, out):
    """Reject and repeat a complete matrix block if one-minute load exceeds 2."""
    blocks = []
    for attempt in range(1, 4):
        cooldown = []
        while os.getloadavg()[0] > 1:
            cooldown.append({"time": time.time(), "load": os.getloadavg()})
            time.sleep(5)
        block = out / f"block-{attempt}"
        block.mkdir()
        samples = [{"time": time.time(), "load": os.getloadavg()}]
        child = subprocess.Popen(
            [sys.executable, __file__, str(data), str(block), "--block"]
        )
        while child.poll() is None:
            time.sleep(5)
            samples.append({"time": time.time(), "load": os.getloadavg()})
        accepted = child.returncode == 0 and max(s["load"][0] for s in samples) <= 2
        blocks.append(
            {
                "attempt": attempt,
                "accepted": accepted,
                "returncode": child.returncode,
                "cooldown": cooldown,
                "samples": samples,
            }
        )
        (out / "load.json").write_text(json.dumps(blocks, indent=2) + "\n")
        if child.returncode:
            raise RuntimeError(f"matrix failed: {child.returncode}; see {block}")
        if accepted:
            for name in ("trials.jsonl", "run.json", "equivalence.json"):
                shutil.copyfile(block / name, out / name)
            return
        print(f"high load: reject whole block {attempt}", flush=True)
    raise RuntimeError("three high-load blocks rejected; no accepted measurement")


if __name__ == "__main__":
    action = run if "--block" in sys.argv else guarded_run
    action(Path(sys.argv[1]), Path(sys.argv[2]))
