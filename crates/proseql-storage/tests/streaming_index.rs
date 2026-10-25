use proseql_engine::scan::RowLocation;
use proseql_storage::generation::{GenerationCheck, SourceGeneration};
use proseql_storage::host::StorageHost;
use proseql_storage::index::{rows::read_line, IdLocator, TimeIndex, UNKNOWN_ORDINAL};
use proseql_storage::memory::MemoryStorageHost;
use serde_json::json;

#[cfg(unix)]
#[path = "streaming_index/measure.rs"]
mod measure;

#[test]
fn generations_detect_same_length_edits_prefix_changes_growth_and_removal() {
    let host = MemoryStorageHost::default();
    host.write("a", "abcd\n").unwrap();
    let generation = SourceGeneration::observe(&host, "a").unwrap().unwrap();
    assert_eq!(generation.check(&host).unwrap(), GenerationCheck::Unchanged);
    host.write("a", "abce\n").unwrap();
    assert_eq!(generation.check(&host).unwrap(), GenerationCheck::Replaced);
    host.write("a", "abcd\nnew\n").unwrap();
    assert_eq!(
        generation.check(&host).unwrap(),
        GenerationCheck::Appended { from_offset: 5 }
    );
    host.write("a", "abce\nnew\n").unwrap();
    assert_eq!(generation.check(&host).unwrap(), GenerationCheck::Replaced);
    host.remove("a").unwrap();
    assert_eq!(generation.check(&host).unwrap(), GenerationCheck::Missing);
}

#[test]
fn sparse_seeks_include_ties_and_disable_on_unsorted_or_mixed_keys() {
    let host = MemoryStorageHost::default();
    let mut text = String::new();
    for key in [1, 2, 2, 2, 2, 3, 4] {
        text.push_str(&format!("{{\"at\":{key}}}\n"));
    }
    host.write("a", &text).unwrap();
    let mut index = TimeIndex::build(&host, "a", "at", 2).unwrap();
    let range = index.seek(Some(&json!(2)), Some(&json!(2))).unwrap();
    assert_eq!(range.start_offset, 0);
    assert_eq!(range.start_row, 0);
    assert!(range.end_offset.is_some());
    host.append("a", "{\"at\":5}\n").unwrap();
    index.refresh(&host).unwrap();
    assert!(index.seek(Some(&json!(5)), None).is_some());
    host.append("a", "{\"at\":0}\n").unwrap();
    index.refresh(&host).unwrap();
    assert!(index.seek(None, None).is_none());
    host.write("a", "{\"at\":1}\n{\"at\":\"2\"}\n").unwrap();
    index.refresh(&host).unwrap();
    assert!(index.seek(None, None).is_none());
    host.remove("a").unwrap();
    index.refresh(&host).unwrap();
    assert!(index.seek(None, None).is_none());
}

#[test]
fn locator_rebuilds_edits_and_deletions_and_extends_external_appends() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\",\"payload\":[1,2,3]}\n")
        .unwrap();
    host.write("b", "{\"id\":\"b\"}\n").unwrap();
    let paths = vec!["a".into(), "b".into()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    assert!(locator.locate("missing").unwrap().is_empty());
    let (path, location) = locator.locate("b").unwrap().remove(0);
    assert_eq!(
        read_line(&host, &path, location.offset).unwrap(),
        b"{\"id\":\"b\"}"
    );
    host.write("b", "{\"id\":\"c\"}\n").unwrap();
    locator.refresh(&host, &paths).unwrap();
    assert!(locator.locate("b").unwrap().is_empty());
    assert_eq!(locator.locate("c").unwrap().len(), 1);
    host.append("b", "{\"id\":\"d\"}\n").unwrap();
    locator.refresh(&host, &paths).unwrap();
    assert_eq!(locator.locate("d").unwrap().len(), 1);
    host.remove("a").unwrap();
    locator.refresh(&host, &paths).unwrap();
    assert!(locator.locate("a").unwrap().is_empty());
}

#[test]
fn append_recording_is_idempotent_and_never_hides_an_external_append() {
    let host = MemoryStorageHost::default();
    let first = "{\"id\":\"a\"}\n";
    host.write("a", first).unwrap();
    let paths = vec!["a".into()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    let rows = vec![(
        "b".into(),
        RowLocation {
            partition: 0,
            offset: first.len() as u64,
            ordinal: 0,
        },
    )];
    host.append("a", "{\"id\":\"b\"}\n").unwrap();
    locator.record_appended("a", &rows).unwrap();
    locator.record_appended("a", &rows).unwrap();
    assert_eq!(locator.locate("b").unwrap().len(), 1);
    assert_eq!(locator.locate("b").unwrap()[0].1.ordinal, UNKNOWN_ORDINAL);
    host.append("a", "{\"id\":\"external\"}\n").unwrap();
    locator.refresh(&host, &paths).unwrap();
    locator.record_appended("a", &rows).unwrap();
    assert_eq!(locator.locate("b").unwrap().len(), 1);
    assert_eq!(locator.locate("external").unwrap().len(), 1);
    assert_eq!(locator.locate("b").unwrap()[0].1.ordinal, 1);
    assert_eq!(locator.locate("external").unwrap()[0].1.ordinal, 2);
}

#[test]
fn duplicate_ids_are_verified_across_files_and_within_a_file() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"same\"}\n").unwrap();
    host.write("b", "{\"id\":\"same\"}\n").unwrap();
    let error = IdLocator::build(&host, &["a".into(), "b".into()]).unwrap_err();
    assert!(error.to_string().contains("Duplicate partition record"));
    host.append("a", "{\"id\":\"same\"}\n").unwrap();
    assert!(IdLocator::build(&host, &["a".into()])
        .unwrap_err()
        .to_string()
        .contains("unique string IDs"));
}

#[test]
fn valid_unterminated_and_torn_tails_are_rebuilt_on_growth() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}").unwrap();
    let paths = vec!["a".into()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    host.append("a", "\n{\"id\":\"b").unwrap();
    locator.refresh(&host, &paths).unwrap();
    assert_eq!(locator.locate("a").unwrap().len(), 1);
    assert!(locator.locate("b").unwrap().is_empty());
    host.append("a", "\"}\n").unwrap();
    locator.refresh(&host, &paths).unwrap();
    assert_eq!(locator.locate("b").unwrap().len(), 1);
}

#[test]
fn placeholder_partition_and_ordinal_are_not_used_for_recorded_candidates() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}\n").unwrap();
    host.write("b", "{\"id\":\"b\"}\n").unwrap();
    let paths = vec!["a".into(), "b".into()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    let offset = host.read("b").unwrap().len() as u64;
    host.append("b", "{\"id\":\"new\"}\n").unwrap();
    locator
        .record_appended(
            "b",
            &[(
                "new".into(),
                RowLocation {
                    partition: 0,
                    offset,
                    ordinal: 0,
                },
            )],
        )
        .unwrap();
    let candidate = locator.locate("new").unwrap()[0].1;
    assert_eq!(candidate.partition, 1);
    assert_eq!(candidate.ordinal, UNKNOWN_ORDINAL);
    locator.refresh(&host, &paths).unwrap();
    assert_eq!(locator.locate("new").unwrap()[0].1.ordinal, 2);
}

#[test]
fn repeated_json_object_keys_follow_last_key_wins_semantics() {
    let host = MemoryStorageHost::default();
    host.write(
        "a",
        "{\"id\":\"first\",\"id\":\"last\",\"payload\":{\"huge\":[1,2,3]}}\n",
    )
    .unwrap();
    let locator = IdLocator::build(&host, &["a".into()]).unwrap();
    assert!(locator.locate("first").unwrap().is_empty());
    assert_eq!(locator.locate("last").unwrap().len(), 1);
}

#[test]
fn duplicate_edit_cannot_become_a_success_after_a_failed_refresh() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}\n").unwrap();
    host.write("b", "{\"id\":\"b\"}\n").unwrap();
    let paths = vec!["a".into(), "b".into()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    host.write("b", "{\"id\":\"a\"}\n").unwrap();
    assert!(locator.refresh(&host, &paths).is_err());
    assert!(locator.refresh(&host, &paths).is_err());
    host.write("b", "{\"id\":\"b\"}\n").unwrap();
    locator.refresh(&host, &paths).unwrap();
    assert_eq!(locator.locate("b").unwrap().len(), 1);
}

#[test]
fn appended_offsets_are_idempotent_even_if_the_caller_repeats_a_different_id() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}\n").unwrap();
    let mut locator = IdLocator::build(&host, &["a".into()]).unwrap();
    let position = RowLocation {
        partition: 0,
        offset: 0,
        ordinal: 0,
    };
    locator
        .record_appended("a", &[("different".into(), position)])
        .unwrap();
    assert!(locator.locate("different").unwrap().is_empty());
    let next = RowLocation {
        offset: 11,
        ..position
    };
    locator
        .record_appended("a", &[("new".into(), next)])
        .unwrap();
    locator
        .record_appended("a", &[("other".into(), next)])
        .unwrap();
    assert_eq!(locator.locate("new").unwrap().len(), 1);
    assert!(locator.locate("other").unwrap().is_empty());
}

#[test]
fn sparse_windows_cover_every_matching_row_for_ranges_and_ties() {
    let host = MemoryStorageHost::default();
    let mut offsets = Vec::new();
    let mut text = String::new();
    for row in 0..4096 {
        offsets.push(text.len() as u64);
        text.push_str(&format!("{{\"at\":{}}}\n", row / 17));
    }
    host.write("a", &text).unwrap();
    let mut index = TimeIndex::build(&host, "a", "at", 128).unwrap();
    for lower in [-1, 0, 1, 7, 99, 241, 500] {
        for upper in [-1, 0, 1, 7, 99, 241, 500] {
            let window = index
                .seek(Some(&json!(lower)), Some(&json!(upper)))
                .unwrap();
            assert!(window
                .end_offset
                .is_none_or(|end| end >= window.start_offset));
            for (row, offset) in offsets.iter().enumerate() {
                let key = (row / 17) as i32;
                if key >= lower && key <= upper {
                    assert!(*offset >= window.start_offset);
                    assert!(window.end_offset.is_none_or(|end| *offset < end));
                }
            }
        }
    }
    host.remove("a").unwrap();
    index.refresh(&host).unwrap();
    assert!(index.seek(None, None).is_none());
    host.write("a", "{\"at\":1}\n").unwrap();
    index.refresh(&host).unwrap();
    assert!(index.seek(None, None).is_some());
}

#[test]
fn partition_locator_redecodes_changed_partitions_and_detects_duplicates() {
    use proseql_storage::index::UNKNOWN_OFFSET;
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}\n").unwrap();
    host.write("b", "{\"id\":\"b\"}\n").unwrap();
    let mut decoded_paths = Vec::new();
    let mut decode = |path: &str| {
        decoded_paths.push(path.to_owned());
        let text = host.read(path)?;
        let rows = proseql_formats::FormatRegistry::with_builtins()
            .deserialize(&text, "jsonl")
            .unwrap();
        Ok(rows
            .as_array()
            .unwrap()
            .iter()
            .map(|row| format!("decoded:{}", row["id"].as_str().unwrap()))
            .collect::<Vec<_>>())
    };
    let paths = vec!["a".into(), "b".into()];
    let mut locator = IdLocator::build_partitions(&host, &paths, &mut decode).unwrap();
    assert!(locator.locate("a").unwrap().is_empty());
    assert_eq!(
        locator.locate("decoded:a").unwrap()[0].1.offset,
        UNKNOWN_OFFSET
    );
    host.append("b", "{\"id\":\"c\"}\n").unwrap();
    locator
        .record_appended(
            "b",
            &[(
                "c".into(),
                RowLocation {
                    partition: 0,
                    offset: 11,
                    ordinal: 0,
                },
            )],
        )
        .unwrap();
    locator
        .refresh_partitions(&host, &paths, &mut decode)
        .unwrap();
    assert_eq!(
        locator.locate("decoded:c").unwrap()[0].1.offset,
        UNKNOWN_OFFSET
    );
    host.write("b", "{\"id\":\"a\"}\n").unwrap();
    assert!(locator
        .refresh_partitions(&host, &paths, &mut decode)
        .unwrap_err()
        .to_string()
        .contains("Duplicate partition record 'decoded:a'"));
    assert!(locator
        .refresh_partitions(&host, &paths, &mut decode)
        .is_err());
    host.remove("b").unwrap();
    locator
        .refresh_partitions(&host, &paths, &mut decode)
        .unwrap();
    assert!(locator.locate("decoded:b").unwrap().is_empty());
    assert_eq!(locator.locate("decoded:a").unwrap().len(), 1);
    // Initial build opens a,b; an ordinary append refresh opens only b.
    assert_eq!(&decoded_paths[..3], &["a", "b", "b"]);
}

#[test]
fn append_delta_finds_rows_and_merges_without_doubling_the_base() {
    let host = MemoryStorageHost::default();
    let text = (0..8192)
        .map(|row| format!("{{\"id\":\"base-{row}\"}}\n"))
        .collect::<String>();
    host.write("a", &text).unwrap();
    let paths = vec!["a".into()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    let baseline = locator.resident_bytes();
    let mut offset = text.len() as u64;
    let mut suffix = String::new();
    let rows = (0..4250)
        .map(|row| {
            let id = format!("new-{row}");
            let position = RowLocation {
                partition: 0,
                offset,
                ordinal: 0,
            };
            let line = format!("{{\"id\":\"{id}\"}}\n");
            offset += line.len() as u64;
            suffix.push_str(&line);
            (id, position)
        })
        .collect::<Vec<_>>();
    host.append("a", &suffix).unwrap();
    locator.record_appended("a", &rows[..20]).unwrap();
    locator.record_appended("a", &rows[..20]).unwrap();
    assert_eq!(locator.locate("new-19").unwrap().len(), 1);
    assert!(locator.resident_bytes() < baseline + 4096 * 32 + 20 * 64);
    locator.record_appended("a", &rows).unwrap();
    let merged_bytes = locator.resident_bytes();
    locator.record_appended("a", &rows).unwrap();
    assert_eq!(locator.resident_bytes(), merged_bytes);
    for id in [
        "base-0",
        "base-8191",
        "new-0",
        "new-4095",
        "new-4096",
        "new-4249",
    ] {
        assert_eq!(locator.locate(id).unwrap().len(), 1, "{id}");
    }
    assert!(merged_bytes < baseline + 4250 * 80 + 4096 * 24);
    locator.refresh(&host, &paths).unwrap();
    assert_eq!(
        locator.locate("new-4249").unwrap()[0].1.ordinal,
        8192 + 4249
    );
    locator.record_appended("a", &rows).unwrap();
    assert_eq!(locator.locate("new-0").unwrap().len(), 1);
}
