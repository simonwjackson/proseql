mod support;

use proseql_engine::errors::EngineError;
use proseql_native::NativeRuntime;
use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint, FsStorageHost};
use serde_json::json;
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use support::parity::{sample, ParityFixture, RuntimeKind, COLLECTION};

struct EditSecondAppend {
    calls: AtomicUsize,
    path: std::path::PathBuf,
    original: String,
    changed: String,
}
impl DurabilityFaultInjector for EditSecondAppend {
    fn check(&self, point: DurabilityFaultPoint) -> Result<(), EngineError> {
        if point == DurabilityFaultPoint::AppendSync
            && self.calls.fetch_add(1, Ordering::SeqCst) == 1
        {
            let text = fs::read_to_string(&self.path).unwrap();
            let offset = text.find(&self.original).unwrap();
            assert_eq!(self.original.len(), self.changed.len());
            let mut file = fs::OpenOptions::new().write(true).open(&self.path).unwrap();
            file.seek(SeekFrom::Start(offset as u64)).unwrap();
            file.write_all(self.changed.as_bytes()).unwrap();
        }
        Ok(())
    }
}

#[test]
fn previous_own_append_identity_does_not_bless_a_prefix_edit_during_the_next_append() {
    let fixture = ParityFixture::new(1440);
    let mut stored = sample("2025-01", 1, 0, "steps");
    let original = stored["id"].as_str().unwrap().to_owned();
    let changed = original.replacen("steps:", "stops:", 1);
    let faults = Arc::new(EditSecondAppend {
        calls: AtomicUsize::new(0),
        path: fixture.partition_path("2025-01"),
        original,
        changed: changed.clone(),
    });
    let host = Arc::new(
        FsStorageHost::new_polling_with_fault_injector(Duration::from_secs(3600), faults.clone())
            .unwrap(),
    );
    let runtime = NativeRuntime::open_sources_with_host(
        fixture.config(),
        host,
        fixture.options(RuntimeKind::Lazy),
    )
    .unwrap();
    for minute in [1, 2] {
        runtime
            .mutate(|db| db.create(COLLECTION, sample("2025-01", 1, minute, "steps")))
            .unwrap();
    }
    assert_eq!(faults.calls.load(Ordering::SeqCst), 2);
    stored["id"] = json!(changed);
    stored["value"] = json!(-1);
    assert_eq!(
        runtime
            .mutate(|db| db.create(COLLECTION, stored))
            .unwrap_err()
            .tag(),
        "DuplicateKeyError"
    );
}
