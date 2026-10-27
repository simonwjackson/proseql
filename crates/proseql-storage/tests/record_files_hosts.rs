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

#[test]
fn memory_virtual_roots_exist_and_list_separate_relative_and_absolute_namespaces() {
    let host = MemoryStorageHost::default();
    for root in [".", "/"] {
        assert!(host.exists(root).unwrap());
        assert!(host.is_directory(root).unwrap());
        assert!(host.list_directory(root).unwrap().is_empty());
        assert!(host.write(root, "not a file").is_err());
        assert!(host.append(root, "not a file").is_err());
        assert!(host.remove(root).is_err());
    }
    host.write("relative/a.json", "{}").unwrap();
    host.write("root.json", "{}").unwrap();
    host.write("/absolute/a.json", "{}").unwrap();
    assert_eq!(
        host.list_directory(".").unwrap(),
        vec!["relative", "root.json"]
    );
    assert_eq!(
        host.list_recursive(".").unwrap(),
        vec!["relative/a.json", "root.json"]
    );
    assert_eq!(host.list_directory("/").unwrap(), vec!["/absolute"]);
    assert_eq!(host.list_recursive("/").unwrap(), vec!["/absolute/a.json"]);
    host.remove("relative/a.json").unwrap();
    host.remove("root.json").unwrap();
    host.remove("/absolute/a.json").unwrap();
    assert!(host.exists(".").unwrap());
    assert!(host.exists("/").unwrap());
}
#[test]
fn memory_virtual_root_watches_stay_within_their_namespace() {
    let host = MemoryStorageHost::default();
    let (relative_send, relative_receive) = std::sync::mpsc::channel();
    let (absolute_send, absolute_receive) = std::sync::mpsc::channel();
    let relative = host
        .watch_dir(
            ".",
            Box::new(move |event| relative_send.send(event.path).unwrap()),
        )
        .unwrap();
    let absolute = host
        .watch_dir(
            "/",
            Box::new(move |event| absolute_send.send(event.path).unwrap()),
        )
        .unwrap();
    host.write("./nested/a.json", "{}").unwrap();
    host.write("/nested/a.json", "{}").unwrap();
    assert_eq!(
        relative_receive.try_recv().unwrap(),
        Some("nested/a.json".into())
    );
    assert!(relative_receive.try_recv().is_err());
    assert_eq!(
        absolute_receive.try_recv().unwrap(),
        Some("/nested/a.json".into())
    );
    assert!(absolute_receive.try_recv().is_err());
    relative.stop().unwrap();
    absolute.stop().unwrap();
}
