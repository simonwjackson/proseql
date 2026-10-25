//! Post-commit bookkeeping through a counted, tokenless real filesystem host.
use super::record_committed;
use crate::{locate::IndexState, stored_file::StoredFile};
use indexmap::IndexMap;
use proseql_engine::errors::EngineError;
use proseql_storage::{
    fs::FsStorageHost,
    host::{FileStat, StorageEvent, StorageHost, WatchHandle},
    persistence::DurableStorageHost,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

struct TokenlessFs {
    inner: FsStorageHost,
    bytes: AtomicU64,
    edit_at: AtomicU64,
}
impl StorageHost for TokenlessFs {
    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.inner.read(path)
    }
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        assert!(len <= 64 * 1024);
        let bytes = self.inner.read_range(path, offset, len)?;
        self.bytes.fetch_add(bytes.len() as u64, Ordering::SeqCst);
        if self
            .edit_at
            .compare_exchange(offset, u64::MAX, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
            file.seek(SeekFrom::Start(7)).unwrap();
            file.write_all(b"z").unwrap();
            file.sync_data().unwrap();
        }
        Ok(bytes)
    }
    fn stat(&self, path: &str) -> Result<Option<FileStat>, EngineError> {
        Ok(self.inner.stat(path)?.map(|mut stat| {
            // Force content-only checks even for an in-place same-length edit.
            stat.change_id = None;
            stat.modified_ns = None;
            stat
        }))
    }
    fn write(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.write(path, data)
    }
    fn append(&self, path: &str, data: &str) -> Result<(), EngineError> {
        self.inner.append(path, data)
    }
    fn exists(&self, path: &str) -> Result<bool, EngineError> {
        self.inner.exists(path)
    }
    fn remove(&self, path: &str) -> Result<(), EngineError> {
        self.inner.remove(path)
    }
    fn ensure_dir(&self, path: &str) -> Result<(), EngineError> {
        self.inner.ensure_dir(path)
    }
    fn list_directory(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_directory(path)
    }
    fn list_recursive(&self, path: &str) -> Result<Vec<String>, EngineError> {
        self.inner.list_recursive(path)
    }
    fn watch(
        &self,
        path: &str,
        callback: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch(path, callback)
    }
    fn watch_dir(
        &self,
        path: &str,
        callback: Box<dyn Fn(StorageEvent) + Send + Sync>,
    ) -> Result<Box<dyn WatchHandle>, EngineError> {
        self.inner.watch_dir(path, callback)
    }
}

struct ProofFixture {
    _dir: tempfile::TempDir,
    host: TokenlessFs,
    index: IndexState,
    starts: IndexMap<String, u64>,
    contents: IndexMap<String, StoredFile>,
    len: u64,
    suffix_len: u64,
}
impl ProofFixture {
    fn new(rows: usize) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rows.jsonl").to_string_lossy().into_owned();
        let host = TokenlessFs {
            inner: FsStorageHost::new_polling(Duration::from_secs(3600)).unwrap(),
            bytes: AtomicU64::new(0),
            edit_at: AtomicU64::new(u64::MAX),
        };
        let payload = "x".repeat(128);
        let text = (0..rows)
            .map(|row| format!("{{\"id\":\"base-{row}\",\"payload\":\"{payload}\"}}\n"))
            .collect::<String>();
        host.write(&path, &text).unwrap();
        let mut index = IndexState::default();
        index
            .id_locator(&host, std::slice::from_ref(&path))
            .unwrap();
        let mut stored = StoredFile::append(text.as_bytes(), None);
        let plan = stored.plan(&path, "{\"id\":\"new\"}\n".into());
        host.inner
            .append_durable(&path, plan.keep_len, &plan.data)
            .unwrap();
        stored.apply(&plan);
        let len = stored.len() as u64;
        let suffix_len = plan.data.len() as u64;
        host.bytes.store(0, Ordering::SeqCst);
        Self {
            _dir: dir,
            host,
            index,
            starts: IndexMap::from([(path.clone(), text.len() as u64)]),
            contents: IndexMap::from([(path, stored)]),
            len,
            suffix_len,
        }
    }
    fn record(&mut self) -> Result<(), EngineError> {
        record_committed(&mut self.index, &self.host, &self.starts, &self.contents)
    }
}

#[test]
fn tokenless_postcommit_reuses_observed_hash_and_keeps_one_independent_check() {
    let mut fixture = ProofFixture::new(1000);
    fixture.record().unwrap();
    assert_eq!(
        fixture.host.bytes.load(Ordering::SeqCst),
        2 * fixture.len + fixture.suffix_len
    );
    assert_eq!(
        fixture
            .index
            .id_locator_if_built()
            .unwrap()
            .locate("new")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn tokenless_final_check_detects_prefix_edit_after_observation() {
    let mut fixture = ProofFixture::new(1000);
    fixture
        .host
        .edit_at
        .store(fixture.starts[0], Ordering::SeqCst);
    let error = fixture.record().unwrap_err();
    assert!(matches!(error, EngineError::Operation(ref error) if error.reason == "source-changed"));
    assert_eq!(fixture.host.edit_at.load(Ordering::SeqCst), u64::MAX);
}

#[test]
#[ignore = "tokenless postcommit I/O and latency measurement; run explicitly in release mode"]
fn measure_tokenless_postcommit() {
    let mut fixture = ProofFixture::new(100_000);
    for trial in 0..5 {
        fixture.host.bytes.store(0, Ordering::SeqCst);
        let start = Instant::now();
        fixture.record().unwrap();
        let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
        println!("tokenless_postcommit trial={trial} source_bytes={} read_bytes={} suffix_bytes={} wall_ms={wall_ms:.3}", fixture.len, fixture.host.bytes.load(Ordering::SeqCst), fixture.suffix_len);
    }
}
