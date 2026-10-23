# Disjoint call-stack buckets, not exclusive phase costs. Keep unclassified sites.
def bucket:
  (.frames | join("\n")) as $s
  | if $s | test("lazy_memory_bench::(checkpoint|heap|proc_bytes)") then "benchmark_checkpoints"
    elif $s | test("query::pipeline") then "query_workspace_or_results"
    elif $s | test("persistence::decode_entity_map") then "storage_schema_records"
    elif $s | test("validate_loaded_entity") then "engine_validation_temporary"
    elif $s | test("query::ordered_index") then "ordered_index"
    elif $s | test("query::indexes::QueryIndexes") then "query_index_metadata"
    elif $s | test("collection::Collection::(load_resident_records|replace_resident_records|insert_resident_block|validate_resident_block)") then "collection_identity_and_capacity"
    elif $s | test("stored_file::StoredFile") then "compact_append_baselines"
    elif $s | test("proseql_native::read_snapshot") then "source_snapshots_and_text"
    elif $s | test("JsonlCodec|jsonl_decode_lines") then "jsonl_parse_staging"
    elif $s | test("persistence::load_data") then "storage_load_staging"
    elif $s | test("::lazy_ensure") then "native_partition_validation_and_staging"
    else "other_and_harness" end;
{mode, total_bytes, peak_bytes, end_bytes,
  buckets: (.sites | map(. + {bucket: bucket}) | group_by(.bucket)
    | map({bucket: .[0].bucket, allocated: (map(.tb)|add), peak_live: (map(.gb)|add),
        end_live: (map(.eb)|add), allocations: (map(.tbk)|add),
        mean_lifetime_ms: ((map(.tl)|add) / (map(.tbk)|add) / 1000)})
    | sort_by(-.peak_live))}
