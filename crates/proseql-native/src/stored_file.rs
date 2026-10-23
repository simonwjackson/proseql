//! Source conflict baselines. Rewrites retain exact bytes. Lazy append files
//! retain the existing length+tail conflict contract and a whole-file watcher
//! fingerprint, not another partition-sized source buffer.
use crate::lazy::FileFingerprint;
use proseql_storage::append::{plan_append, PlannedAppend, TornLineDiagnostic};
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
        *tail = suffix(data);
    } else {
        let discard = (tail.len() + data.len()).saturating_sub(APPEND_CONFLICT_TAIL);
        tail.drain(..discard);
        tail.extend_from_slice(data);
    }
}

impl StoredFile {
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
