use proseql_storage::{
    fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost},
    generation::SourceGeneration,
    host::StorageHost,
    index::{persist::Store, IdLocator, TimeIndex},
};
use serde_json::json;
use std::{collections::BTreeMap, fs, io::Write, sync::Arc, time::Duration};

#[test]
fn id_and_time_sidecars_extend_only_checked_prefixes() {
    let dir = tempfile::tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_secs(1)).unwrap();
    let path = dir.path().join("one.jsonl").to_str().unwrap().to_owned();
    host.write(&path, "{\"id\":\"a\",\"at\":1}\n{\"id\":\"b\",\"at\":2}\n")
        .unwrap();
    let store = Store::new(dir.path().to_str().unwrap().into(), 1);
    let paths = [path.clone()];
    let ids = IdLocator::build(&host, &paths).unwrap();
    ids.save(&host, &store);
    TimeIndex::build(&host, &path, "at", 1)
        .unwrap()
        .save(&host, &store);
    store.save(&host, ids.generation_for(&path).unwrap(), "valid", &[]);
    let mut visited = 0;
    let mut visit = |_: &str, _: &[u8], _: proseql_engine::scan::RowLocation, _: bool| {
        visited += 1;
        Ok(None)
    };
    let restored =
        IdLocator::build_persisted(&host, &paths, &BTreeMap::new(), Some(&mut visit), &store)
            .unwrap();
    assert_eq!(
        visited, 0,
        "unchanged trusted token restores without row decoding"
    );
    assert_eq!(ids.locate("a").unwrap(), restored.locate("a").unwrap());
    writeln!(
        fs::OpenOptions::new().append(true).open(&path).unwrap(),
        "{{\"id\":\"c\",\"at\":3}}"
    )
    .unwrap();
    visited = 0;
    let mut visit = |_: &str, _: &[u8], _: proseql_engine::scan::RowLocation, _: bool| {
        visited += 1;
        Ok(None)
    };
    let restored =
        IdLocator::build_persisted(&host, &paths, &BTreeMap::new(), Some(&mut visit), &store)
            .unwrap();
    assert_eq!(
        visited, 1,
        "grown file scans only the suffix after prefix proof"
    );
    assert_eq!(restored.locate("c").unwrap().len(), 1);
    let current = SourceGeneration::observe(&host, &path).unwrap().unwrap();
    let time =
        TimeIndex::load_validating(&host, &store, &current, "at", 1, Some(&mut |_, _| Ok(())))
            .unwrap();
    assert!(time.seek(Some(&json!(3)), Some(&json!(3))).is_some());
    assert!(TimeIndex::load(
        &host,
        &Store::new(dir.path().to_str().unwrap().into(), 2),
        &current,
        "at",
        1
    )
    .is_none());
    let edited = fs::read_to_string(&path).unwrap().replace("\"a\"", "\"z\"");
    fs::write(&path, edited).unwrap();
    let current = SourceGeneration::observe(&host, &path).unwrap().unwrap();
    assert!(store.load(&host, &current, "ids").is_none());
    assert!(TimeIndex::load(&host, &store, &current, "at", 1).is_none());
    assert_eq!(
        IdLocator::build_persisted(&host, &paths, &BTreeMap::new(), None, &store)
            .unwrap()
            .locate("z")
            .unwrap()
            .len(),
        1
    );
}

struct Crash;
impl DurabilityFaultInjector for Crash {
    fn check(
        &self,
        point: DurabilityFaultPoint,
    ) -> Result<(), proseql_engine::errors::EngineError> {
        if point == DurabilityFaultPoint::IndexRename {
            std::process::exit(73);
        }
        Ok(())
    }
}
#[test]
#[ignore = "subprocess invoked by crash_before_rename_preserves_old_or_no_sidecar"]
fn index_crash_child() {
    let path = std::env::var("PROSEQL_INDEX_CRASH_PATH").unwrap();
    let host =
        FsStorageHost::new_polling_with_fault_injector(Duration::from_secs(1), Arc::new(Crash))
            .unwrap();
    host.write_index_atomic(&path, b"new incomplete publication");
    panic!("fault seam was not reached");
}
#[test]
fn crash_before_rename_preserves_old_or_no_sidecar() {
    for old in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".proseql-index/one.idx");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        if old {
            fs::write(&path, b"old sidecar").unwrap();
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "index_crash_child", "--ignored"])
            .env("PROSEQL_INDEX_CRASH_PATH", &path)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(73));
        if old {
            assert_eq!(fs::read(&path).unwrap(), b"old sidecar");
        } else {
            assert!(!path.exists());
        }
        assert_eq!(
            fs::read_dir(path.parent().unwrap()).unwrap().count(),
            if old { 2 } else { 1 }
        );
    }
}
