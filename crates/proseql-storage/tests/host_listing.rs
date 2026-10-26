use proseql_storage::{host::StorageHost, memory::MemoryStorageHost};

fn matches_separate_observations(host: &dyn StorageHost, root: &str) {
    let expected = host
        .list_directory(root)
        .unwrap()
        .into_iter()
        .filter_map(|path| host.stat(&path).unwrap().map(|stat| (path, stat)))
        .collect::<Vec<_>>();
    assert_eq!(host.list_directory_with_stat(root).unwrap(), expected);
}

#[test]
fn memory_default_listing_matches_separate_stats() {
    let host = MemoryStorageHost::default();
    host.write("parts/a", "a").unwrap();
    host.write("parts/b", "bbb").unwrap();
    matches_separate_observations(&host, "parts");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn filesystem_listing_matches_stats_and_detects_same_length_edits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("a.jsonl").to_string_lossy().into_owned();
    let host =
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(3600))
            .unwrap();
    host.write(&path, "before").unwrap();
    matches_separate_observations(&host, root);
    let before = host.list_directory_with_stat(root).unwrap()[0].1;
    host.write(&path, "edited").unwrap();
    let after = host.list_directory_with_stat(root).unwrap()[0].1;
    assert_eq!(before.len, after.len);
    #[cfg(unix)]
    assert_ne!(before.change_id, after.change_id);
    matches_separate_observations(&host, root);
}

#[cfg(unix)]
#[test]
fn filesystem_listing_follows_links_like_stat() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    std::fs::write(&target, "some file bytes").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let host =
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(3600))
            .unwrap();
    matches_separate_observations(&host, dir.path().to_str().unwrap());
}

#[test]
fn tokenless_listed_generation_matches_observe_and_rejects_stale_length() {
    use proseql_storage::generation::SourceGeneration;
    let host = MemoryStorageHost::default();
    host.write("parts/a", "before").unwrap();
    let stat = host.list_directory_with_stat("parts").unwrap()[0].1;
    assert_eq!(
        SourceGeneration::observe_stat(&host, "parts/a", stat).unwrap(),
        SourceGeneration::observe(&host, "parts/a")
            .unwrap()
            .unwrap()
    );
    host.write("parts/a", "longer edit").unwrap();
    assert!(SourceGeneration::observe_stat(&host, "parts/a", stat).is_err());
}

#[cfg(unix)]
#[test]
fn trusted_listed_generation_matches_observe_and_stale_generation_fails_check() {
    use proseql_storage::generation::{GenerationCheck, SourceGeneration};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.jsonl").to_string_lossy().into_owned();
    let host =
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(3600))
            .unwrap();
    host.write(&path, "before").unwrap();
    let stat = host
        .list_directory_with_stat(dir.path().to_str().unwrap())
        .unwrap()[0]
        .1;
    assert_eq!(
        SourceGeneration::observe_stat(&host, &path, stat).unwrap(),
        SourceGeneration::observe(&host, &path).unwrap().unwrap()
    );
    host.write(&path, "edited").unwrap();
    let stale = SourceGeneration::observe_stat(&host, &path, stat).unwrap();
    assert_eq!(stale.check(&host).unwrap(), GenerationCheck::Replaced);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn listing_recovers_pending_first_write_and_committed_replace() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let host =
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(3600))
            .unwrap();
    let pending = dir.path().join("pending.jsonl");
    std::fs::write(&pending, "uncommitted").unwrap();
    std::fs::write(dir.path().join(".pending.jsonl.proseql-committed"), "P").unwrap();
    let committed = dir.path().join("committed.jsonl");
    std::fs::write(&committed, "committed content").unwrap();
    std::fs::write(
        dir.path().join(".committed.jsonl.proseql-backup"),
        "old content",
    )
    .unwrap();
    std::fs::write(dir.path().join(".committed.jsonl.proseql-committed"), "C").unwrap();
    let entries = host.list_directory_with_stat(root).unwrap();
    assert!(!pending.exists());
    assert_eq!(
        entries,
        vec![(
            committed.to_string_lossy().into_owned(),
            host.stat(committed.to_str().unwrap()).unwrap().unwrap()
        )]
    );
    // An orphan backup restores a file absent from the original read_dir pass.
    std::fs::write(
        dir.path().join(".restored.jsonl.proseql-backup"),
        "restored",
    )
    .unwrap();
    let entries = host.list_directory_with_stat(root).unwrap();
    assert_eq!(entries.len(), 2);
    matches_separate_observations(&host, root);
}
