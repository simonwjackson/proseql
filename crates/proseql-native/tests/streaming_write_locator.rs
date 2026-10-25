mod support;
use support::parity::RuntimeKind;

use proseql_engine::errors::EngineError;
use proseql_native::NativeRuntime;
use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost};
use serde_json::json;
use std::fs;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use support::parity::{sample, ParityFixture, COLLECTION};

#[test]
fn releasing_indexes_preserves_global_duplicates_and_rebuilds_after_external_edits() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(RuntimeKind::Lazy);
    let old = sample("2025-01", 1, 0, "steps");
    assert_eq!(
        runtime
            .find_by_id(COLLECTION, old["id"].as_str().unwrap())
            .unwrap(),
        Some(old.clone())
    );
    runtime.release_streaming_indexes().unwrap();
    let mut conflicting = sample("2025-03", 1, 1, "steps");
    conflicting["id"] = old["id"].clone();
    assert_eq!(
        runtime
            .mutate(|db| db.create(COLLECTION, conflicting))
            .unwrap_err()
            .tag(),
        "DuplicateKeyError"
    );
    runtime.release_streaming_indexes().unwrap();
    let mut replacement = old.clone();
    replacement["id"] = json!("replacement-id");
    fs::write(
        fixture.partition_path("2025-01"),
        format!("{replacement}\n"),
    )
    .unwrap();
    assert_eq!(
        runtime
            .find_by_id(COLLECTION, old["id"].as_str().unwrap())
            .unwrap(),
        None
    );
    assert_eq!(
        runtime.find_by_id(COLLECTION, "replacement-id").unwrap(),
        Some(replacement)
    );
    let ours = sample("2025-04", 1, 1, "steps");
    runtime
        .mutate(|db| db.create(COLLECTION, ours.clone()))
        .unwrap();
    runtime.release_streaming_indexes().unwrap();
    assert_eq!(
        runtime
            .find_by_id(COLLECTION, ours["id"].as_str().unwrap())
            .unwrap(),
        Some(ours)
    );
}

struct EditPrefixAtSync {
    path: std::path::PathBuf,
    original_id: String,
    changed_id: String,
    fired: AtomicBool,
}
impl DurabilityFaultInjector for EditPrefixAtSync {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == DurabilityFaultPoint::AppendSync && !self.fired.swap(true, Ordering::SeqCst) {
            use std::io::{Seek, SeekFrom, Write};
            let text = fs::read_to_string(&self.path).unwrap();
            let offset = text.find(&self.original_id).unwrap();
            assert_eq!(self.original_id.len(), self.changed_id.len());
            let mut file = fs::OpenOptions::new().write(true).open(&self.path).unwrap();
            file.seek(SeekFrom::Start(offset as u64)).unwrap();
            file.write_all(self.changed_id.as_bytes()).unwrap();
        }
        Ok(())
    }
}

#[test]
fn prefix_edit_during_durable_append_is_not_blessed_by_the_postcommit_token() {
    let fixture = ParityFixture::new(1440);
    let mut stored = sample("2025-01", 1, 0, "steps");
    let original_id = stored["id"].as_str().unwrap().to_owned();
    let changed_id = original_id.replacen("steps:", "stops:", 1);
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(
            Duration::from_secs(3600),
            Arc::new(EditPrefixAtSync {
                path: fixture.partition_path("2025-01"),
                original_id,
                changed_id: changed_id.clone(),
                fired: AtomicBool::new(false),
            }),
        )
        .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        fixture.config(),
        host,
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    runtime
        .mutate(|db| db.create(COLLECTION, sample("2025-01", 1, 1, "steps")))
        .unwrap();
    stored["id"] = json!(changed_id);
    stored["value"] = json!(-1);
    assert_eq!(
        runtime
            .mutate(|db| db.create(COLLECTION, stored))
            .unwrap_err()
            .tag(),
        "DuplicateKeyError"
    );
}

#[test]
fn release_between_mutations_does_not_change_staged_creates_or_duplicate_checks() {
    let fixture = ParityFixture::new(1440);
    let runtime = fixture.open(RuntimeKind::Lazy);
    let ours = sample("2025-01", 1, 1, "steps");
    runtime.release_streaming_indexes().unwrap();
    runtime
        .mutate(|db| {
            assert_eq!(db.create(COLLECTION, ours.clone())?, ours);
            assert_eq!(db.create(COLLECTION, ours.clone())?, ours);
            Ok(())
        })
        .unwrap();
    runtime.release_streaming_indexes().unwrap();
    assert_eq!(
        runtime
            .mutate(|db| db.create(COLLECTION, ours.clone()))
            .unwrap(),
        ours
    );
}
