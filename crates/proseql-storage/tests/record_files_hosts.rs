use proseql_storage::{
    host::StorageHost, memory::MemoryStorageHost, persistence::DurableStorageHost,
};
#[test]
fn memory_listing_preserves_directories_and_removal_is_visible() {
    let host = MemoryStorageHost::default();
    host.write("records/a.json", "{}").unwrap();
    host.write("records/nested/b.json", "{}").unwrap();
    assert_eq!(
        host.list_directory("records").unwrap(),
        vec!["records/a.json", "records/nested"]
    );
    host.preflight_remove_durable("records/a.json").unwrap();
    host.remove_durable("records/a.json").unwrap();
    assert!(!host.exists("records/a.json").unwrap());
    assert!(host.exists("records/nested/b.json").unwrap());
}
#[test]
fn filesystem_listings_can_distinguish_directories_with_matching_extensions() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("nested.json")).unwrap();
    std::fs::write(dir.path().join("a.json"), "{}").unwrap();
    let host =
        proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(2)).unwrap();
    let root = dir.path().to_str().unwrap();
    assert_eq!(host.list_directory(root).unwrap().len(), 2);
    assert!(!host
        .is_directory(dir.path().join("a.json").to_str().unwrap())
        .unwrap());
    assert!(host
        .is_directory(dir.path().join("nested.json").to_str().unwrap())
        .unwrap());
}
