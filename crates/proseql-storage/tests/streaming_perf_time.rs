use proseql_storage::{host::StorageHost, index::TimeIndex, memory::MemoryStorageHost};
use serde_json::json;

#[test]
#[ignore = "requires the owned aka acceptance fixture"]
fn measure_checkpoint_density() {
    let root = std::env::var("QWS_PERF_FIXTURE").expect("synthetic aka fixture path");
    let host =
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(3600))
            .unwrap();
    for stride in [1024, 32] {
        let mut bytes = 0;
        let start = std::time::Instant::now();
        for file in std::fs::read_dir(format!("{root}/raw")).unwrap() {
            let path = file.unwrap().path();
            bytes += TimeIndex::build(&host, path.to_str().unwrap(), "atUtc", stride)
                .unwrap()
                .resident_bytes();
        }
        println!(
            "stride={stride} total_resident_bytes={bytes} build_ms={}",
            start.elapsed().as_secs_f64() * 1000.0
        );
    }
}

#[test]
fn checked_append_requires_exact_prefix_and_preserves_orderedness_checks() {
    use proseql_storage::generation::SourceGeneration;
    let host = MemoryStorageHost::default();
    host.write("rows", "{\"at\":1}\n{\"at\":2}\n").unwrap();
    let mut index = TimeIndex::build(&host, "rows", "at", 1).unwrap();
    let before = index.generation().unwrap().clone();
    host.append("rows", "{\"at\":3}\n").unwrap();
    let after = SourceGeneration::observe(&host, "rows").unwrap().unwrap();
    assert!(index
        .extend_checked_append(&host, &before, &after, before.covered_len)
        .unwrap());
    assert_eq!(index.generation(), Some(&after));
    let stale = after.clone();
    host.write("rows", "{\"at\":9}\n{\"at\":2}\n{\"at\":3}\n")
        .unwrap();
    let edited = SourceGeneration::observe(&host, "rows").unwrap().unwrap();
    host.append("rows", "{\"at\":4}\n").unwrap();
    let appended = SourceGeneration::observe(&host, "rows").unwrap().unwrap();
    assert!(!index
        .extend_checked_append(&host, &edited, &appended, edited.covered_len)
        .unwrap());
    assert_eq!(index.generation(), Some(&stale));
    index.refresh(&host).unwrap();
    assert_eq!(index.generation(), Some(&appended));
    assert!(index.seek(None, None).is_none());
}

#[test]
fn field_only_index_keeps_nested_last_key_wins_and_scalar_order() {
    let host = MemoryStorageHost::default();
    host.write(
        "rows",
        concat!(
            "{\"payload\":[{\"x\":[1,2,3]}],\"time\":{\"at\":0},\"time\":{\"at\":1}}\n",
            "{\"time\":{\"at\":2,\"at\":3},\"payload\":{\"at\":-1}}\n",
            "{\"time\":{\"at\":4}}\n"
        ),
    )
    .unwrap();
    let index = TimeIndex::build(&host, "rows", "time.at", 1).unwrap();
    let range = index.seek(Some(&json!(3)), Some(&json!(3))).unwrap();
    assert_eq!(range.start_row, 0);
    assert!(range.end_offset.is_some());
    host.write("rows", "{\"time\":{\"at\":1},\"time\":{\"other\":2}}\n")
        .unwrap();
    assert!(TimeIndex::build(&host, "rows", "time.at", 1)
        .unwrap()
        .seek(None, None)
        .is_none());
}

#[test]
fn skipped_payload_is_still_parsed_and_torn_tail_is_not_indexed() {
    let host = MemoryStorageHost::default();
    host.write("rows", "{\"at\":1,\"payload\":[oops]}\n")
        .unwrap();
    assert!(TimeIndex::build(&host, "rows", "at", 1).is_err());
    host.write("rows", "{\"at\":1}\n{\"at\":").unwrap();
    let mut index = TimeIndex::build(&host, "rows", "at", 1).unwrap();
    assert!(index.seek(Some(&json!(1)), None).is_some());
    host.append("rows", "2}\n").unwrap();
    index.refresh(&host).unwrap();
    assert!(index.seek(Some(&json!(2)), None).is_some());
}
