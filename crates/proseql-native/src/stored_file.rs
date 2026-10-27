//! Source conflict baselines. Rewrites retain exact bytes. Lazy append files
//! retain the existing length+tail conflict contract and a whole-file watcher
//! fingerprint, not another partition-sized source buffer.
use crate::lazy::FileFingerprint;
use proseql_engine::errors::EngineError;
use proseql_storage::append::{
    jsonl_tail_bytes, plan_append, JsonlTail, PlannedAppend, TornLineDiagnostic,
};
use proseql_storage::host::StorageHost;
use std::{collections::hash_map::DefaultHasher, hash::Hasher};

pub(crate) const APPEND_CONFLICT_TAIL: usize = 4096;

#[derive(Clone)]
pub(crate) enum StoredFile {
    Full(Vec<u8>),
    Append(Box<AppendBaseline>),
}

#[derive(Clone)]
pub(crate) struct AppendBaseline {
    len: usize,
    tail: Vec<u8>,
    keep_len: usize,
    kept_tail: Vec<u8>,
    kept_hash: DefaultHasher,
    fingerprint: FileFingerprint,
    unterminated: bool,
}

impl Default for StoredFile {
    fn default() -> Self {
        Self::Full(Vec::new())
    }
}
impl From<Vec<u8>> for StoredFile {
    fn from(bytes: Vec<u8>) -> Self {
        Self::Full(bytes)
    }
}

fn suffix(bytes: &[u8]) -> Vec<u8> {
    bytes[bytes.len().saturating_sub(APPEND_CONFLICT_TAIL)..].to_vec()
}
fn extend_tail(tail: &mut Vec<u8>, data: &[u8]) {
    if data.len() >= APPEND_CONFLICT_TAIL {
        tail.clear();
        tail.extend_from_slice(&data[data.len() - APPEND_CONFLICT_TAIL..]);
    } else {
        let discard = (tail.len() + data.len()).saturating_sub(APPEND_CONFLICT_TAIL);
        tail.drain(..discard);
        tail.extend_from_slice(data);
    }
}

/// Build a resumable hash and conflict tails without retaining the partition.
/// Only the final physical line can grow beyond the fixed chunk/tail buffers.
#[derive(Default)]
struct AppendBuilder {
    len: usize,
    tail: Vec<u8>,
    hash: DefaultHasher,
    keep_len: usize,
    kept_tail: Vec<u8>,
    kept_hash: DefaultHasher,
    final_line: Vec<u8>,
}

impl AppendBuilder {
    fn push(&mut self, bytes: &[u8]) {
        if let Some(last) = bytes.iter().rposition(|byte| *byte == b'\n') {
            let complete = &bytes[..=last];
            self.hash.write(complete);
            extend_tail(&mut self.tail, complete);
            self.keep_len = self.len + complete.len();
            self.kept_hash = self.hash.clone();
            self.kept_tail.clone_from(&self.tail);
            self.final_line.clear();
            self.final_line.extend_from_slice(&bytes[last + 1..]);
            self.hash.write(&bytes[last + 1..]);
            extend_tail(&mut self.tail, &bytes[last + 1..]);
        } else {
            self.hash.write(bytes);
            extend_tail(&mut self.tail, bytes);
            self.final_line.extend_from_slice(bytes);
        }
        self.len += bytes.len();
    }

    fn finish(self, path: &str, newlines: usize) -> (StoredFile, Option<TornLineDiagnostic>) {
        let torn = matches!(jsonl_tail_bytes(&self.final_line), JsonlTail::Torn { .. });
        let diagnostic = torn.then(|| TornLineDiagnostic {
            path: path.into(),
            line: newlines + 1,
            bytes: self.len - self.keep_len,
            message: format!(
                "Ignored an interrupted append in '{path}'; the next append removes it"
            ),
        });
        let fingerprint = FileFingerprint::from_hash(self.len, self.hash.finish());
        let (keep_len, kept_tail, kept_hash) = if torn {
            (self.keep_len, self.kept_tail, self.kept_hash)
        } else {
            (self.len, self.tail.clone(), self.hash)
        };
        (
            StoredFile::Append(Box::new(AppendBaseline {
                len: self.len,
                tail: self.tail,
                keep_len,
                kept_tail,
                kept_hash,
                fingerprint,
                unterminated: !torn && !self.final_line.is_empty(),
            })),
            diagnostic,
        )
    }
}

impl StoredFile {
    pub fn append_stream(
        host: &dyn StorageHost,
        path: &str,
    ) -> Result<(Self, Option<TornLineDiagnostic>), EngineError> {
        let mut builder = AppendBuilder::default();
        host.visit_bytes(path, &mut |bytes| {
            builder.push(bytes);
            Ok(())
        })?;
        // Counting physical lines is needed only for a torn diagnostic. Do not
        // add another byte scan to every healthy target's baseline preparation.
        let mut newlines = 0;
        if matches!(
            jsonl_tail_bytes(&builder.final_line),
            JsonlTail::Torn { .. }
        ) {
            let before = host.stat(path)?;
            let mut remaining = builder.len;
            let mut extra = false;
            let mut hash = DefaultHasher::new();
            host.visit_bytes(path, &mut |bytes| {
                extra |= bytes.len() > remaining;
                let bytes = &bytes[..bytes.len().min(remaining)];
                remaining -= bytes.len();
                hash.write(bytes);
                newlines += bytes.iter().filter(|byte| **byte == b'\n').count();
                Ok(())
            })?;
            if before.is_none_or(|stat| stat.len != builder.len as u64)
                || remaining != 0
                || extra
                || hash.finish() != builder.hash.finish()
                || host.stat(path)? != before
            {
                return Err(crate::operation_error(
                    "source-changed",
                    format!("File '{path}' changed since load; reload before retrying"),
                ));
            }
        }
        Ok(builder.finish(path, newlines))
    }

    pub fn append(bytes: &[u8], torn: Option<&TornLineDiagnostic>) -> Self {
        let keep_len = torn.map_or(bytes.len(), |torn| bytes.len() - torn.bytes);
        let mut kept_hash = DefaultHasher::new();
        kept_hash.write(&bytes[..keep_len]);
        let fingerprint = if keep_len == bytes.len() {
            FileFingerprint::from_hash(bytes.len(), kept_hash.finish())
        } else {
            FileFingerprint::of(bytes)
        };
        Self::Append(Box::new(AppendBaseline {
            len: bytes.len(),
            tail: suffix(bytes),
            keep_len,
            kept_tail: suffix(&bytes[..keep_len]),
            kept_hash,
            fingerprint,
            unterminated: torn.is_none() && !bytes.is_empty() && !bytes.ends_with(b"\n"),
        }))
    }
    pub fn len(&self) -> usize {
        match self {
            Self::Full(bytes) => bytes.len(),
            Self::Append(baseline) => baseline.len,
        }
    }
    pub fn ends_with(&self, tail: &[u8]) -> bool {
        match self {
            Self::Full(bytes) => bytes.ends_with(tail),
            Self::Append(baseline) => baseline.tail.ends_with(tail),
        }
    }
    pub fn matches(&self, bytes: &[u8]) -> bool {
        match self {
            Self::Full(stored) => stored == bytes,
            Self::Append(baseline) => baseline.fingerprint == FileFingerprint::of(bytes),
        }
    }
    pub fn fingerprint(&self) -> FileFingerprint {
        match self {
            Self::Full(bytes) => FileFingerprint::of(bytes),
            Self::Append(baseline) => baseline.fingerprint,
        }
    }
    pub fn plan(&self, path: &str, lines: String) -> PlannedAppend {
        match self {
            Self::Full(bytes) => plan_append(path, bytes, lines),
            Self::Append(baseline) => PlannedAppend {
                path: path.to_owned(),
                keep_len: baseline.keep_len as u64,
                data: if baseline.unterminated {
                    format!("\n{lines}")
                } else {
                    lines
                },
            },
        }
    }
    pub fn apply(&mut self, append: &PlannedAppend) {
        match self {
            Self::Full(bytes) => {
                bytes.truncate(append.keep_len as usize);
                bytes.extend_from_slice(append.data.as_bytes());
            }
            Self::Append(baseline) => {
                debug_assert_eq!(baseline.keep_len as u64, append.keep_len);
                baseline.kept_hash.write(append.data.as_bytes());
                extend_tail(&mut baseline.kept_tail, append.data.as_bytes());
                baseline.len = append.keep_len as usize + append.data.len();
                baseline.keep_len = baseline.len;
                baseline.tail.clone_from(&baseline.kept_tail);
                baseline.fingerprint =
                    FileFingerprint::from_hash(baseline.len, baseline.kept_hash.finish());
                baseline.unterminated = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proseql_storage::append::{jsonl_tail_bytes, JsonlTail};

    #[test]
    fn streamed_baselines_match_captured_bytes_across_chunk_boundaries() {
        let long = format!("{{\"id\":\"{}\"}}", "x".repeat(2 * 65536 + 7));
        let cases = [
            Vec::new(),
            b"\n\n".to_vec(),
            b"{\"id\":\"a\"}\n".to_vec(),
            b"{\"id\":\"a\"}".to_vec(),
            b"{\"id\":\"a\"}\n{\"id\":".to_vec(),
            b"\n{\"id\":\"a\"}\n{\"id\":\"\xc3".to_vec(),
            format!("{long}\n{{\"id\":").into_bytes(),
            format!("{{\"id\":\"a\"}}\n{{\"id\":\"{}", "x".repeat(65536 + 17)).into_bytes(),
            format!("{long}\n{long}").into_bytes(),
            format!("{long}\n{long}\n").into_bytes(),
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rows.jsonl");
        let host =
            proseql_storage::fs::FsStorageHost::new_polling(std::time::Duration::from_secs(3600))
                .unwrap();
        for raw in cases {
            let torn = match jsonl_tail_bytes(&raw) {
                JsonlTail::Torn { keep, line } => Some(TornLineDiagnostic {
                    path: "file".into(),
                    line,
                    bytes: raw.len() - keep,
                    message: String::new(),
                }),
                _ => None,
            };
            std::fs::write(&path, &raw).unwrap();
            let (actual, diagnostic) =
                StoredFile::append_stream(&host, path.to_str().unwrap()).unwrap();
            assert_eq!(
                actual.fingerprint(),
                StoredFile::append(&raw, torn.as_ref()).fingerprint()
            );
            assert_eq!(
                diagnostic.as_ref().map(|d| (d.line, d.bytes)),
                torn.as_ref().map(|d| (d.line, d.bytes))
            );
            for size in [1, 7, 4096, 65535, 65536, 65537] {
                let mut builder = AppendBuilder::default();
                for bytes in raw.chunks(size) {
                    builder.push(bytes);
                }
                let (mut streamed, diagnostic) =
                    builder.finish("file", raw.iter().filter(|byte| **byte == b'\n').count());
                let mut captured = StoredFile::append(&raw, torn.as_ref());
                assert_eq!(
                    diagnostic.as_ref().map(|d| (d.line, d.bytes)),
                    torn.as_ref().map(|d| (d.line, d.bytes))
                );
                for lines in ["{\"id\":\"new\"}\n", "{\"id\":\"next\"}\n"] {
                    assert_eq!(streamed.len(), captured.len());
                    assert_eq!(streamed.fingerprint(), captured.fingerprint());
                    let StoredFile::Append(expected) = &captured else {
                        unreachable!()
                    };
                    assert!(streamed.ends_with(&expected.tail));
                    let plan = streamed.plan("file", lines.into());
                    assert_eq!(plan, captured.plan("file", lines.into()));
                    streamed.apply(&plan);
                    captured.apply(&plan);
                }
            }
        }
    }

    #[test]
    fn compact_baselines_plan_and_track_identical_bytes_through_repeated_appends() {
        for raw in [
            b"".as_slice(),
            b"{\"id\":\"a\"}\n",
            b"{\"id\":\"a\"}",
            b"{\"id\":\"a\"}\n{\"id\":",
            b"{\"id\":\"a\"}\n{\"id\":\"\xc3",
        ] {
            let torn = match jsonl_tail_bytes(raw) {
                JsonlTail::Torn { keep, line } => Some(TornLineDiagnostic {
                    path: "file".into(),
                    line,
                    bytes: raw.len() - keep,
                    message: String::new(),
                }),
                _ => None,
            };
            let mut compact = StoredFile::append(raw, torn.as_ref());
            let mut full = raw.to_vec();
            for size in [1, 4, 4000, 4096, 10000, 1] {
                let data = format!("{{\"id\":\"{}\"}}\n", "x".repeat(size));
                let expected = plan_append("file", &full, data.clone());
                let planned = compact.plan("file", data);
                assert_eq!(planned, expected);
                compact.apply(&planned);
                full.truncate(planned.keep_len as usize);
                full.extend_from_slice(planned.data.as_bytes());
                assert_eq!(compact.len(), full.len());
                assert!(compact.matches(&full));
                assert!(compact.ends_with(&suffix(&full)));
                let mut edited = full.clone();
                edited[0] = b'!';
                assert!(
                    !compact.matches(&edited),
                    "watch hash detects prefix edits, not only tail edits"
                );
                if let StoredFile::Append(baseline) = &compact {
                    assert!(baseline.tail.len() <= 4096);
                    assert!(baseline.kept_tail.len() <= 4096);
                }
            }
        }
    }
}
