#!/usr/bin/env python3
"""Host-restricted driver. Each trial is a fresh bounded user scope."""

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


def files(root, backend, kind):
    if backend == "sqlite":
        return sorted(p for p in root.glob("sqlite.db*") if p.is_file())
    suffixes = ("*.jsonl", "*.sparse.json") if backend == "spike" else ("*.jsonl",)
    return sorted(p for suffix in suffixes for p in (root / kind).glob(suffix))


def residency(paths):
    total = 0
    for path in paths:
        size = path.stat().st_size
        if not size:
            continue
        with path.open("rb") as f:
            ptr = LIBC.mmap(
                None, size, 1, 1, f.fileno(), 0
            )  # PROT_READ, MAP_SHARED; no faults.
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
        with path.open("rb") as f:
            os.fsync(f.fileno())
            os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


def warm(paths):
    for path in paths:
        with path.open("rb") as f:
            while f.read(1024 * 1024):
                pass


def verify_appended_rows(root, kind, backend, before_sizes):
    if backend == "sqlite":
        initial = json.loads((root / "manifest.json").read_text())["rows_per_kind"]
        with closing(
            sqlite3.connect(f"file:{root / 'sqlite.db'}?mode=ro", uri=True)
        ) as connection:
            return connection.execute(f"SELECT count(*) FROM {kind}").fetchone()[
                0
            ] - initial, None
    count = 0
    changed = 0
    for path in (root / kind).glob("*.jsonl"):
        old_size = before_sizes.get(path, 0)
        if path.stat().st_size < old_size:
            raise AssertionError("append truncated a source file")
        if path.stat().st_size == old_size:
            continue
        changed += 1
        with path.open("rb") as stream:
            stream.seek(old_size)
            for line in stream:
                if ":append:" not in json.loads(line)["id"]:
                    raise AssertionError(
                        "appended record did not have a genuinely new ID"
                    )
                count += 1
    return count, changed


def run(
    data,
    out,
    kinds=("samples", "raw"),
    workloads=("point", "hour", "month", "ten", "append", "open", "idle"),
    skip_after_kill=False,
):
    if os.uname().nodename.split(".")[0] != "yari":
        raise RuntimeError("measurements are allowed only on yari")
    base = data / "base"
    records = []
    repeats = int(os.environ.get("STAGE0_REPEATS", "3"))
    selected = os.environ.get("STAGE0_BACKENDS", "sqlite,proseql,spike").split(",")
    # Cells whose earlier trial was SIGKILLed (the 1 GiB scope's OOM kill).
    killed = set()
    for profile in ("timing", "meter"):
        for repeat in range(repeats if profile == "timing" else 1):
            for kind in kinds:
                for workload in workloads:
                    # Rotate backend order across repeats to reduce order bias.
                    order = (
                        selected[repeat % len(selected) :]
                        + selected[: repeat % len(selected)]
                    )
                    for backend in order:
                        for cache in ("cold", "warm"):
                            cell = (kind, workload, backend, cache)
                            name = f"{profile}-{repeat}-{kind}-{workload}-{backend}-{cache}"
                            # Once a cell has been SIGKILLed, do not spend shared-host
                            # CPU repeating the same kill merely to manufacture a median.
                            # The skip is recorded; it is never counted as a trial.
                            if skip_after_kill and cell in killed:
                                with (out / "skipped.jsonl").open("a") as stream:
                                    stream.write(
                                        json.dumps(
                                            {
                                                "profile": profile,
                                                "repeat": repeat,
                                                "kind": kind,
                                                "workload": workload,
                                                "backend": backend,
                                                "cache": cache,
                                                "reason": "earlier trial of this cell was SIGKILLed",
                                            },
                                            sort_keys=True,
                                        )
                                        + "\n"
                                    )
                                print(name, "skipped", flush=True)
                                continue
                            root = base
                            if workload == "append":
                                root = data / "append-trial"
                                if root.exists():
                                    shutil.rmtree(root)
                                # reflinks where supported; otherwise real independent files.
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
                            before_sizes = (
                                {
                                    p: p.stat().st_size
                                    for p in (root / kind).glob("*.jsonl")
                                }
                                if workload == "append" and backend != "sqlite"
                                else {}
                            )
                            owned = [p for p in root.rglob("*") if p.is_file()]
                            evict(owned)
                            relevant = files(root, backend, kind)
                            if cache == "warm":
                                warm(relevant)
                            before = residency(relevant)
                            command = [
                                str(data / profile),
                                str(root),
                                backend,
                                kind,
                                workload,
                                cache,
                            ]
                            scope = [
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
                                "180",
                            ]
                            load_before = os.getloadavg()
                            started = time.monotonic()
                            result = subprocess.run(
                                scope + command,
                                text=True,
                                capture_output=True,
                                check=False,
                            )
                            record = {
                                "profile": profile,
                                "repeat": repeat,
                                "kind": kind,
                                "workload": workload,
                                "backend": backend,
                                "cache": cache,
                                "load_before": load_before,
                                "load_after": os.getloadavg(),
                                "returncode": result.returncode,
                                "process_wall_s": time.monotonic() - started,
                                "file_cache_before": before,
                                "file_cache_after": residency(
                                    files(root, backend, kind)
                                ),
                                "command": scope + command,
                            }
                            if result.returncode == 0:
                                record.update(json.loads(result.stdout))
                            else:
                                record["stdout"] = result.stdout
                            if workload == "append":
                                count, changed = verify_appended_rows(
                                    root, kind, backend, before_sizes
                                )
                                record["rows_persisted"] = count
                                record["jsonl_files_appended"] = changed
                                record["append_verified"] = (
                                    result.returncode == 0
                                    and count == 1000
                                    and record.get("append_new_rows") == 1000
                                )
                            if result.returncode in (-9, 137):
                                killed.add(cell)
                            (out / f"{name}.stderr").write_text(result.stderr)
                            records.append(record)
                            with (out / "trials.jsonl").open("a") as stream:
                                stream.write(json.dumps(record, sort_keys=True) + "\n")
                            print(
                                name,
                                result.returncode,
                                record.get("wall_ms"),
                                flush=True,
                            )
                            if (
                                workload == "append"
                                and result.returncode == 0
                                and not record["append_verified"]
                            ):
                                raise AssertionError(
                                    "successful append did not persist 1,000 genuinely new rows"
                                )
                            evict(owned)
                            if root != base:
                                shutil.rmtree(root)
    # Every successful trial must match canonical results, not merely row counts.
    expected = {}
    for record in records:
        if record["returncode"]:
            continue
        key = (record["kind"], record["workload"])
        value = record["answer"]
        if key in expected and expected[key] != value:
            raise AssertionError(
                f"answer mismatch: {key} {record['backend']} {record['cache']}"
            )
        expected[key] = value
    (out / "equivalence.json").write_text(
        json.dumps(expected_to_json(expected), indent=2) + "\n"
    )


def expected_to_json(expected):
    return {"/".join(key): value for key, value in expected.items()}


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]))
