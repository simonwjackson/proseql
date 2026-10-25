#!/usr/bin/env python3
"""Supplement: change only sparse-index density; reuse the same measured binary."""

import json
import os
import sys
from pathlib import Path

import measure


def run(data, out):
    base = data / "base"
    stride = 16
    index_bytes = 0
    original_bytes = sum(p.stat().st_size for p in (base / "raw").glob("*.sparse.json"))
    (out / "fixture-layout.json").write_text(
        json.dumps(
            {
                str(p.relative_to(base)): p.stat().st_size
                for p in sorted(base.rglob("*"))
                if p.is_file()
            },
            indent=2,
        )
        + "\n"
    )
    for path in sorted((base / "raw").glob("*.jsonl")):
        stat = path.stat()
        entries = []
        offset = 0
        previous = ""
        ordered = True
        with path.open("rb") as stream:
            for index, line in enumerate(stream):
                row = json.loads(line)
                key = row["atUtc"]
                ordered = ordered and key >= previous
                previous = key
                if index % stride == 0:
                    entries.append([key, offset])
                offset += len(line)
        sidecar = path.with_suffix(".sparse.json")
        sidecar.write_text(
            json.dumps(
                {
                    "len": stat.st_size,
                    "modified": [stat.st_mtime_ns // 10**9, stat.st_mtime_ns % 10**9],
                    "ordered": ordered,
                    "entries": entries,
                },
                separators=(",", ":"),
            )
        )
        index_bytes += sidecar.stat().st_size
    dense = out / "dense"
    dense.mkdir()
    os.environ["STAGE0_BACKENDS"] = "spike"
    os.environ["STAGE0_REPEATS"] = "3"
    measure.run(data, dense, kinds=("raw",), workloads=("hour", "month", "ten", "open"))
    expected = json.loads((out / "equivalence.json").read_text())
    for key, answer in json.loads((dense / "equivalence.json").read_text()).items():
        if answer != expected[key]:
            raise AssertionError(f"dense-index answer mismatch: {key}")
    (dense / "index.json").write_text(
        json.dumps(
            {
                "stride": stride,
                "index_bytes": index_bytes,
                "original_stride": 256,
                "original_index_bytes": original_bytes,
                "correct_against_main_matrix": True,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]))
