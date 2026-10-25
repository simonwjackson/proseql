use super::rows;
use crate::generation::{GenerationCheck, SourceGeneration};
use crate::host::StorageHost;
use proseql_engine::errors::{EngineError, SourceConfigError};
use proseql_engine::scan::RowLocation;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;

mod partitions;

const APPEND_DELTA_LIMIT: usize = 4096;

#[derive(Deserialize)]
struct Identity<'a> {
    #[serde(borrow)]
    id: Cow<'a, str>,
}

/// Only this field is materialised; serde skips all record payload fields.
fn identity(bytes: &[u8]) -> Result<Cow<'_, str>, serde_json::Error> {
    match serde_json::from_slice::<Identity<'_>>(bytes) {
        Ok(row) => Ok(row.id),
        Err(error) => {
            // Struct decoding rejects repeated object keys; Value decoding
            // (the resident contract) keeps the last key. This rare fallback
            // also preserves escaped and repeated `id` field semantics.
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

// 24 B/row, independent of ID length. Wide row ordinals use the rare overflow
// table, never truncated values. No arbitrary file-size or row-count limit.
#[derive(Debug, Clone, Copy)]
struct Entry {
    hash: u64,
    offset: u64,
    file: u32,
    row: u32,
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
    wide_rows: HashMap<(u32, u64), u64>,
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
        let mut locator = Self::default();
        for path in paths {
            locator.add_file(host, path)?;
        }
        locator.finish(host)?;
        Ok(locator)
    }

    fn add_file(&mut self, host: &dyn StorageHost, path: &str) -> Result<(), EngineError> {
        let file = u32::try_from(self.files.len())
            .map_err(|_| id_error(path, "Too many partition files"))?;
        self.files.push(File {
            path: path.into(),
            generation: None,
            rows: 0,
            resume: 0,
            dirty: false,
        });
        self.scan_file(host, file, 0, 0, SourceGeneration::observe(host, path)?)
    }

    fn entry(&mut self, file: u32, id: &str, location: RowLocation) {
        let entry = self.make_entry(file, id, location);
        // Reserve in bounded steps. Appends use delta, never this base buffer.
        if self.entries.len() == self.entries.capacity() {
            self.entries.reserve_exact(APPEND_DELTA_LIMIT);
        }
        self.entries.push(entry);
    }

    fn make_entry(&mut self, file: u32, id: &str, location: RowLocation) -> Entry {
        let row = u32::try_from(location.ordinal).unwrap_or_else(|_| {
            self.wide_rows
                .insert((file, location.offset), location.ordinal);
            u32::MAX
        });
        Entry {
            hash: hash(id),
            offset: location.offset,
            file,
            row,
        }
    }

    fn merge_delta(&mut self) {
        if self.delta.is_empty() {
            return;
        }
        self.delta
            .sort_unstable_by_key(|entry| (entry.hash, entry.file, entry.offset));
        let base = std::mem::take(&mut self.entries);
        let delta = std::mem::take(&mut self.delta);
        // One exact allocation and linear merge; never sort the large base
        // once per touched partition or double its post-commit capacity.
        let mut merged = Vec::with_capacity(base.len() + delta.len());
        let mut base = base.into_iter().peekable();
        let mut delta = delta.into_iter().peekable();
        while let (Some(a), Some(b)) = (base.peek(), delta.peek()) {
            let next = if (a.hash, a.file, a.offset) <= (b.hash, b.file, b.offset) {
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

    fn scan_file(
        &mut self,
        host: &dyn StorageHost,
        file: u32,
        start: u64,
        first: u64,
        generation: Option<SourceGeneration>,
    ) -> Result<(), EngineError> {
        let path = self.files[file as usize].path.clone();
        // Drop any speculative after_commit entries in the suffix. The scan
        // below proves coverage, including appends by another process.
        self.entries
            .retain(|entry| entry.file != file || entry.offset < start);
        self.wide_rows
            .retain(|(index, offset), _| *index != file || *offset < start);
        let end = generation.as_ref().map_or(0, |g| g.covered_len);
        let mut count = first;
        let mut resume = end;
        rows::visit_lines(
            host,
            &path,
            start,
            end,
            first,
            |bytes, location, final_line| {
                let id = match identity(bytes) {
                    Ok(id) => id,
                    Err(_)
                        if final_line
                            && serde_json::from_slice::<serde_json::Value>(bytes).is_err() =>
                    {
                        resume = location.offset;
                        return Ok(());
                    }
                    Err(error) => {
                        if serde_json::from_slice::<serde_json::Value>(bytes).is_ok() {
                            return Err(id_error(
                                &path,
                                "Partition records need unique string IDs",
                            ));
                        }
                        return Err(rows::parse_error(error));
                    }
                };
                self.entry(file, &id, location);
                count += 1;
                // An unterminated valid record may be extended, not merely
                // followed by another line. Rebuild this file on future growth.
                if final_line {
                    resume = location.offset;
                }
                Ok(())
            },
        )?;
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
        self.entries
            .sort_unstable_by_key(|entry| (entry.hash, entry.file, entry.offset));
        for pair in self.entries.windows(2) {
            if pair[0].hash != pair[1].hash {
                continue;
            }
            // Do not mistake a hash collision for duplicate identity. Compare
            // every equal-hash candidate, including non-adjacent collisions.
            let begin = self
                .entries
                .partition_point(|entry| entry.hash < pair[1].hash);
            let id = rows::read_line(
                host,
                &self.files[pair[1].file as usize].path,
                pair[1].offset,
            )?;
            let id = identity(&id).map_err(rows::parse_error)?;
            for previous in &self.entries[begin..] {
                if previous.file == pair[1].file && previous.offset == pair[1].offset {
                    break;
                }
                let bytes = rows::read_line(
                    host,
                    &self.files[previous.file as usize].path,
                    previous.offset,
                )?;
                if identity(&bytes).map_err(rows::parse_error)? == id {
                    let message = if previous.file == pair[1].file {
                        "Partition records need unique string IDs".into()
                    } else {
                        format!("Duplicate partition record '{id}'")
                    };
                    return Err(id_error(&self.files[pair[1].file as usize].path, message));
                }
            }
        }
        Ok(())
    }

    /// Refresh before locate. Membership is exact after candidate verification;
    /// missing files are removed and edits rebuild only the affected files.
    pub fn refresh(&mut self, host: &dyn StorageHost, paths: &[String]) -> Result<(), EngineError> {
        if self.partitioned {
            return Err(crate::generation::changed(
                self.files.first().map_or("", |file| file.path.as_str()),
            ));
        }
        self.merge_delta();
        if !self.files.iter().map(|file| &file.path).eq(paths.iter()) {
            *self = Self::build(host, paths)?;
            return Ok(());
        }
        let mut changed = false;
        for file in 0..self.files.len() {
            let state = &self.files[file];
            let (check, generation) = match &state.generation {
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
            };
            if check == GenerationCheck::Unchanged && !state.dirty {
                continue;
            }
            if check == GenerationCheck::Missing && state.generation.is_none() && !state.dirty {
                continue;
            }
            changed = true;
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
            // Invalidate before scanning: if the scan fails, a later attempt
            // must rebuild rather than publish partially inserted metadata.
            self.files[file].dirty = true;
            if !append {
                self.entries.retain(|entry| entry.file as usize != file);
                self.wide_rows
                    .retain(|(index, _), _| *index as usize != file);
            }
            if let Err(error) = self.scan_file(host, file as u32, start, first, generation) {
                self.files[file].dirty = true;
                return Err(error);
            }
        }
        if changed {
            if let Err(error) = self.finish(host) {
                for file in &mut self.files {
                    file.dirty = true;
                }
                return Err(error);
            }
        }
        Ok(())
    }

    /// Ordinal may be `UNKNOWN_ORDINAL` for rows recorded by
    /// `record_appended` until the next refresh; use locations from `locate`
    /// for verification reads only, never for ordering. Custom codecs return
    /// `UNKNOWN_OFFSET`: verify by decoding that partition through its codec,
    /// never by reading an individual text line.
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
                let path = &self.files[entry.file as usize].path;
                let preceding = self.files.iter().filter(|file| file.path < *path);
                let first: u64 = preceding.clone().map(|file| file.rows).sum();
                let partition = preceding.count() as u32;
                let row = self
                    .wide_rows
                    .get(&(entry.file, entry.offset))
                    .copied()
                    .unwrap_or(u64::from(entry.row));
                let ordinal = if row == super::UNKNOWN_ORDINAL {
                    row
                } else {
                    first + row
                };
                (
                    path.clone(),
                    RowLocation {
                        partition,
                        offset: if self.partitioned {
                            super::UNKNOWN_OFFSET
                        } else {
                            entry.offset
                        },
                        ordinal,
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
            // A whole-partition codec can change old IDs when new text is
            // appended. Only its decoder can publish new membership.
            self.files[file as usize].dirty = true;
            return Ok(());
        }
        // Search the sorted base by hash and the small append delta linearly.
        for (id, location) in rows {
            // All row starts before resume are already covered, regardless
            // of the supplied ID. Newly recorded offsets use the rare-row
            // table until refresh, so repeats need no table-wide offset scan.
            if location.offset < self.files[file as usize].resume
                || self.wide_rows.get(&(file, location.offset)) == Some(&super::UNKNOWN_ORDINAL)
            {
                continue;
            }
            let key = hash(id);
            let begin = self.entries.partition_point(|entry| entry.hash < key);
            let present = self.entries[begin..]
                .iter()
                .take_while(|entry| entry.hash == key)
                .chain(self.delta.iter())
                .any(|entry| entry.file == file && entry.offset == location.offset);
            if !present {
                let entry = self.make_entry(
                    file,
                    id,
                    RowLocation {
                        partition: file,
                        offset: location.offset,
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
        // No host was passed: do not advance the checked generation, row
        // count or resume offset. Refresh scans the entire unverified suffix.
        Ok(())
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
            + self.wide_rows.capacity() * (std::mem::size_of::<((u32, u64), u64)>() + 1)
    }
}
