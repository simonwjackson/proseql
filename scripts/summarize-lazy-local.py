#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p python3
"""Summarize real local allocation peaks. RSS boundaries are not local peaks."""
import json
import sys
from collections import defaultdict
from pathlib import Path

starts = defaultdict(list)
samples = defaultdict(list)
for line in Path(sys.argv[1]).read_text().splitlines():
    if not line.startswith("LM_PHASE "):
        continue
    event = json.loads(line.removeprefix("LM_PHASE "))
    phase = event["phase"]
    if event["begin"]:
        starts[phase].append(event)
    elif starts[phase]:
        begin = starts[phase].pop()
        samples[phase].append({
            "inclusive_wall_us": event["elapsed_us"] - begin["elapsed_us"],
            "local_heap": event.get("local_heap"),
            "rss_before": begin.get("rss"),
            "rss_after": event.get("rss"),
            "cumulative_rss_hwm_before": begin.get("rss_hwm"),
            "cumulative_rss_hwm_after": event.get("rss_hwm"),
        })

def maximum(values):
    return max((value for value in values if value is not None), default=None)

result = []
for phase, spans in samples.items():
    heaps = [span["local_heap"] for span in spans if span["local_heap"] is not None]
    result.append({
        "phase": phase,
        "calls": len(spans),
        "inclusive_wall_us": sum(span["inclusive_wall_us"] for span in spans),
        "allocated_requested_bytes": sum(heap["allocated_requested"] for heap in heaps) if heaps else None,
        "max_local_heap_peak_bytes": maximum(heap["peak_live"] for heap in heaps),
        "max_local_heap_start_bytes": maximum(heap["start_live"] for heap in heaps),
        "max_local_heap_end_bytes": maximum(heap["end_live"] for heap in heaps),
        "max_peak_over_start_bytes": maximum(heap["peak_over_start"] for heap in heaps),
        "max_endpoint_excess_bytes": maximum(heap["peak_over_endpoints"] for heap in heaps),
        "phase_local_rss_peak_bytes": None,
        "max_rss_boundary_bytes": maximum(span[key] for span in spans for key in ["rss_before", "rss_after"]),
        "max_cumulative_rss_hwm_bytes": maximum(span[key] for span in spans for key in ["cumulative_rss_hwm_before", "cumulative_rss_hwm_after"]),
        "samples": spans,
    })
print(json.dumps({
    "source": sys.argv[1],
    "definitions": {
        "heap": "Actual live requested allocation sizes; allocator metadata/padding/internal realloc scratch are not counted",
        "local_peak": "Maximum over every successful alloc/alloc_zeroed/realloc/dealloc in each active span, including nested application work; observer JSON/output is excluded",
        "endpoint_excess": "Per-span peak minus max(start live, end live), then maximum over spans; not an ownership attribution",
        "rss": "Begin/end RSS and cumulative process HWM only. True phase-local RSS peaks remain unmeasured",
        "wall": "Inclusive nested spans; sums across different phase names double-count children",
        "allocated_requested": "Full successful allocation/reallocation destination request sizes; differs from DHAT cumulative allocation definition",
    },
    "phases": result,
}, indent=2))
