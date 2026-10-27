use super::rows;
use crate::generation::{GenerationCheck, SourceGeneration};
use crate::host::StorageHost;
use proseql_engine::errors::{EngineError, SourceConfigError};
use proseql_engine::scan::RowLocation;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};

mod partitions;

const APPEND_DELTA_LIMIT: usize = 4096;
const WIDE_FILE: u64 = 4095;
const WIDE_MARKER: u64 = WIDE_FILE << 52;
const MAX_SMALL_ROW: u64 = (1 << 20) - 1;
const SPECULATIVE_TAG: u64 = 1 << 51;

fn speculative_address(file: u32, offset: u64) -> Option<u64> {
    (file < (1 << 19) && offset <= u64::from(u32::MAX))
        .then_some(WIDE_MARKER | SPECULATIVE_TAG | (u64::from(file) << 32) | offset)
}

type SavedEntries = (u64, u64, Vec<(u64, u64, u64)>);

type RowVisitor<'a> = dyn FnMut(&str, &[u8], RowLocation, bool) -> Result<(), EngineError> + 'a;
type DecodedRowVisitor<'a> =
    dyn FnMut(&str, &[u8], RowLocation, bool) -> Result<Option<Box<str>>, EngineError> + 'a;

#[derive(Deserialize)]
struct Identity<'a> {
    #[serde(borrow)]
    id: Cow<'a, str>,
}

fn identity(bytes: &[u8]) -> Result<Cow<'_, str>, serde_json::Error> {
    match serde_json::from_slice::<Identity<'_>>(bytes) {
        Ok(row) => Ok(row.id),
        Err(error) => {
            // Preserve Value's last-key-wins semantics for repeated ID keys.
            let value: serde_json::Value = serde_json::from_slice(bytes)?;
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(|id| Cow::Owned(id.to_owned()))
                .ok_or(error)
        }
    }
}

fn hash(id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hash);
    hash.finish()
}

// Keep the full identity hash. Common locations need 12 file bits, 20 row
// bits and 32 offset bits. Larger locations use the sparse overflow table;
// no file size, partition count or ordinal is truncated.
#[derive(Debug, Clone, Copy)]
struct Entry {
    hash: u64,
    address: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Location {
    file: u32,
    offset: u64,
    row: u64,
}
fn location(entry: &Entry, wide: &HashMap<u64, Location>) -> Location {
    if entry.address >= WIDE_MARKER {
        wide[&entry.address]
    } else {
        Location {
            file: (entry.address >> 52) as u32,
            row: (entry.address >> 32) & MAX_SMALL_ROW,
            offset: entry.address & u64::from(u32::MAX),
        }
    }
}
fn entry_order(left: &Entry, right: &Entry, wide: &HashMap<u64, Location>) -> std::cmp::Ordering {
    left.hash.cmp(&right.hash).then_with(|| {
        // Overflow addresses are allocation keys, never source positions.
        // Decode only ties so duplicate errors retain file/offset precedence.
        let left = location(left, wide);
        let right = location(right, wide);
        (left.file, left.offset).cmp(&(right.file, right.offset))
    })
}

#[derive(Debug, Clone)]
struct File {
    path: String,
    generation: Option<SourceGeneration>,
    rows: u64,
    resume: u64,
    dirty: bool,
}
#[derive(Debug, Clone, Default)]
pub struct IdLocator {
    entries: Vec<Entry>,
    delta: Vec<Entry>,
    files: Vec<File>,
    wide: HashMap<u64, Location>,
    next_wide: u64,
    partitioned: bool,
}

pub fn id_error(path: &str, message: impl Into<String>) -> EngineError {
    EngineError::SourceConfig(Box::new(SourceConfigError {
        message: message.into(),
        source_id: None,
        collection: None,
        path: Some(path.into()),
    }))
}

impl IdLocator {
    pub fn build(host: &dyn StorageHost, paths: &[String]) -> Result<Self, EngineError> {
        Self::build_internal(host, paths, &BTreeMap::new(), &mut None, None)
    }
    pub fn build_visiting(
        host: &dyn StorageHost,
        paths: &[String],
        visit: &mut RowVisitor<'_>,
    ) -> Result<Self, EngineError> {
        Self::build_observed_decoded(
            host,
            paths,
            &BTreeMap::new(),
            &mut |path, bytes, row, last| {
                visit(path, bytes, row, last)?;
                Ok(None)
            },
        )
    }
    /// Reuse observations from the same operation. Scanned paths are checked
    /// again before publication; missing map entries receive fresh observations.
    pub fn build_observed_decoded(
        host: &dyn StorageHost,
        paths: &[String],
        observed: &BTreeMap<String, Option<SourceGeneration>>,
        visit: &mut DecodedRowVisitor<'_>,
    ) -> Result<Self, EngineError> {
        Self::build_internal(host, paths, observed, &mut Some(visit), None)
    }

    fn build_internal(
        host: &dyn StorageHost,
        paths: &[String],
        observed: &BTreeMap<String, Option<SourceGeneration>>,
        visit: &mut Option<&mut DecodedRowVisitor<'_>>,
        store: Option<&super::persist::Store>,
    ) -> Result<Self, EngineError> {
        let _build = crate::diagnostics::span("streaming_id_locator_build");
        let mut locator = Self::default();
        for path in paths {
            let file = u32::try_from(locator.files.len())
                .map_err(|_| id_error(path, "Too many partition files"))?;
            locator.files.push(File {
                path: path.clone(),
                generation: None,
                rows: 0,
                resume: 0,
                dirty: true,
            });
            let generation = match observed.get(path) {
                Some(generation) => generation.clone(),
                None => SourceGeneration::observe(host, path)?,
            };
            let loaded = generation.as_ref().and_then(|current| {
                store.and_then(|store| {
                    let ids = store.load(host, current, "ids")?;
                    // Before finish() reports duplicates, a validating build
                    // must visit every byte not covered by validation. An older
                    // valid prefix cannot authorize newer cached membership.
                    if visit.is_some() {
                        let valid = store.load(host, current, "valid")?;
                        if !valid.payload.is_empty()
                            || valid.generation.covered_len < ids.generation.covered_len
                        {
                            return None;
                        }
                    }
                    Some(ids)
                })
            });
            let mut position = (0, 0);
            if let Some(loaded) = loaded {
                if let Some((rows, resume, entries)) =
                    Self::decode_entries(&loaded.payload, loaded.generation.covered_len)
                {
                    for (hash, offset, ordinal) in entries {
                        let mut entry = locator.make_entry(
                            file,
                            "",
                            RowLocation {
                                partition: file,
                                offset,
                                ordinal,
                            },
                        );
                        entry.hash = hash;
                        locator.entries.push(entry);
                    }
                    locator.files[file as usize] = File {
                        path: path.clone(),
                        generation: generation.clone(),
                        rows,
                        resume,
                        dirty: false,
                    };
                    if loaded.unchanged {
                        continue;
                    }
                    if resume == loaded.generation.covered_len {
                        position = (resume, rows);
                    } else {
                        locator.remove_suffix(file, 0);
                    }
                }
            }
            locator.scan_file(host, file, position, generation, false, visit)?;
        }
        locator.finish(host)?;
        Ok(locator)
    }
    /// Restore per-file membership only after checking the source generation.
    pub fn build_persisted(
        host: &dyn StorageHost,
        paths: &[String],
        observed: &BTreeMap<String, Option<SourceGeneration>>,
        mut visit: Option<&mut DecodedRowVisitor<'_>>,
        store: &super::persist::Store,
    ) -> Result<Self, EngineError> {
        Self::build_internal(host, paths, observed, &mut visit, Some(store))
    }

    fn decode_entries(mut bytes: &[u8], len: u64) -> Option<SavedEntries> {
        use super::persist::take;
        let rows = take(&mut bytes)?;
        let resume = take(&mut bytes)?;
        let count = usize::try_from(take(&mut bytes)?).ok()?;
        if resume > len
            || count != bytes.len() / 24
            || !bytes.len().is_multiple_of(24)
            || count as u64 != rows
        {
            return None;
        }
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            let hash = take(&mut bytes)?;
            let offset = take(&mut bytes)?;
            let ordinal = take(&mut bytes)?;
            if offset >= len || ordinal >= rows {
                return None;
            }
            entries.push((hash, offset, ordinal));
        }
        Some((rows, resume, entries))
    }

    pub fn save(&self, host: &dyn StorageHost, store: &super::persist::Store) {
        use super::persist::put;
        if self.partitioned || !host.supports_indexes() {
            return;
        }
        let mut payloads = self
            .files
            .iter()
            .map(|file| {
                let mut out = Vec::new();
                put(&mut out, file.rows);
                put(&mut out, file.resume);
                put(&mut out, file.rows);
                out
            })
            .collect::<Vec<_>>();
        for entry in self.entries.iter().chain(&self.delta) {
            let pos = location(entry, &self.wide);
            if pos.row == super::UNKNOWN_ORDINAL {
                return;
            }
            let out = &mut payloads[pos.file as usize];
            put(out, entry.hash);
            put(out, pos.offset);
            put(out, pos.row);
        }
        for (file, payload) in self.files.iter().zip(payloads) {
            if !file.dirty {
                if let Some(generation) = &file.generation {
                    store.save(host, generation, "ids", &payload);
                }
            }
        }
    }

    fn entry(&mut self, file: u32, id: &str, row: RowLocation) {
        let entry = self.make_entry(file, id, row);
        if self.entries.len() == self.entries.capacity() {
            // Bound spare capacity to 1 MiB, without reallocating the entire
            // 10 MiB table once per 4,096 rows. Finish releases the spare space.
            let growth = self.entries.capacity().clamp(APPEND_DELTA_LIMIT, 64 * 1024);
            self.entries.reserve_exact(growth);
        }
        self.entries.push(entry);
    }
    fn make_entry(&mut self, file: u32, id: &str, row: RowLocation) -> Entry {
        let address = if u64::from(file) < WIDE_FILE
            && row.ordinal <= MAX_SMALL_ROW
            && row.offset <= u64::from(u32::MAX)
        {
            (u64::from(file) << 52) | (row.ordinal << 32) | row.offset
        } else {
            // Speculative common offsets have a deterministic tagged address,
            // so idempotence needs one lookup in this same overflow table.
            let speculative = if row.ordinal == super::UNKNOWN_ORDINAL {
                speculative_address(file, row.offset)
            } else {
                None
            };
            let address = if let Some(address) = speculative {
                address
            } else {
                // Freed general overflow addresses are reused. The tagged half
                // is reserved for deterministic speculative addresses.
                while self.wide.contains_key(&(WIDE_MARKER | self.next_wide)) {
                    self.next_wide += 1;
                }
                debug_assert!(self.next_wide < SPECULATIVE_TAG);
                let address = WIDE_MARKER | self.next_wide;
                self.next_wide += 1;
                address
            };
            self.wide.insert(
                address,
                Location {
                    file,
                    offset: row.offset,
                    row: row.ordinal,
                },
            );
            address
        };
        Entry {
            hash: hash(id),
            address,
        }
    }
    fn merge_delta(&mut self) {
        if self.delta.is_empty() {
            return;
        }
        self.delta
            .sort_unstable_by(|left, right| entry_order(left, right, &self.wide));
        let base = std::mem::take(&mut self.entries);
        let delta = std::mem::take(&mut self.delta);
        let mut merged = Vec::with_capacity(base.len() + delta.len());
        let mut base = base.into_iter().peekable();
        let mut delta = delta.into_iter().peekable();
        while let (Some(a), Some(b)) = (base.peek(), delta.peek()) {
            let next = if entry_order(a, b, &self.wide) != std::cmp::Ordering::Greater {
                base.next()
            } else {
                delta.next()
            };
            if let Some(entry) = next {
                merged.push(entry);
            }
        }
        merged.extend(base);
        merged.extend(delta);
        self.entries = merged;
    }
    fn remove_suffix(&mut self, file: u32, start: u64) {
        let keep = |entry: &Entry| {
            let pos = location(entry, &self.wide);
            pos.file != file || pos.offset < start
        };
        self.entries.retain(keep);
        self.delta.retain(keep);
        self.wide
            .retain(|_, pos| pos.file != file || pos.offset < start);
        self.next_wide = 0;
    }
    fn scan_file(
        &mut self,
        host: &dyn StorageHost,
        file: u32,
        position: (u64, u64),
        generation: Option<SourceGeneration>,
        clear: bool,
        visit: &mut Option<&mut DecodedRowVisitor<'_>>,
    ) -> Result<(), EngineError> {
        let (start, first) = position;
        let path = self.files[file as usize].path.clone();
        // A newly allocated file has no old entries. Retaining every prior
        // shard here made first-use construction O(files * rows).
        if clear {
            self.remove_suffix(file, start);
        }
        let end = generation.as_ref().map_or(0, |g| g.covered_len);
        let mut count = first;
        let mut resume = end;
        rows::visit_lines(host, &path, start, end, first, |bytes, row, final_line| {
            let decoded = match visit.as_mut() {
                Some(visit) => visit(&path, bytes, row, final_line)?,
                None => None,
            };
            let id = match decoded
                .map_or_else(|| identity(bytes), |id| Ok(Cow::Owned(id.into_string())))
            {
                Ok(id) => id,
                Err(_)
                    if final_line
                        && serde_json::from_slice::<serde_json::Value>(bytes).is_err() =>
                {
                    resume = row.offset;
                    return Ok(());
                }
                Err(error) => {
                    if serde_json::from_slice::<serde_json::Value>(bytes).is_ok() {
                        return Err(id_error(&path, "Partition records need unique string IDs"));
                    }
                    return Err(rows::parse_error(error));
                }
            };
            self.entry(file, &id, row);
            count += 1;
            if final_line {
                resume = row.offset;
            }
            Ok(())
        })?;
        if let Some(generation) = &generation {
            if generation.check(host)? != GenerationCheck::Unchanged {
                return Err(crate::generation::changed(&path));
            }
        }
        self.files[file as usize] = File {
            path,
            generation,
            rows: count,
            resume,
            dirty: false,
        };
        Ok(())
    }
    fn finish(&mut self, host: &dyn StorageHost) -> Result<(), EngineError> {
        let _sort = crate::diagnostics::span("streaming_id_locator_finish");
        self.entries
            .sort_unstable_by(|left, right| entry_order(left, right, &self.wide));
        for (position, entry) in self.entries.iter().enumerate().skip(1) {
            if self.entries[position - 1].hash != entry.hash {
                continue;
            }
            let current = location(entry, &self.wide);
            let path = &self.files[current.file as usize].path;
            let bytes = rows::read_line(host, path, current.offset)?;
            let id = identity(&bytes).map_err(rows::parse_error)?;
            let begin = self
                .entries
                .partition_point(|candidate| candidate.hash < entry.hash);
            for previous in &self.entries[begin..position] {
                let previous = location(previous, &self.wide);
                let bytes = rows::read_line(
                    host,
                    &self.files[previous.file as usize].path,
                    previous.offset,
                )?;
                if identity(&bytes).map_err(rows::parse_error)? == id {
                    let message = if previous.file == current.file {
                        "Partition records need unique string IDs".into()
                    } else {
                        format!("Duplicate partition record '{id}'")
                    };
                    return Err(id_error(path, message));
                }
            }
        }
        self.entries.shrink_to_fit();
        Ok(())
    }
    /// Refresh before locate. A verified candidate supplies exact identity;
    /// current generations guarantee that membership has no false negatives.
    pub fn refresh(&mut self, host: &dyn StorageHost, paths: &[String]) -> Result<(), EngineError> {
        self.refresh_internal(host, paths, &BTreeMap::new(), &mut None)
    }
    pub fn refresh_visiting(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        visit: &mut RowVisitor<'_>,
    ) -> Result<(), EngineError> {
        self.refresh_observed_decoded(
            host,
            paths,
            &BTreeMap::new(),
            &mut |path, bytes, row, last| {
                visit(path, bytes, row, last)?;
                Ok(None)
            },
        )
    }
    pub fn refresh_observed_decoded(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        observed: &BTreeMap<String, Option<SourceGeneration>>,
        visit: &mut DecodedRowVisitor<'_>,
    ) -> Result<(), EngineError> {
        self.refresh_internal(host, paths, observed, &mut Some(visit))
    }

    fn refresh_internal(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        observed: &BTreeMap<String, Option<SourceGeneration>>,
        visit: &mut Option<&mut DecodedRowVisitor<'_>>,
    ) -> Result<(), EngineError> {
        if self.partitioned {
            return Err(crate::generation::changed(
                self.files.first().map_or("", |file| file.path.as_str()),
            ));
        }
        // Do not merge an append delta unless a file actually needs rescanning.
        if !self.files.iter().map(|file| &file.path).eq(paths.iter()) {
            *self = Self::build_internal(host, paths, observed, visit, None)?;
            return Ok(());
        }
        let mut changed = false;
        for file in 0..self.files.len() {
            let state = &self.files[file];
            let (check, generation) = if let Some(generation) = observed.get(&state.path) {
                let check = if generation == &state.generation {
                    if generation.is_some() {
                        GenerationCheck::Unchanged
                    } else {
                        GenerationCheck::Missing
                    }
                } else if generation.is_none() {
                    GenerationCheck::Missing
                } else {
                    GenerationCheck::Replaced
                };
                (check, generation.clone())
            } else {
                match &state.generation {
                    Some(generation) => generation.advance(host)?,
                    None => {
                        let generation = SourceGeneration::observe(host, &state.path)?;
                        (
                            if generation.is_some() {
                                GenerationCheck::Replaced
                            } else {
                                GenerationCheck::Missing
                            },
                            generation,
                        )
                    }
                }
            };
            if !state.dirty
                && (check == GenerationCheck::Unchanged
                    || (check == GenerationCheck::Missing && state.generation.is_none()))
            {
                continue;
            }
            let append = matches!(check, GenerationCheck::Appended { .. })
                && !state.dirty
                && state
                    .generation
                    .as_ref()
                    .is_some_and(|g| state.resume == g.covered_len);
            let (start, first) = if append {
                (state.resume, state.rows)
            } else {
                (0, 0)
            };
            self.files[file].dirty = true;
            if let Err(error) =
                self.scan_file(host, file as u32, (start, first), generation, true, visit)
            {
                self.files[file].dirty = true;
                return Err(error);
            }
            changed = true;
        }
        if changed {
            self.merge_delta();
            if let Err(error) = self.finish(host) {
                for file in &mut self.files {
                    file.dirty = true;
                }
                return Err(error);
            }
        }
        Ok(())
    }
    /// Recorded speculative rows have UNKNOWN_ORDINAL until refresh. Custom
    /// codec candidates have UNKNOWN_OFFSET and require partition decoding.
    pub fn locate(&self, id: &str) -> Result<Vec<(String, RowLocation)>, EngineError> {
        if let Some(file) = self.files.iter().find(|file| file.dirty) {
            return Err(crate::generation::changed(&file.path));
        }
        let key = hash(id);
        let begin = self.entries.partition_point(|entry| entry.hash < key);
        Ok(self.entries[begin..]
            .iter()
            .take_while(|entry| entry.hash == key)
            .chain(self.delta.iter().filter(|entry| entry.hash == key))
            .map(|entry| {
                let pos = location(entry, &self.wide);
                let path = &self.files[pos.file as usize].path;
                let preceding = self.files.iter().filter(|file| file.path < *path);
                let first: u64 = preceding.clone().map(|file| file.rows).sum();
                (
                    path.clone(),
                    RowLocation {
                        partition: preceding.count() as u32,
                        offset: if self.partitioned {
                            super::UNKNOWN_OFFSET
                        } else {
                            pos.offset
                        },
                        ordinal: if pos.row == super::UNKNOWN_ORDINAL {
                            pos.row
                        } else {
                            first + pos.row
                        },
                    },
                )
            })
            .collect())
    }
    pub fn record_appended(
        &mut self,
        path: &str,
        rows: &[(String, RowLocation)],
    ) -> Result<(), EngineError> {
        let file = match self.files.iter().position(|file| file.path == path) {
            Some(file) => file as u32,
            None => {
                let index = u32::try_from(self.files.len())
                    .map_err(|_| id_error(path, "Too many partition files"))?;
                self.files.push(File {
                    path: path.into(),
                    generation: None,
                    rows: 0,
                    resume: 0,
                    dirty: false,
                });
                index
            }
        };
        if self.partitioned {
            self.files[file as usize].dirty = true;
            return Ok(());
        }
        for (id, row) in rows {
            if row.offset < self.files[file as usize].resume
                || match speculative_address(file, row.offset) {
                    Some(address) => self.wide.contains_key(&address),
                    None => self.wide.values().any(|pos| {
                        pos.file == file
                            && pos.offset == row.offset
                            && pos.row == super::UNKNOWN_ORDINAL
                    }),
                }
            {
                continue;
            }
            let key = hash(id);
            let begin = self.entries.partition_point(|entry| entry.hash < key);
            // Every speculative delta/base entry is already covered by the
            // overflow-address lookup above. Checked delta rows are before
            // resume. Only an old unterminated base row can still coincide.
            let present = self.entries[begin..]
                .iter()
                .take_while(|entry| entry.hash == key)
                .any(|entry| {
                    let pos = location(entry, &self.wide);
                    pos.file == file && pos.offset == row.offset
                });
            if !present {
                let entry = self.make_entry(
                    file,
                    id,
                    RowLocation {
                        partition: file,
                        offset: row.offset,
                        ordinal: super::UNKNOWN_ORDINAL,
                    },
                );
                if self.delta.len() == self.delta.capacity() {
                    self.delta
                        .reserve_exact(APPEND_DELTA_LIMIT - self.delta.len());
                }
                self.delta.push(entry);
                if self.delta.len() >= APPEND_DELTA_LIMIT {
                    self.merge_delta();
                }
            }
        }
        Ok(())
    }
    /// Publish an own append only after the caller proved the complete text
    /// equals the accepted append baseline, under this checked generation.
    /// A metadata observation alone is not proof of an unchanged old prefix.
    pub fn accept_appended(
        &mut self,
        generation: SourceGeneration,
        start: u64,
        rows: &[(String, RowLocation)],
    ) -> Result<(), EngineError> {
        if self.partitioned {
            if start <= generation.covered_len
                && self
                    .files
                    .iter()
                    .any(|file| !file.dirty && file.generation.as_ref() == Some(&generation))
            {
                return Ok(());
            }
            return self.record_appended(&generation.path, rows);
        }
        let file = match self
            .files
            .iter()
            .position(|file| file.path == generation.path)
        {
            Some(file) => file,
            None if start == 0 => {
                let file = self.files.len();
                u32::try_from(file)
                    .map_err(|_| id_error(&generation.path, "Too many partition files"))?;
                self.files.push(File {
                    path: generation.path.clone(),
                    generation: None,
                    rows: 0,
                    resume: 0,
                    dirty: false,
                });
                file
            }
            None => return Err(crate::generation::changed(&generation.path)),
        };
        if self.files[file].dirty || start > generation.covered_len {
            return Err(crate::generation::changed(&generation.path));
        }
        // Publication can be retried after success, including after a delta
        // merge. Coverage already includes these bytes; never dirty or add it twice.
        if self.files[file].generation.as_ref() == Some(&generation) {
            return Ok(());
        }
        // Unterminated/torn records may start before the kept prefix. Rebuild
        // instead of retaining a stale old identity at that offset.
        if self.files[file]
            .generation
            .as_ref()
            .is_some_and(|old| self.files[file].resume != old.covered_len)
        {
            self.files[file].dirty = true;
            return Ok(());
        }
        let first = self.files[file].rows;
        if self.files[file]
            .generation
            .as_ref()
            .is_some_and(|old| old.covered_len != start)
        {
            self.files[file].dirty = true;
            return Ok(());
        }
        if self.wide.values().any(|pos| {
            pos.file as usize == file && pos.offset >= start && pos.row == super::UNKNOWN_ORDINAL
        }) {
            self.remove_suffix(file as u32, start);
        }
        for (ordinal, (id, row)) in rows.iter().enumerate() {
            let entry = self.make_entry(
                file as u32,
                id,
                RowLocation {
                    ordinal: first + ordinal as u64,
                    ..*row
                },
            );
            self.delta.push(entry);
        }
        self.files[file].rows = first + rows.len() as u64;
        self.files[file].resume = generation.covered_len;
        self.files[file].generation = Some(generation);
        if self.delta.len() >= APPEND_DELTA_LIMIT {
            self.merge_delta();
        }
        Ok(())
    }
    /// Generation used to prove this path's membership. Callers can check it
    /// around candidate decoding to reject an intervening edit.
    pub fn generation_for(&self, path: &str) -> Option<&SourceGeneration> {
        self.files
            .iter()
            .find(|file| file.path == path && !file.dirty)
            .and_then(|file| file.generation.as_ref())
    }

    pub fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + (self.entries.capacity() + self.delta.capacity()) * std::mem::size_of::<Entry>()
            + self.files.capacity() * std::mem::size_of::<File>()
            + self
                .files
                .iter()
                .map(|file| {
                    file.path.capacity() + file.generation.as_ref().map_or(0, |g| g.path.capacity())
                })
                .sum::<usize>()
            + self.wide.capacity() * (std::mem::size_of::<(u64, Location)>() + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_hash_delta_sort_and_merge_use_decoded_source_positions() {
        let mut locator = IdLocator::default();
        let first = locator.make_entry(
            0,
            "same",
            RowLocation {
                partition: 0,
                offset: 0,
                ordinal: 0,
            },
        );
        let later_file = locator.make_entry(
            1,
            "same",
            RowLocation {
                partition: 1,
                offset: 0,
                ordinal: 0,
            },
        );
        let overflow = locator.make_entry(
            0,
            "same",
            RowLocation {
                partition: 0,
                offset: u64::from(u32::MAX) + 1,
                ordinal: MAX_SMALL_ROW + 1,
            },
        );
        locator.entries.push(first);
        locator.delta = vec![later_file, overflow];
        locator.merge_delta();
        let positions = locator
            .entries
            .iter()
            .map(|entry| {
                let row = location(entry, &locator.wide);
                (row.file, row.offset)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            positions,
            vec![(0, 0), (0, u64::from(u32::MAX) + 1), (1, 0)]
        );
    }

    #[test]
    fn compact_locations_and_all_overflow_dimensions_round_trip() {
        assert_eq!(std::mem::size_of::<Entry>(), 16);
        let mut locator = IdLocator::default();
        for (file, offset, ordinal) in [
            (0, 0, 0),
            (4094, u64::from(u32::MAX), MAX_SMALL_ROW),
            (4095, 1, 1),
            (u32::MAX, 1, 1),
            (0, u64::from(u32::MAX) + 1, 1),
            (0, 1, MAX_SMALL_ROW + 1),
            (0, u64::MAX, u64::MAX),
            (0, 0, super::super::UNKNOWN_ORDINAL),
            (
                (1 << 19) - 1,
                u64::from(u32::MAX),
                super::super::UNKNOWN_ORDINAL,
            ),
            (1 << 19, 0, super::super::UNKNOWN_ORDINAL),
        ] {
            let entry = locator.make_entry(
                file,
                "id",
                RowLocation {
                    partition: file,
                    offset,
                    ordinal,
                },
            );
            assert_eq!(
                location(&entry, &locator.wide),
                Location {
                    file,
                    offset,
                    row: ordinal
                }
            );
        }
        assert_eq!(
            locator.wide.len(),
            8,
            "general and speculative addresses must not overlap"
        );
    }
}
