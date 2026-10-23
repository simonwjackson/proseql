#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p python3
"""Summarize kernel RSS peaks from a separate self-HWM-reset observer process."""
import json
import sys
from collections import defaultdict
from pathlib import Path

stack = []
samples = defaultdict(list)
pids = set()
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith("LM_RSS_OBSERVER "):
        pids.add(json.loads(line.removeprefix("LM_RSS_OBSERVER "))["pid"])
    if not line.startswith("LM_PHASE "):
        continue
    event = json.loads(line.removeprefix("LM_PHASE "))
    assert event["rss_hwm"] is None, "Reset HWM is not a process acceptance peak"
    if event["begin"]:
        assert event["depth_before"] == len(stack)
        stack.append({"phase": event["phase"], "elapsed_us": event["elapsed_us"], "child_peak": 0})
    elif event["phase_local_rss"] is not None:
        begin = stack.pop()
        assert begin["phase"] == event["phase"]
        sample = event["phase_local_rss"]
        assert sample["peak_rss"] >= max(sample["start_rss"], sample["end_rss"], begin["child_peak"])
        if stack:
            stack[-1]["child_peak"] = max(stack[-1]["child_peak"], sample["peak_rss"])
        samples[event["phase"]].append({
            **sample,
            "inclusive_observer_wall_us": event["elapsed_us"] - begin["elapsed_us"],
        })
    else:
        assert not stack, "Unpaired checkpoints are allowed only outside spans"
    assert event["depth_after"] == len(stack)
assert not stack and len(pids) == 1, "Require one complete RSS-observer process"
print(json.dumps({
    "source": sys.argv[1],
    "observer_process_pid": next(iter(pids)),
    "whole_process_acceptance_peak_rss": None,
    "method": "Sample own VmHWM/RSS, propagate max to all active spans, reset own HWM using clear_refs=5, push/pop nested spans",
    "caveats": [
        "Independent process; never use its reset HWM or GNU time maximum as a default acceptance peak",
        "Approximate/batched kernel accounting; observer I/O, stack, code pages and formatting overhead are included",
        "Inclusive process RSS, not phase ownership; do not add nested peaks or wall times",
    ],
    "phases": [{
        "phase": phase,
        "calls": len(spans),
        "max_phase_local_rss_peak_bytes": max(span["peak_rss"] for span in spans),
        "max_endpoint_excess_bytes": max(span["peak_over_endpoints"] for span in spans),
        "samples": spans,
    } for phase, spans in samples.items()],
}, indent=2))
