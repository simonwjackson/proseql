use proseql_engine::scan::RowLocation;
use proseql_storage::generation::{GenerationCheck, SourceGeneration};
use proseql_storage::host::StorageHost;
use proseql_storage::index::{rows::read_line, IdLocator, TimeIndex, UNKNOWN_ORDINAL};
use proseql_storage::memory::MemoryStorageHost;
use serde_json::json;

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
