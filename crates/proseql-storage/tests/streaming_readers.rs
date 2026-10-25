use proseql_engine::errors::EngineError;
use proseql_engine::scan::{RawRow, RowLocation, RowSource, SliceLines};
use proseql_storage::readers::{ByteChunks, ChunkLines, LineFramer, SliceChunks};

struct RandomChunks<'a> {
    bytes: &'a [u8],
    seed: u64,
    max: usize,
}

impl ByteChunks for RandomChunks<'_> {
    fn next_chunk(&mut self) -> Result<Option<&[u8]>, EngineError> {
        if self.bytes.is_empty() {
            return Ok(None);
        }
        self.seed = self.seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let count = (1 + (self.seed >> 32) as usize % self.max).min(self.bytes.len());
        let (next, rest) = self.bytes.split_at(count);
        self.bytes = rest;
        Ok(Some(next))
    }
}

type OwnedRow = (RowLocation, Vec<u8>, bool);

fn own(row: RawRow<'_>) -> OwnedRow {
    (row.location, row.bytes.to_vec(), row.final_unterminated)
}

fn collect(source: &mut impl RowSource) -> Vec<OwnedRow> {
    let mut rows = Vec::new();
    while let Some(row) = source.next_row().unwrap() {
        rows.push(own(row));
    }
    rows
}

#[test]
fn random_chunks_match_slice_lines_and_push_feeds() {
    let fixed: &[&[u8]] = &[
        b"",
        b"\n",
        b" \r\n\t\n",
        b"a\rb\r",
        b"\r\r\n\r\r",
        b"{\"id\":\"a\"}\r\n\n{\"id\":\"b\"}\n{\"id\":\"c\"",
        "{\"id\":\"é🚀東京\"}\r\n  \n{\"id\":\"é".as_bytes(),
        b"{\"id\":\"a\"}\n{\"id\":\"\xc3",
    ];
    let mut cases = fixed.iter().map(|bytes| bytes.to_vec()).collect::<Vec<_>>();
    let mut seed = 23425_u64;
    for _ in 0..100 {
        let mut bytes = Vec::new();
        for _ in 0..(seed as usize % 35) {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let token = fixed[(seed >> 32) as usize % fixed.len()];
            bytes.extend_from_slice(token);
        }
        cases.push(bytes);
    }
    for bytes in cases {
        let expected = collect(&mut SliceLines::new(&bytes, 7, 31));
        for max in [1, 2, 3, 7, 64, bytes.len() + 1] {
            for seed in 0..8 {
                let mut source = LineFramer::new(
                    RandomChunks {
                        bytes: &bytes,
                        seed,
                        max,
                    },
                    7,
                    31,
                );
                assert_eq!(collect(&mut source), expected, "max={max}, seed={seed}");
                assert_eq!(source.next_ordinal(), 31 + expected.len() as u64);
                // A temporary end of a browser chunk must not classify a torn line.
                let mut chunks = RandomChunks {
                    bytes: &bytes,
                    seed,
                    max,
                };
                let mut source = ChunkLines::new(7, 0, 31);
                let mut actual = Vec::new();
                while let Some(chunk) = chunks.next_chunk().unwrap() {
                    source.push(chunk, false).unwrap();
                    actual.extend(collect(&mut source));
                }
                source.push(&[], true).unwrap();
                actual.extend(collect(&mut source));
                assert_eq!(actual, expected);
            }
        }
    }
}

#[test]
fn seeking_preserves_absolute_offsets_and_first_ordinal() {
    let bytes = b"a\r\n\n b\nlast";
    let expected = collect(&mut SliceLines::new(bytes, 2, 10));
    let mut source = LineFramer::with_offset(SliceChunks::new(&bytes[4..]), 2, 4, 11);
    assert_eq!(collect(&mut source), expected[1..]);
    assert_eq!(source.next_ordinal(), 13);
}

#[test]
fn push_rejects_overwriting_undrained_or_final_input() {
    let mut lines = ChunkLines::new(0, 0, 0);
    lines.push(b"a\nb\n", false).unwrap();
    assert!(lines.push(b"other", false).is_err());
    assert!(lines.next_row().unwrap().is_some());
    assert!(lines.push(b"other", false).is_err());
    assert_eq!(collect(&mut lines).len(), 1);
    lines.push(b"last", true).unwrap();
    assert_eq!(collect(&mut lines).len(), 1);
    assert!(lines.push(b"other", false).is_err());
}

#[test]
fn torn_final_bytes_are_not_decoded_by_the_framer() {
    use proseql_storage::append::{jsonl_tail_bytes, JsonlTail};
    let bytes = b"{\"id\":\"a\"}\n{\"id\":\"\xc3";
    let mut source = LineFramer::new(
        RandomChunks {
            bytes,
            seed: 12,
            max: 1,
        },
        0,
        0,
    );
    let rows = collect(&mut source);
    assert!(!rows[0].2);
    assert!(rows[1].2);
    assert!(matches!(
        jsonl_tail_bytes(&rows[1].1),
        JsonlTail::Torn { .. }
    ));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn fs_host_scans_100_mib_with_less_than_one_mib_of_buffers() {
    use proseql_storage::fs::FsStorageHost;
    use proseql_storage::host::StorageHost;
    use proseql_storage::readers::{HostChunks, DEFAULT_CHUNK_BYTES};
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.jsonl");
    let path = path.to_str().unwrap();
    // 1 KiB valid JSONL lines, exactly 100 MiB. No whole-file allocation.
    let line = format!("{{\"id\":\"{}\"}}\n", "x".repeat(1014));
    assert_eq!(line.len(), 1024);
    let mut file = std::fs::File::create(path).unwrap();
    for _ in 0..102400 {
        file.write_all(line.as_bytes()).unwrap();
    }
    drop(file);
    let host = FsStorageHost::new_polling(std::time::Duration::from_secs(1)).unwrap();
    let stat = host.stat(path).unwrap().unwrap();
    assert_eq!(stat.len, 100 * 1024 * 1024);
    assert!(stat.modified_ns.is_some());
    #[cfg(unix)]
    assert!(stat.change_id.is_some());
    let mut chunks = HostChunks::new(&host, path, 0);
    let mut total = 0;
    let mut max_chunk = 0;
    while let Some(chunk) = chunks.next_chunk().unwrap() {
        total += chunk.len();
        max_chunk = max_chunk.max(chunk.len());
    }
    assert_eq!(total, 100 * 1024 * 1024);
    assert_eq!(max_chunk, DEFAULT_CHUNK_BYTES);
    let mut source = LineFramer::new(HostChunks::new(&host, path, 0), 0, 0);
    let mut rows = 0;
    let mut max_framer = 0;
    while source.next_row().unwrap().is_some() {
        rows += 1;
        max_framer = max_framer.max(source.buffered_bytes());
    }
    assert_eq!(rows, 102400);
    // HostChunks replaces its Vec, so include an old and new host allocation
    // during refill as well as both measured framer buffers.
    let peak_buffers = max_framer + 2 * max_chunk;
    assert!(peak_buffers < 1024 * 1024);
    eprintln!("file_bytes={total} max_host_chunk={max_chunk} max_framer={max_framer} peak_buffers_upper_bound={peak_buffers}");
    assert_eq!(host.read_range(path, total as u64, 10).unwrap(), b"");
    assert_eq!(host.read_range(path, u64::MAX, 0).unwrap(), b"");
    assert!(host.stat(&format!("{path}.missing")).unwrap().is_none());
    let replacement = dir.path().join("replacement.jsonl");
    std::fs::write(&replacement, line.as_bytes()).unwrap();
    std::fs::rename(replacement, path).unwrap();
    assert_ne!(host.stat(path).unwrap().unwrap().change_id, stat.change_id);
}
