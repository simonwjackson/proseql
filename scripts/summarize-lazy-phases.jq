# Inclusive, nested boundaries. high_water_at_end is cumulative, not phase-local.
split("\n") | map(select(startswith("LM_PHASE ")) | ltrimstr("LM_PHASE ") | fromjson)
| reduce .[] as $e ({starts: {}, intervals: []};
    if $e.begin then .starts[$e.phase] = $e
    elif .starts[$e.phase] != null then
      .starts[$e.phase] as $s
      | .intervals += [{phase: $e.phase,
          wall_ms: (($e.elapsed_us - $s.elapsed_us) / 1000),
          live_before: $s.heap.live, live_after: $e.heap.live,
          allocated: (if $e.heap == null then null else $e.heap.allocated - $s.heap.allocated end),
          high_water_at_end: $e.heap.peak, rss_hwm_at_end: $e.rss_hwm}]
      | del(.starts[$e.phase])
    else . end)
| .intervals | group_by(.phase)
| map({phase: .[0].phase, count: length, inclusive_wall_ms: (map(.wall_ms)|add),
    allocated_bytes: (map(.allocated)|add), max_live_before: (map(.live_before)|max),
    max_live_after: (map(.live_after)|max), high_water_at_end: (map(.high_water_at_end)|max),
    rss_hwm_at_end: (map(.rss_hwm_at_end)|max)})
