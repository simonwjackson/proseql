use proseql_engine::scan::RowLocation;
use proseql_storage::{
    fs::FsStorageHost,
    generation::SourceGeneration,
    host::StorageHost,
    index::{persist::Store, IdLocator},
};
use std::{collections::BTreeMap, time::Duration};

#[test]
fn saved_file_tables_match_text_through_refresh_append_and_republication() {
    let dir = tempfile::tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_secs(60)).unwrap();
    let root = dir.path().to_str().unwrap();
    let store = Store::new(root.into(), 42);
    let paths = (0..33)
        .map(|file| format!("{root}/{file:02}.jsonl"))
        .collect::<Vec<_>>();
    for (file, path) in paths.iter().enumerate() {
        let text = (0..17)
            .map(|row| format!("{{\"id\":\"{file}-{row}\"}}\n"))
            .collect::<String>();
        host.write(path, &text).unwrap();
    }
    let rebuilt = IdLocator::build(&host, &paths).unwrap();
    rebuilt.save(&host, &store);
    let mut visits = 0;
    // A membership-only restore must not read rows. Validation is separately
    // required by the native validating caller and its checked valid sidecars.
    let mut restored =
        IdLocator::build_persisted(&host, &paths, &BTreeMap::new(), None, &store).unwrap();
    for file in 0..33 {
        for row in 0..17 {
            let id = format!("{file}-{row}");
            assert_eq!(restored.locate(&id).unwrap(), rebuilt.locate(&id).unwrap());
        }
    }
    assert!(restored.locate("missing").unwrap().is_empty());
    let path = &paths[16];
    let before = SourceGeneration::observe(&host, path).unwrap().unwrap();
    host.append(path, "{\"id\":\"own\"}\n").unwrap();
    let after = SourceGeneration::observe(&host, path).unwrap().unwrap();
    // This test supplies real append evidence; callers are responsible for
    // proving the kept prefix, not merely observing the before/after token.
    restored
        .accept_appended(
            after,
            before.covered_len,
            &[(
                "own".into(),
                RowLocation {
                    partition: 16,
                    offset: before.covered_len,
                    ordinal: 0,
                },
            )],
        )
        .unwrap();
    restored.save(&host, &store);
    restored = IdLocator::build_persisted(&host, &paths, &BTreeMap::new(), None, &store).unwrap();
    assert_eq!(restored.locate("own").unwrap().len(), 1);
    host.write(&paths[0], "{\"id\":\"external\"}\n").unwrap();
    restored
        .refresh_visiting(&host, &paths, &mut |_, _, _, _| {
            visits += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(visits, 1);
    let rebuilt = IdLocator::build(&host, &paths).unwrap();
    for id in ["0-0", "external", "own", "32-16", "missing"] {
        assert_eq!(restored.locate(id).unwrap(), rebuilt.locate(id).unwrap());
    }
}

#[test]
fn cross_file_duplicates_keep_text_error_and_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_secs(60)).unwrap();
    let root = dir.path().to_str().unwrap();
    let store = Store::new(root.into(), 42);
    let paths = (0..4)
        .map(|file| format!("{root}/{file}.jsonl"))
        .collect::<Vec<_>>();
    for (file, path) in paths.iter().enumerate() {
        host.write(
            path,
            &format!(
                "{{\"id\":\"unique-{file}\"}}\n{{\"id\":\"same\"}}\n{{\"id\":\"also-same\"}}\n"
            ),
        )
        .unwrap();
        IdLocator::build(&host, std::slice::from_ref(path))
            .unwrap()
            .save(&host, &store);
    }
    let text = IdLocator::build(&host, &paths).unwrap_err();
    let first_id = ["same", "also-same"]
        .into_iter()
        .min_by_key(|id| {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            id.hash(&mut hash);
            hash.finish()
        })
        .unwrap();
    assert_eq!(
        text,
        proseql_engine::errors::EngineError::SourceConfig(Box::new(
            proseql_engine::errors::SourceConfigError {
                message: format!("Duplicate partition record '{first_id}'"),
                path: Some(paths[1].clone()),
                source_id: None,
                collection: None,
            }
        ))
    );
    let saved =
        IdLocator::build_persisted(&host, &paths, &BTreeMap::new(), None, &store).unwrap_err();
    assert_eq!(text, saved);
}

#[test]
fn unsorted_saved_table_is_a_cache_miss() {
    let dir = tempfile::tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_secs(60)).unwrap();
    let root = dir.path().to_str().unwrap();
    let path = format!("{root}/one.jsonl");
    host.write(&path, "{\"id\":\"a\"}\n{\"id\":\"b\"}\n{\"id\":\"c\"}\n")
        .unwrap();
    let paths = [path.clone()];
    let store = Store::new(root.into(), 42);
    let original = IdLocator::build(&host, &paths).unwrap();
    original.save(&host, &store);
    let generation = original.generation_for(&path).unwrap();
    let mut payload = store.load(&host, generation, "ids").unwrap().payload;
    let first = payload[24..48].to_vec();
    let last = payload[72..96].to_vec();
    payload[24..48].copy_from_slice(&last);
    payload[72..96].copy_from_slice(&first);
    store.save(&host, generation, "ids", &payload);
    let restored =
        IdLocator::build_persisted(&host, &paths, &BTreeMap::new(), None, &store).unwrap();
    for id in ["a", "b", "c", "missing"] {
        assert_eq!(restored.locate(id).unwrap(), original.locate(id).unwrap());
    }
}
