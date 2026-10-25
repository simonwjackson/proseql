use proseql_engine::errors::{EngineError, OperationError};
use proseql_storage::host::StorageHost;
use proseql_storage::index::IdLocator;
use proseql_storage::memory::MemoryStorageHost;

#[cfg(not(target_arch = "wasm32"))]
fn overflow_duplicate_error(duplicate_at_start: bool) -> (EngineError, Vec<String>) {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let paths = ["a", "b"]
        .map(|name| dir.path().join(name).to_string_lossy().into_owned())
        .to_vec();
    let mut file = std::io::BufWriter::new(std::fs::File::create(&paths[0]).unwrap());
    for ordinal in 0..=(1 << 20) {
        if ordinal == (1 << 20) || (ordinal == 0 && duplicate_at_start) {
            writeln!(file, "{{\"id\":\"duplicate\"}}").unwrap();
        } else {
            writeln!(file, "{{\"id\":\"row-{ordinal}\"}}").unwrap();
        }
    }
    file.flush().unwrap();
    std::fs::write(&paths[1], "{\"id\":\"duplicate\"}\n").unwrap();
    let host =
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(3600))
            .unwrap();
    (IdLocator::build(&host, &paths).unwrap_err(), paths)
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn overflow_duplicate_errors_follow_file_order() {
    let (error, paths) = overflow_duplicate_error(true);
    let EngineError::SourceConfig(error) = error else {
        panic!("wrong error: {error:?}");
    };
    assert_eq!(error.message, "Partition records need unique string IDs");
    assert_eq!(error.path.as_ref(), Some(&paths[0]));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn overflow_cross_file_duplicate_reports_later_path() {
    let (error, paths) = overflow_duplicate_error(false);
    let EngineError::SourceConfig(error) = error else {
        panic!("wrong error: {error:?}");
    };
    assert_eq!(error.message, "Duplicate partition record 'duplicate'");
    assert_eq!(error.path.as_ref(), Some(&paths[1]));
}

fn repeated_checked_publication(rows: usize) {
    use proseql_engine::scan::RowLocation;
    use proseql_storage::generation::SourceGeneration;
    let host = MemoryStorageHost::default();
    let first = "{\"id\":\"a\"}\n";
    host.write("a", first).unwrap();
    let mut locator = IdLocator::build(&host, &["a".into()]).unwrap();
    let mut suffix = String::new();
    let rows = (0..rows)
        .map(|ordinal| {
            let id = format!("b-{ordinal}");
            let offset = (first.len() + suffix.len()) as u64;
            suffix.push_str(&format!("{{\"id\":\"{id}\"}}\n"));
            (
                id,
                RowLocation {
                    partition: 0,
                    offset,
                    ordinal: 0,
                },
            )
        })
        .collect::<Vec<_>>();
    host.append("a", &suffix).unwrap();
    let generation = SourceGeneration::observe(&host, "a").unwrap().unwrap();
    locator
        .accept_appended(generation.clone(), first.len() as u64, &rows)
        .unwrap();
    let bytes = locator.resident_bytes();
    for _ in 0..2 {
        locator
            .accept_appended(generation.clone(), first.len() as u64, &rows)
            .unwrap();
        assert_eq!(locator.resident_bytes(), bytes);
        assert_eq!(locator.generation_for("a"), Some(&generation));
        for (ordinal, (id, row)) in rows.iter().enumerate() {
            let found = locator.locate(id).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].1.offset, row.offset);
            assert_eq!(found[0].1.ordinal, ordinal as u64 + 1);
        }
    }
}

#[test]
fn repeated_checked_publication_before_delta_merge() {
    repeated_checked_publication(1);
}

#[test]
fn repeated_checked_publication_after_delta_merge() {
    repeated_checked_publication(4096);
}

#[test]
fn checked_append_normalizes_speculative_entries_idempotently() {
    use proseql_engine::scan::RowLocation;
    use proseql_storage::generation::SourceGeneration;
    let host = MemoryStorageHost::default();
    let first = "{\"id\":\"a\"}\n";
    host.write("a", first).unwrap();
    let mut locator = IdLocator::build(&host, &["a".into()]).unwrap();
    host.append("a", "{\"id\":\"b\"}\n").unwrap();
    let rows = vec![(
        "b".into(),
        RowLocation {
            partition: 0,
            offset: first.len() as u64,
            ordinal: 0,
        },
    )];
    locator.record_appended("a", &rows).unwrap();
    locator.record_appended("a", &rows).unwrap();
    let generation = SourceGeneration::observe(&host, "a").unwrap().unwrap();
    locator
        .accept_appended(generation, first.len() as u64, &rows)
        .unwrap();
    locator.record_appended("a", &rows).unwrap();
    let found = locator.locate("b").unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].1.ordinal, 1);
}

#[cfg(unix)]
#[test]
fn fs_tokens_change_on_in_place_edits_appends_and_truncations() {
    use proseql_storage::fs::FsStorageHost;
    use std::io::{Seek, SeekFrom, Write};
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join("generation.jsonl")
        .to_string_lossy()
        .into_owned();
    let host = FsStorageHost::new_polling(std::time::Duration::from_secs(3600)).unwrap();
    host.write(&path, "{\"id\":\"old\"}\n").unwrap();
    let before = host.stat(&path).unwrap().unwrap();
    let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.seek(SeekFrom::Start(7)).unwrap();
    file.write_all(b"new").unwrap();
    file.sync_data().unwrap();
    let edited = host.stat(&path).unwrap().unwrap();
    assert_eq!(before.len, edited.len);
    assert_ne!(before.change_id, edited.change_id);
    assert!(edited.change_id.is_some());
    host.append(&path, "{\"id\":\"appended\"}\n").unwrap();
    let appended = host.stat(&path).unwrap().unwrap();
    assert_ne!(edited.change_id, appended.change_id);
    file.set_len(edited.len).unwrap();
    file.sync_data().unwrap();
    assert_ne!(
        appended.change_id,
        host.stat(&path).unwrap().unwrap().change_id
    );
}

#[test]
fn visitor_covers_only_scanned_rows_and_failed_refresh_cannot_publish_coverage() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}\n").unwrap();
    let paths = vec!["a".into()];
    let mut seen = Vec::new();
    let mut locator =
        IdLocator::build_visiting(&host, &paths, &mut |path, bytes, loc, final_line| {
            seen.push((path.to_owned(), bytes.to_vec(), loc.offset, final_line));
            Ok(())
        })
        .unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].2, 0);
    assert!(!seen[0].3);
    locator
        .refresh_visiting(&host, &paths, &mut |_, _, _, _| {
            panic!("unchanged row visited")
        })
        .unwrap();
    host.append("a", "{\"id\":\"b\"}").unwrap();
    let error = locator
        .refresh_visiting(&host, &paths, &mut |_, _, _, final_line| {
            assert!(final_line);
            Err(EngineError::Operation(OperationError {
                operation: "test".into(),
                reason: "visitor".into(),
                message: "stop".into(),
            }))
        })
        .unwrap_err();
    assert!(error.to_string().contains("stop"));
    assert!(locator.locate("b").is_err());
    let mut revisited = 0;
    locator
        .refresh_visiting(&host, &paths, &mut |_, _, _, _| {
            revisited += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(revisited, 2);
    assert_eq!(locator.locate("b").unwrap().len(), 1);
}
