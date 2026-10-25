#!/usr/bin/env python3
"""One bounded abort diagnostic: sample RSS and the owning cgroup's OOM counters."""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def counters(path):
    return {
        line.split()[0]: int(line.split()[1]) for line in path.read_text().splitlines()
    }


def main(data, mode):
    if os.uname().nodename.split(".")[0] != "yari":
        raise RuntimeError("yari only")
    cgroup = Path("/sys/fs/cgroup") / next(
        line.split(":", 2)[2].strip().lstrip("/")
        for line in Path("/proc/self/cgroup").read_text().splitlines()
        if line.startswith("0::")
    )
    events_before = counters(cgroup / "memory.events")
    max_before = (cgroup / "memory.max").read_text().strip()
    if (
        max_before != str(1024**3)
        or (cgroup / "memory.swap.max").read_text().strip() != "0"
    ):
        raise RuntimeError("diagnostic must run in the requested 1 GiB/no-swap scope")
    root = data / ("base" if mode == "sqlite-temp" else "diagnostic")
    for path in root.rglob("*"):
        if path.is_file():
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
                os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
    operation = (
        ["sqlite", "samples", "ten"]
        if mode == "sqlite-temp"
        else ["proseql", "raw", "append"]
    )
    with (
        tempfile.TemporaryFile(mode="w+t", dir=data / "tmp") as stdout_file,
        tempfile.TemporaryFile(mode="w+t", dir=data / "tmp") as stderr_file,
    ):
        process = subprocess.Popen(
            [str(data / "timing"), str(root), *operation, "cold"],
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
        )
        rss = 0
        peak_anon = 0
        peak_file = 0
        temp_paths = set()
        started = time.monotonic()
        while process.poll() is None:
            try:
                line = next(
                    line
                    for line in Path(f"/proc/{process.pid}/status")
                    .read_text()
                    .splitlines()
                    if line.startswith("VmRSS:")
                )
                rss = max(rss, int(line.split()[1]) * 1024)
            except (FileNotFoundError, StopIteration):
                pass
            for fd in Path(f"/proc/{process.pid}/fd").glob("*"):
                try:
                    path = os.readlink(fd)
                    if path.startswith(str(data / "tmp")) and "etilqs_" in path:
                        temp_paths.add(path)
                except FileNotFoundError:
                    pass
            values = counters(cgroup / "memory.stat")
            peak_anon = max(peak_anon, values.get("anon", 0))
            peak_file = max(peak_file, values.get("file", 0))
            time.sleep(0.01)
        process.wait()
        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout, stderr = stdout_file.read(), stderr_file.read()
    print(
        json.dumps(
            {
                "mode": mode,
                "temporary_file_paths": sorted(temp_paths),
                "returncode": process.returncode,
                "wall_s": time.monotonic() - started,
                "rss_sampled_peak_lower_bound": rss,
                "cgroup_peak_bytes": int((cgroup / "memory.peak").read_text()),
                "cgroup_anon_sampled_peak": peak_anon,
                "cgroup_file_sampled_peak": peak_file,
                "memory_max": max_before,
                "memory_events_before": events_before,
                "memory_events_after": counters(cgroup / "memory.events"),
                "stdout": stdout,
                "stderr": stderr,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "raw-append")
