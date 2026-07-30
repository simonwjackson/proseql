use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use proseql_engine::errors::{EngineError, StorageOperation};
use proseql_storage::host::{StorageEventKind, StorageHost};
use proseql_storage::memory::MemoryStorageHost;

#[cfg(not(target_arch = "wasm32"))]
use proseql_storage::fs::FsStorageHost;

#[cfg(not(target_arch = "wasm32"))]
use tempfile::tempdir;

#[test]
fn memory_host_write_read_append_exists_and_remove_round_trip() {
    let host = MemoryStorageHost::default();
    host.write("/data/users.json", "{\"a\":1}").unwrap();
    host.append("/data/users.json", "\n{\"b\":2}").unwrap();
    assert!(host.exists("/data/users.json").unwrap());
    assert_eq!(
        host.read("/data/users.json").unwrap(),
        "{\"a\":1}\n{\"b\":2}"
    );
    host.remove("/data/users.json").unwrap();
    assert!(!host.exists("/data/users.json").unwrap());
}

#[test]
fn memory_host_read_missing_path_uses_storage_error_shape() {
    let host = MemoryStorageHost::default();
    let err = host.read("/missing.json").unwrap_err();
    match err {
        EngineError::Storage(error) => {
            assert_eq!(error.operation, StorageOperation::Read);
            assert_eq!(error.path, "/missing.json");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn memory_host_list_directory_and_recursive_are_lexically_sorted() {
    let host = MemoryStorageHost::default();
    host.write("/data/z.yaml", "z").unwrap();
    host.write("/data/nested/a.yaml", "a").unwrap();
    host.write("/data/nested/deeper/b.json", "b").unwrap();
    host.write("/other/c.yaml", "c").unwrap();

    assert_eq!(
        host.list_directory("/data").unwrap(),
        vec!["/data/nested", "/data/z.yaml"]
    );
    assert_eq!(
        host.list_recursive("/data").unwrap(),
        vec![
            "/data/nested/a.yaml",
            "/data/nested/deeper/b.json",
            "/data/z.yaml",
        ]
    );
}

#[test]
fn memory_host_watch_reports_add_change_and_remove() {
    let host = MemoryStorageHost::default();
    let (tx, rx) = mpsc::channel();
    let handle = host
        .watch_dir(
            "/watched",
            Box::new(move |event| {
                tx.send((event.kind, event.filename)).unwrap();
            }),
        )
        .unwrap();

    host.write("/watched/file.txt", "one").unwrap();
    host.write("/watched/file.txt", "two").unwrap();
    host.remove("/watched/file.txt").unwrap();

    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        (StorageEventKind::Add, Some("file.txt".to_owned()))
    );
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        (StorageEventKind::Change, Some("file.txt".to_owned()))
    );
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        (StorageEventKind::Remove, Some("file.txt".to_owned()))
    );

    handle.stop().unwrap();
}

struct DropProbe {
    dropped: Arc<AtomicUsize>,
}

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn memory_host_watch_stop_and_drop_unregister_callbacks() {
    let host = MemoryStorageHost::default();
    let drops = Arc::new(AtomicUsize::new(0));

    for _ in 0..3 {
        let probe = DropProbe {
            dropped: Arc::clone(&drops),
        };
        let handle = host
            .watch_dir(
                "/watched",
                Box::new(move |_| {
                    let _keep_probe_alive = &probe;
                }),
            )
            .unwrap();
        handle.stop().unwrap();
        handle.stop().unwrap();
    }

    {
        let probe = DropProbe {
            dropped: Arc::clone(&drops),
        };
        let handle = host
            .watch(
                "/watched/file.txt",
                Box::new(move |_| {
                    let _keep_probe_alive = &probe;
                }),
            )
            .unwrap();
        drop(handle);
    }

    host.write("/watched/file.txt", "hit").unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 4);
}

#[test]
fn path_watch_only_emits_for_target_path() {
    let host = MemoryStorageHost::default();
    let (tx, rx) = mpsc::channel();
    let handle = host
        .watch(
            "/data/one.txt",
            Box::new(move |_| {
                tx.send(()).unwrap();
            }),
        )
        .unwrap();

    host.write("/data/two.txt", "skip").unwrap();
    host.write("/data/one.txt", "hit").unwrap();

    assert!(rx.recv_timeout(Duration::from_secs(1)).is_ok());
    assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    handle.stop().unwrap();
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn fs_host_round_trips_real_file_operations() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nested/users.json");
    let host = FsStorageHost::new_polling(Duration::from_millis(50)).unwrap();

    host.write(path.to_str().unwrap(), "{\"id\":1}").unwrap();
    host.append(path.to_str().unwrap(), "\n{\"id\":2}").unwrap();

    assert!(host.exists(path.to_str().unwrap()).unwrap());
    assert_eq!(
        host.read(path.to_str().unwrap()).unwrap(),
        "{\"id\":1}\n{\"id\":2}"
    );
    assert_eq!(
        host.list_recursive(dir.path().to_str().unwrap()).unwrap(),
        vec![path.to_string_lossy().to_string()]
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn fs_host_watch_path_matches_exact_file_without_suffix_false_positives() {
    let dir = tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_millis(50)).unwrap();
    let target = dir.path().join("data.yaml");
    std::fs::write(&target, "a: 1\n").unwrap();
    let (tx, rx) = mpsc::channel();
    let handle = host
        .watch(
            target.to_str().unwrap(),
            Box::new(move |_| {
                tx.send(()).unwrap();
            }),
        )
        .unwrap();

    std::thread::sleep(Duration::from_millis(150));

    std::fs::write(dir.path().join("data.yaml.bak"), "skip\n").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());

    let mut saw_target = false;
    for attempt in 0..10 {
        std::fs::write(&target, format!("a: {}\n", attempt + 2)).unwrap();
        if rx.recv_timeout(Duration::from_millis(300)).is_ok() {
            saw_target = true;
            break;
        }
    }
    assert!(saw_target);
    handle.stop().unwrap();
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn fs_host_watch_dir_emits_real_tempdir_changes() {
    let dir = tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_millis(50)).unwrap();
    let (tx, rx) = mpsc::channel();
    let handle = host
        .watch_dir(
            dir.path().to_str().unwrap(),
            Box::new(move |event| {
                tx.send(event).unwrap();
            }),
        )
        .unwrap();

    let path = dir.path().join("data.yaml");
    std::fs::write(&path, "a: 1\n").unwrap();

    let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(matches!(
        event.kind,
        StorageEventKind::Add | StorageEventKind::Change
    ));
    assert_eq!(event.filename, Some("data.yaml".to_owned()));
    handle.stop().unwrap();
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn fs_host_watch_dir_recurses_into_nested_directories() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let host = FsStorageHost::new_polling(Duration::from_millis(50)).unwrap();
    let (tx, rx) = mpsc::channel();
    let handle = host
        .watch_dir(
            dir.path().to_str().unwrap(),
            Box::new(move |event| {
                tx.send(event).unwrap();
            }),
        )
        .unwrap();

    std::fs::write(nested.join("child.yaml"), "a: 1\n").unwrap();

    let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(matches!(
        event.kind,
        StorageEventKind::Add | StorageEventKind::Change
    ));
    assert_eq!(event.filename, Some("child.yaml".to_owned()));
    handle.stop().unwrap();
}
