//! Disposable sidecars. Errors are cache misses, never source errors.
//! Scalars are little-endian; the checksum covers the header and payload.
use crate::generation::{GenerationCheck, SourceGeneration};
use crate::host::StorageHost;
use std::collections::BTreeMap;
use std::hash::Hasher;
use std::sync::{Arc, Mutex};

pub const DIRECTORY: &str = ".proseql-index";
const MAGIC: &[u8; 8] = b"PROSQLIX";
const FORMAT: u64 = 1;
// Bump when hashing, locator, validation or comparison semantics change.
const INDEX: u64 = 2;

pub fn hidden(path: &str) -> bool {
    path.split(['/', '\\']).any(|part| part == DIRECTORY)
}

pub fn checksum(bytes: &[u8]) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    hash.write(bytes);
    hash.finish()
}

pub fn prefix_hash(host: &dyn StorageHost, path: &str, len: u64) -> Option<u64> {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut offset = 0;
    while offset < len {
        let bytes = host
            .read_range(path, offset, (len - offset).min(65536) as usize)
            .ok()?;
        if bytes.is_empty() || bytes.len() as u64 > len - offset {
            return None;
        }
        offset += bytes.len() as u64;
        hash.write(&bytes);
    }
    Some(hash.finish())
}

#[derive(Clone, Debug)]
pub struct Store {
    root: String,
    fingerprint: u64,
    // One proof per path, bounded by the partition set. This never replaces
    // a fresh source-generation check; it only shares a checked hash read.
    prefixes: Arc<Mutex<BTreeMap<String, PrefixProof>>>,
}

#[derive(Clone, Debug)]
struct PrefixProof {
    current: SourceGeneration,
    len: u64,
    hash: u64,
}

pub struct Loaded {
    pub generation: SourceGeneration,
    pub payload: Vec<u8>,
    pub unchanged: bool,
}

pub fn put(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}
pub fn take(bytes: &mut &[u8]) -> Option<u64> {
    let (head, tail) = bytes.split_at_checked(8)?;
    *bytes = tail;
    Some(u64::from_le_bytes(head.try_into().ok()?))
}
fn blob<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = usize::try_from(take(bytes)?).ok()?;
    let (head, tail) = bytes.split_at_checked(len)?;
    *bytes = tail;
    Some(head)
}
fn put_blob(out: &mut Vec<u8>, bytes: &[u8]) {
    put(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

impl Store {
    pub fn new(root: String, fingerprint: u64) -> Self {
        Self {
            root,
            fingerprint,
            prefixes: Arc::default(),
        }
    }
    /// Isolate an attempt's checked-prefix memo from the committed store.
    /// Ordinary Clone deliberately continues to share that memo.
    pub fn fork(&self) -> Self {
        // A poisoned memo is disposable: rebuild it instead of carrying
        // uncertain cached evidence into an otherwise independent attempt.
        let prefixes = self
            .prefixes
            .lock()
            .map(|proofs| proofs.clone())
            .unwrap_or_default();
        Self {
            root: self.root.clone(),
            fingerprint: self.fingerprint,
            prefixes: Arc::new(Mutex::new(prefixes)),
        }
    }
    pub fn clear(&self) {
        if let Ok(mut proofs) = self.prefixes.lock() {
            proofs.clear();
        }
    }
    fn relative<'a>(&self, path: &'a str) -> Option<&'a str> {
        let relative = if self.root == "." && !std::path::Path::new(path).is_absolute() {
            path.strip_prefix("./").unwrap_or(path)
        } else {
            path.strip_prefix(self.root.trim_end_matches('/'))?
                .strip_prefix('/')?
        };
        if relative.is_empty()
            || relative
                .split('/')
                .any(|p| p == ".." || p == "." || p == DIRECTORY)
        {
            return None;
        }
        Some(relative)
    }
    pub fn path(&self, path: &str, kind: &str) -> Option<String> {
        if !kind.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return None;
        }
        Some(format!(
            "{}/{DIRECTORY}/{}.{}.idx",
            self.root.trim_end_matches('/'),
            self.relative(path)?,
            kind
        ))
    }
    pub fn load(
        &self,
        host: &dyn StorageHost,
        current: &SourceGeneration,
        kind: &str,
    ) -> Option<Loaded> {
        let mut bytes = host.read_index(&self.path(&current.path, kind)?)?;
        let (body, tail) = bytes.split_at_checked(bytes.len().checked_sub(8)?)?;
        if checksum(body) != u64::from_le_bytes(tail.try_into().ok()?) {
            return None;
        }
        let mut input = body;
        if input.get(..8)? != MAGIC {
            return None;
        }
        input = &input[8..];
        if take(&mut input)? != FORMAT
            || take(&mut input)? != INDEX
            || take(&mut input)? != self.fingerprint
        {
            return None;
        }
        if blob(&mut input)? != self.relative(&current.path)?.as_bytes() {
            return None;
        }
        let len = take(&mut input)?;
        let token = take(&mut input)?;
        let has_token = take(&mut input)?;
        if has_token > 1 {
            return None;
        }
        let low = take(&mut input)?;
        let high = take(&mut input)?;
        let has_modified = take(&mut input)?;
        if has_modified > 1 {
            return None;
        }
        let hash = take(&mut input)?;
        let payload = blob(&mut input)?;
        if !input.is_empty() {
            return None;
        }
        let payload_range = body.len() - payload.len()..body.len();
        let generation = SourceGeneration {
            path: current.path.clone(),
            covered_len: len,
            change_id: (has_token == 1).then_some(token),
            modified_ns: (has_modified == 1).then_some(u128::from(low) | (u128::from(high) << 64)),
            check_hash: (has_token == 0).then_some(hash),
        };
        let unchanged = &generation == current;
        if !unchanged {
            if current.covered_len <= len {
                return None;
            }
            let cached = self
                .prefixes
                .lock()
                .ok()?
                .get(&current.path)
                .is_some_and(|proof| {
                    proof.current == *current && proof.len == len && proof.hash == hash
                });
            if !cached && prefix_hash(host, &current.path, len)? != hash {
                return None;
            }
        }
        // Never attach cache bytes to an observation that changed during load.
        if current.check(host).ok()? != GenerationCheck::Unchanged {
            return None;
        }
        self.prefixes.lock().ok()?.insert(
            current.path.clone(),
            PrefixProof {
                current: current.clone(),
                len,
                hash,
            },
        );
        let payload_len = payload_range.len();
        bytes.copy_within(payload_range, 0);
        bytes.truncate(payload_len);
        Some(Loaded {
            generation,
            payload: bytes,
            unchanged,
        })
    }
    pub fn save(
        &self,
        host: &dyn StorageHost,
        generation: &SourceGeneration,
        kind: &str,
        payload: &[u8],
    ) {
        let Some(path) = self.path(&generation.path, kind) else {
            return;
        };
        if !host.supports_indexes() {
            return;
        }
        let cached = self.prefixes.lock().ok().and_then(|proofs| {
            proofs
                .get(&generation.path)
                .filter(|proof| proof.current == *generation && proof.len == generation.covered_len)
                .map(|proof| proof.hash)
        });
        let Some(hash) =
            cached.or_else(|| prefix_hash(host, &generation.path, generation.covered_len))
        else {
            return;
        };
        if generation.check(host).ok() != Some(GenerationCheck::Unchanged) {
            return;
        }
        if let Ok(mut proofs) = self.prefixes.lock() {
            proofs.insert(
                generation.path.clone(),
                PrefixProof {
                    current: generation.clone(),
                    len: generation.covered_len,
                    hash,
                },
            );
        }
        let mut out = MAGIC.to_vec();
        for scalar in [FORMAT, INDEX, self.fingerprint] {
            put(&mut out, scalar);
        }
        put_blob(
            &mut out,
            self.relative(&generation.path).unwrap().as_bytes(),
        );
        for scalar in [
            generation.covered_len,
            generation.change_id.unwrap_or(0),
            u64::from(generation.change_id.is_some()),
            generation.modified_ns.unwrap_or(0) as u64,
            (generation.modified_ns.unwrap_or(0) >> 64) as u64,
            u64::from(generation.modified_ns.is_some()),
            hash,
        ] {
            put(&mut out, scalar);
        }
        put_blob(&mut out, payload);
        let hash = checksum(&out);
        put(&mut out, hash);
        host.write_index_atomic(&path, &out);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::fs::FsStorageHost;
    use std::time::Duration;

    #[test]
    fn fork_copies_prefix_proofs_without_changing_shared_clone_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rows.jsonl");
        std::fs::write(&path, "{\"id\":\"a\"}\n").unwrap();
        let host = FsStorageHost::new_polling(Duration::from_secs(1)).unwrap();
        let generation = SourceGeneration::observe(&host, path.to_str().unwrap())
            .unwrap()
            .unwrap();
        let store = Store::new(dir.path().to_str().unwrap().into(), 7);
        store.save(&host, &generation, "valid", &[]);
        let before = format!("{store:?}");
        let fork = store.fork();
        assert_eq!(format!("{fork:?}"), before);
        assert!(!Arc::ptr_eq(&store.prefixes, &fork.prefixes));
        fork.clear();
        assert!(fork.prefixes.lock().unwrap().is_empty());
        assert_eq!(format!("{store:?}"), before);
        assert!(fork.load(&host, &generation, "valid").is_some());
        assert_eq!(format!("{store:?}"), before);
        let shared = store.clone();
        assert!(Arc::ptr_eq(&store.prefixes, &shared.prefixes));
        shared.clear();
        assert!(store.prefixes.lock().unwrap().is_empty());
        assert!(!fork.prefixes.lock().unwrap().is_empty());
    }
}
