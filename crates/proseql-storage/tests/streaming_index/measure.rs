//! Synthetic measurement through the real filesystem host. The counted-I/O
//! host below is used only to prove that append refresh does not decode the
//! old prefix again.
use proseql_engine::errors::{EngineError, StorageError, StorageOperation};
use proseql_storage::fs::FsStorageHost;
use proseql_storage::host::{FileStat, StorageEvent, StorageHost, WatchHandle};
use proseql_storage::index::{rows, IdLocator, TimeIndex};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct TextHost {
    inner: FsStorageHost,
    pub reads: Mutex<Vec<(u64, usize)>>,
    append_on_read: Mutex<Option<String>>,
    token: bool,
}
impl TextHost {
    pub fn new() -> Self {
        Self {
            inner: FsStorageHost::new_polling(Duration::from_secs(3600)).unwrap(),
            reads: Mutex::new(Vec::new()),
            append_on_read: Mutex::new(None),
            token: false,
        }
    }
}
fn error(path: &str, error: std::io::Error) -> EngineError {
    EngineError::Storage(Box::new(StorageError {
        path: path.into(),
        operation: StorageOperation::Read,
        message: error.to_string(),
        cause: None,
    }))
}
impl StorageHost for TextHost {
    fn supports_indexes(&self) -> bool {
        self.inner.supports_indexes()
    }
    fn read_index(&self, path: &str) -> Option<Vec<u8>> {
        self.inner.read_index(path)
    }
    fn write_index_atomic(&self, path: &str, data: &[u8]) {
        self.inner.write_index_atomic(path, data);
    }

    fn read(&self, path: &str) -> Result<String, EngineError> {
        self.inner.read(path)
    }
    fn read_bytes(&self, path: &str) -> Result<Vec<u8>, EngineError> {
        self.inner.read_bytes(path)
    }
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, EngineError> {
        self.reads.lock().unwrap().push((offset, len));
        let mut file = fs::File::open(path).map_err(|e| error(path, e))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| error(path, e))?;
        let mut bytes = Vec::with_capacity(len);
        file.take(len as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| error(path, e))?;
        if let Some(data) = self.append_on_read.lock().unwrap().take() {
            self.inner.append(path, &data)?;
        }
        Ok(bytes)
    }
    fn stat(&self, path: &str) -> Result<Option<FileStat>, EngineError> {
        if self.token {
            return self.inner.stat(path);
        }
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(error(path, e)),
        };
        Ok(Some(FileStat {
            len: metadata.len(),
            modified_ns: metadata
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos()),
            change_id: None,
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
    fn list_directory_with_stat(
        &self,
        dir_path: &str,
    ) -> Result<Vec<(String, proseql_storage::host::FileStat)>, EngineError> {
        let mut entries = Vec::new();
        for path in self.list_directory(dir_path)? {
            if let Some(stat) = self.stat(&path)? {
                entries.push((path, stat));
            }
        }
        Ok(entries)
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

#[test]
fn tokenless_appended_refresh_proves_prefix_and_decodes_only_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join("2025-01.jsonl")
        .to_string_lossy()
        .into_owned();
    let host = TextHost::new();
    let old = (0..3000)
        .map(|i| format!("{{\"id\":\"{i}\"}}\n"))
        .collect::<String>();
    host.write(&path, &old).unwrap();
    let paths = vec![path.clone()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    host.reads.lock().unwrap().clear();
    host.append(&path, "{\"id\":\"external\"}\n").unwrap();
    locator.refresh(&host, &paths).unwrap();
    let reads = host.reads.lock().unwrap();
    // A tokenless host hashes the prefix during advance and again to check
    // for races after the suffix scan. Neither pass decodes prefix IDs.
    assert_eq!(
        reads
            .iter()
            .filter(|(offset, _)| *offset < old.len() as u64)
            .count(),
        2
    );
    assert_eq!(
        reads
            .iter()
            .filter(|(offset, _)| *offset == old.len() as u64)
            .count(),
        2
    );
    assert_eq!(locator.locate("external").unwrap()[0].1.ordinal, 3000);
}

#[test]
fn trusted_fs_token_skips_unchanged_text_and_rebuilds_changed_prefixes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join("token.jsonl")
        .to_string_lossy()
        .into_owned();
    let mut host = TextHost::new();
    host.token = true;
    host.write(&path, "{\"id\":\"old\"}\n").unwrap();
    let generation = proseql_storage::generation::SourceGeneration::observe(&host, &path)
        .unwrap()
        .unwrap();
    assert!(generation.change_id.is_some());
    assert!(generation.check_hash.is_none());
    let paths = vec![path.clone()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    host.reads.lock().unwrap().clear();
    locator.refresh(&host, &paths).unwrap();
    assert!(host.reads.lock().unwrap().is_empty());
    host.write(&path, "{\"id\":\"new\"}\n").unwrap();
    assert_eq!(
        generation.check(&host).unwrap(),
        proseql_storage::generation::GenerationCheck::Replaced
    );
    locator.refresh(&host, &paths).unwrap();
    assert!(locator.locate("old").unwrap().is_empty());
    assert_eq!(locator.locate("new").unwrap().len(), 1);
    host.append(&path, "{\"id\":\"external\"}\n").unwrap();
    let mut visited = 0;
    locator
        .refresh_visiting(&host, &paths, &mut |_, _, _, _| {
            visited += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        visited, 2,
        "changed ctime does not prove append-only growth"
    );
    assert_eq!(locator.locate("external").unwrap().len(), 1);
}

/// Run explicitly in release mode on aka with --x86-64-v2 -- --ignored --nocapture.
#[test]
#[ignore = "656k-row synthetic measurement, not a routine regression test"]
fn measure_656k_rows() {
    let dir = tempfile::tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_secs(3600)).unwrap();
    let mut paths = Vec::new();
    for month in 1..=10 {
        let path = dir
            .path()
            .join(format!("2025-{month:02}.jsonl"))
            .to_string_lossy()
            .into_owned();
        let mut file = std::io::BufWriter::new(fs::File::create(&path).unwrap());
        for i in 0..65_664 {
            let at = format!(
                "2025-{month:02}-01T{:02}:{:02}:{:02}.000Z",
                i / 3600,
                (i / 60) % 60,
                i % 60
            );
            let row = serde_json::json!({
                "id":format!("steps:{at}:synthetic-device-with-a-long-identity"),
                "metric":"steps", "atUtc":at, "dateUtc":format!("2025-{month:02}-01"),
                "value":i, "unit":"count", "source":"synthetic-watch", "endUtc":null,
                "device":"synthetic-device-with-a-long-identity", "quality":"measured", "note":"synthetic only"
            });
            writeln!(file, "{row}").unwrap();
        }
        file.flush().unwrap();
        paths.push(path);
    }
    let total_bytes: u64 = paths
        .iter()
        .map(|path| fs::metadata(path).unwrap().len())
        .sum();
    let start = Instant::now();
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    let build = start.elapsed();
    let bytes = locator.resident_bytes();
    assert!(bytes < 20 * 1024 * 1024);
    println!("id_locator rows=656640 source_bytes={total_bytes} build_ms={:.3} resident_bytes={bytes} bytes_per_row={:.3}",build.as_secs_f64()*1000.0,bytes as f64/656_640.0);
    let start = Instant::now();
    let time = TimeIndex::build(&host, &paths[0], "atUtc", 1024).unwrap();
    println!(
        "time_index rows=65664 source_bytes={} build_ms={:.3} resident_bytes={}",
        fs::metadata(&paths[0]).unwrap().len(),
        start.elapsed().as_secs_f64() * 1000.0,
        time.resident_bytes()
    );
    assert!(time.seek(None, None).is_some());

    let id = "steps:2025-10-01T18:00:00.000Z:synthetic-device-with-a-long-identity";
    let start = Instant::now();
    for _ in 0..1000 {
        let candidates = locator.locate(std::hint::black_box(id)).unwrap();
        assert_eq!(candidates.len(), 1);
        let row = rows::read_line(&host, &candidates[0].0, candidates[0].1.offset).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&row).unwrap()["id"],
            id
        );
    }
    println!(
        "id_verified_warm_mean_us={:.3}",
        start.elapsed().as_secs_f64() * 1_000_000.0 / 1000.0
    );

    // Routing is only a measured alternative, NOT a valid general ID plan:
    // the collection contract does not require id's timestamp to equal atUtc.
    let start = Instant::now();
    let month = &id[6..13];
    let routed = paths
        .iter()
        .find(|path| path.ends_with(&format!("{month}.jsonl")))
        .unwrap();
    let mut found = false;
    let len = fs::metadata(routed).unwrap().len();
    rows::visit_lines(&host, routed, 0, len, 0, |bytes, _, _| {
        #[derive(serde::Deserialize)]
        struct Id<'a> {
            #[serde(borrow)]
            id: std::borrow::Cow<'a, str>,
        }
        if serde_json::from_slice::<Id<'_>>(bytes).unwrap().id == id {
            found = true;
        }
        Ok(())
    })
    .unwrap();
    assert!(found);
    println!(
        "embedded_time_routed_month_scan_ms={:.3} routing_paths_bytes={} general_semantics=false",
        start.elapsed().as_secs_f64() * 1000.0,
        paths.iter().map(|path| path.capacity()).sum::<usize>()
    );

    // Changed identity tokens conservatively rebuild; they do not prove append.
    let generation = proseql_storage::generation::SourceGeneration::observe(&host, &paths[0])
        .unwrap()
        .unwrap();
    host.append(
        &paths[0],
        "{\"id\":\"new-row\",\"atUtc\":\"2025-01-02T00:00:00.000Z\"}\n",
    )
    .unwrap();
    let start = Instant::now();
    assert!(matches!(
        generation.check(&host).unwrap(),
        proseql_storage::generation::GenerationCheck::Replaced
    ));
    println!(
        "changed_month_token_check_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let start = Instant::now();
    locator.refresh(&host, &paths).unwrap();
    println!(
        "checked_external_append_refresh_ms={:.3} resident_bytes={}",
        start.elapsed().as_secs_f64() * 1000.0,
        locator.resident_bytes()
    );
    assert_eq!(locator.locate("new-row").unwrap().len(), 1);
}

#[test]
fn append_during_generation_check_is_not_silently_marked_covered() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("race.jsonl").to_string_lossy().into_owned();
    let host = TextHost::new();
    host.write(&path, "{\"id\":\"first\"}\n").unwrap();
    let paths = vec![path.clone()];
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    host.append(&path, "{\"id\":\"own\"}\n").unwrap();
    *host.append_on_read.lock().unwrap() = Some("{\"id\":\"external\"}\n".into());
    let error = locator.refresh(&host, &paths).unwrap_err();
    assert!(
        matches!(error,EngineError::Operation(ref operation) if operation.reason == "source-changed")
    );
    locator.refresh(&host, &paths).unwrap();
    assert_eq!(locator.locate("own").unwrap()[0].1.ordinal, 1);
    assert_eq!(locator.locate("external").unwrap()[0].1.ordinal, 2);
}

#[test]
#[ignore = "656k-row append-delta measurement, not a routine regression test"]
fn measure_256_append_calls() {
    use proseql_engine::scan::RowLocation;
    let dir = tempfile::tempdir().unwrap();
    let host = FsStorageHost::new_polling(Duration::from_secs(3600)).unwrap();
    let mut paths = Vec::new();
    let mut appended = Vec::new();
    for file in 0..256 {
        let path = dir
            .path()
            .join(format!("{file:03}.jsonl"))
            .to_string_lossy()
            .into_owned();
        let mut text = String::new();
        for row in 0..2565 {
            text.push_str(&format!("{{\"id\":\"old-{file}-{row}\"}}\n"));
        }
        host.write(&path, &text).unwrap();
        let mut offset = text.len() as u64;
        let rows = (0..4)
            .map(|row| {
                let id = format!("new-{file}-{row}");
                let location = RowLocation {
                    partition: 0,
                    offset,
                    ordinal: 0,
                };
                offset += format!("{{\"id\":\"{id}\"}}\n").len() as u64;
                (id, location)
            })
            .collect::<Vec<_>>();
        appended.push((path.clone(), rows));
        paths.push(path);
    }
    let mut locator = IdLocator::build(&host, &paths).unwrap();
    let before = locator.resident_bytes();
    for (path, rows) in &appended {
        let text = rows
            .iter()
            .map(|(id, _)| format!("{{\"id\":\"{id}\"}}\n"))
            .collect::<String>();
        host.append(path, &text).unwrap();
    }
    let start = Instant::now();
    for (path, rows) in &appended {
        locator.record_appended(path, rows).unwrap();
    }
    let elapsed = start.elapsed();
    for file in 0..256 {
        for row in 0..4 {
            assert_eq!(
                locator.locate(&format!("new-{file}-{row}")).unwrap().len(),
                1
            );
        }
    }
    println!("record_appended base_rows=656640 calls=256 rows_per_call=4 wall_ms={:.3} resident_before={before} resident_after={}",elapsed.as_secs_f64()*1000.0,locator.resident_bytes());
}
