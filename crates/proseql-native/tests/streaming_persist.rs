mod support;
use proseql_native::NativeRuntime;
use proseql_storage::host::StorageHost;
use serde_json::json;
use std::fs;
use std::io::Write;
use support::parity::{ParityFixture, RuntimeKind, COLLECTION, SOURCE};

fn range() -> proseql_engine::query::QueryInput {
    proseql_engine::query::QueryInput {
        r#where: Some(
            json!({"atUtc":{"$gte":"2025-02-03T00:00:00.000Z", "$lt":"2025-02-03T01:00:00.000Z"}}),
        ),
        ..Default::default()
    }
}

fn prime(fixture: &ParityFixture) -> std::path::PathBuf {
    let runtime = fixture.open(RuntimeKind::Lazy);
    runtime.find_by_id(COLLECTION, "absent").unwrap();
    runtime.query_bounded(COLLECTION, range()).unwrap();
    runtime.close().unwrap();
    fixture
        .partition_path("2025-02")
        .parent()
        .unwrap()
        .join(".proseql-index")
}

#[test]
fn answers_and_partition_sets_survive_disposable_cache_damage() {
    for damage in [
        "present",
        "missing",
        "truncated",
        "bitflip",
        "version",
        "index-version",
        "temp",
    ] {
        let fixture = ParityFixture::new(60);
        let dir = prime(&fixture);
        assert!(dir.is_dir());
        let files = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        assert!(!files.is_empty());
        for path in files {
            let mut bytes = fs::read(&path).unwrap();
            match damage {
                "missing" => {
                    fs::remove_file(&path).unwrap();
                    continue;
                }
                "truncated" => bytes.truncate(17),
                "bitflip" => {
                    let last = bytes.len() / 2;
                    bytes[last] ^= 1;
                }
                "version" | "index-version" => {
                    bytes[if damage == "version" { 8 } else { 16 }] = 0;
                    let end = bytes.len() - 8;
                    let hash = proseql_storage::index::persist::checksum(&bytes[..end]);
                    bytes[end..].copy_from_slice(&hash.to_le_bytes());
                }
                "temp" => {
                    fs::write(path.with_extension("idx.crash.tmp"), &bytes[..17]).unwrap();
                    continue;
                }
                _ => continue,
            }
            fs::write(path, bytes).unwrap();
        }
        let runtime = fixture.open(RuntimeKind::Lazy);
        let eager = fixture.open(RuntimeKind::Eager);
        for id in ["steps:2025-02-03T04:00:00.000Z", "absent"] {
            assert_eq!(
                runtime.find_by_id(COLLECTION, id),
                eager.find_by_id(COLLECTION, id),
                "{damage}"
            );
        }
        assert_eq!(
            runtime.query_bounded(COLLECTION, range()),
            eager.query_bounded(COLLECTION, range()),
            "{damage}"
        );
        let status = runtime.lazy_partition_status(SOURCE).unwrap().unwrap();
        assert!(status.loaded.is_empty());
        assert_eq!(status.partitions.len(), 3);
        // Deletion between operations never removes authoritative records.
        if dir.exists() {
            fs::remove_dir_all(&dir).unwrap();
        }
        assert_eq!(runtime.find_by_id(COLLECTION, "absent").unwrap(), None);
        runtime.close().unwrap();
        eager.close().unwrap();
    }
}

#[test]
fn external_edits_appends_replacements_and_stale_duplicates_use_current_text() {
    for edit in ["same-length", "append", "replace"] {
        let fixture = ParityFixture::new(60);
        prime(&fixture);
        let path = fixture.partition_path("2025-02");
        let original = fs::read_to_string(&path).unwrap();
        let changed = original.replacen("steps:", "other:", 1);
        match edit {
            "same-length" => fs::write(&path, changed).unwrap(),
            "replace" => {
                let replacement = path.with_extension("swap");
                fs::write(&replacement, changed).unwrap();
                fs::rename(replacement, &path).unwrap();
            }
            _ => {
                let mut row = support::parity::sample("2025-02", 1, 1, "steps");
                row["id"] = json!("external");
                writeln!(
                    fs::OpenOptions::new().append(true).open(&path).unwrap(),
                    "{row}"
                )
                .unwrap();
            }
        }
        let runtime = fixture.open(RuntimeKind::Lazy);
        let eager = fixture.open(RuntimeKind::Eager);
        for id in ["other:2025-02-01T00:00:00.000Z", "external", "absent"] {
            assert_eq!(
                runtime.find_by_id(COLLECTION, id),
                eager.find_by_id(COLLECTION, id)
            );
        }
        if edit == "append" {
            let mut duplicate = support::parity::sample("2025-03", 1, 1, "steps");
            duplicate["id"] = json!("external");
            assert!(runtime.mutate(|m| m.create(COLLECTION, duplicate)).is_err());
        }
        runtime.close().unwrap();
        eager.close().unwrap();
    }
}

#[test]
fn schema_changes_never_reuse_validation_records() {
    let fixture = ParityFixture::new(60);
    prime(&fixture);
    let mut config = fixture.config();
    // A new required field must reject old text despite its cached proof.
    if let proseql_engine::descriptor::SchemaNode::Struct { fields } =
        &mut config.collections[0].descriptor.schema
    {
        fields.push(proseql_engine::descriptor::StructField {
            name: "newRequired".into(),
            schema: proseql_engine::descriptor::SchemaNode::Str,
        });
    }
    let runtime =
        NativeRuntime::open_sources_with_options(config, fixture.options(RuntimeKind::Lazy))
            .unwrap();
    assert!(runtime.find_by_id(COLLECTION, "absent").is_err());
    runtime.close().unwrap();
}

#[test]
fn filesystem_listing_excludes_sidecars_and_watcher_does_not_report_them() {
    use proseql_storage::fs::FsStorageHost;
    use std::time::Duration;
    let fixture = ParityFixture::new(60);
    let root = fixture
        .partition_path("2025-02")
        .parent()
        .unwrap()
        .to_owned();
    let host = FsStorageHost::new_polling(Duration::from_millis(20)).unwrap();
    let before = host
        .list_directory_with_stat(root.to_str().unwrap())
        .unwrap()
        .into_iter()
        .map(|(path, _)| path)
        .collect::<Vec<_>>();
    let (send, receive) = std::sync::mpsc::channel();
    let watch = host
        .watch_dir(
            root.to_str().unwrap(),
            Box::new(move |event| {
                send.send(event).unwrap();
            }),
        )
        .unwrap();
    prime(&fixture);
    std::thread::sleep(Duration::from_millis(150));
    assert!(receive.try_recv().is_err());
    assert_eq!(
        before,
        host.list_directory_with_stat(root.to_str().unwrap())
            .unwrap()
            .into_iter()
            .map(|(path, _)| path)
            .collect::<Vec<_>>()
    );
    assert!(host
        .list_recursive(root.to_str().unwrap())
        .unwrap()
        .iter()
        .all(|path| !path.contains(".proseql-index")));
    watch.stop().unwrap();
}
