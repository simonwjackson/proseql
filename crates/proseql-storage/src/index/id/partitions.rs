//! Custom codecs can change record identity and cardinality. Retain only
//! hashes and decoded row ordinals; verification re-decodes one partition.
use super::{id_error, EngineError, File, IdLocator, RowLocation, SourceGeneration, StorageHost};
use crate::generation::GenerationCheck;

impl IdLocator {
    /// Build ID-to-partition candidates from the registered codec's decoded
    /// identities. The decoder must return identities in its record order and
    /// must release payloads before returning; at most one partition is live.
    pub fn build_partitions(
        host: &dyn StorageHost,
        paths: &[String],
        decode: &mut impl FnMut(&str) -> Result<Vec<String>, EngineError>,
    ) -> Result<Self, EngineError> {
        let mut locator = Self {
            partitioned: true,
            ..Self::default()
        };
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
            locator.scan_partition(host, file, SourceGeneration::observe(host, path)?, decode)?;
        }
        locator.finish_partitions(decode)?;
        Ok(locator)
    }

    fn scan_partition(
        &mut self,
        host: &dyn StorageHost,
        file: u32,
        generation: Option<SourceGeneration>,
        decode: &mut impl FnMut(&str) -> Result<Vec<String>, EngineError>,
    ) -> Result<(), EngineError> {
        let path = self.files[file as usize].path.clone();
        self.entries.retain(|entry| entry.file != file);
        self.wide_rows.retain(|(index, _), _| *index != file);
        let ids = if generation.is_some() {
            decode(&path)?
        } else {
            Vec::new()
        };
        if let Some(generation) = &generation {
            if generation.check(host)? != GenerationCheck::Unchanged {
                return Err(crate::generation::changed(&path));
            }
        }
        let count = ids.len() as u64;
        for (ordinal, id) in ids.into_iter().enumerate() {
            // Internal offset is the decoded row ordinal, not a byte offset.
            // It makes overflow-row and hash-collision verification unique.
            self.entry(
                file,
                &id,
                RowLocation {
                    partition: file,
                    offset: ordinal as u64,
                    ordinal: ordinal as u64,
                },
            );
        }
        self.files[file as usize] = File {
            path,
            generation,
            rows: count,
            resume: 0,
            dirty: false,
        };
        Ok(())
    }

    fn finish_partitions(
        &mut self,
        decode: &mut impl FnMut(&str) -> Result<Vec<String>, EngineError>,
    ) -> Result<(), EngineError> {
        self.entries
            .sort_unstable_by_key(|entry| (entry.hash, entry.file, entry.offset));
        for (position, entry) in self.entries.iter().enumerate().skip(1) {
            if self.entries[position - 1].hash != entry.hash {
                continue;
            }
            let path = &self.files[entry.file as usize].path;
            let id = decoded_id(decode, path, entry.offset)?;
            let begin = self
                .entries
                .partition_point(|candidate| candidate.hash < entry.hash);
            for previous in &self.entries[begin..position] {
                if decoded_id(
                    decode,
                    &self.files[previous.file as usize].path,
                    previous.offset,
                )? == id
                {
                    let message = if previous.file == entry.file {
                        "Partition records need unique string IDs".into()
                    } else {
                        format!("Duplicate partition record '{id}'")
                    };
                    return Err(id_error(path, message));
                }
            }
        }
        Ok(())
    }

    /// Any changed generation, including append-only growth, re-decodes the
    /// affected partition: arbitrary codecs need not preserve prefix rows.
    pub fn refresh_partitions(
        &mut self,
        host: &dyn StorageHost,
        paths: &[String],
        decode: &mut impl FnMut(&str) -> Result<Vec<String>, EngineError>,
    ) -> Result<(), EngineError> {
        if !self.partitioned || !self.files.iter().map(|file| &file.path).eq(paths.iter()) {
            *self = Self::build_partitions(host, paths, decode)?;
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
            if !state.dirty
                && (check == GenerationCheck::Unchanged
                    || (check == GenerationCheck::Missing && state.generation.is_none()))
            {
                continue;
            }
            self.files[file].dirty = true;
            self.scan_partition(host, file as u32, generation, decode)?;
            changed = true;
        }
        if changed {
            if let Err(error) = self.finish_partitions(decode) {
                for file in &mut self.files {
                    file.dirty = true;
                }
                return Err(error);
            }
        }
        Ok(())
    }
}

fn decoded_id(
    decode: &mut impl FnMut(&str) -> Result<Vec<String>, EngineError>,
    path: &str,
    ordinal: u64,
) -> Result<String, EngineError> {
    let index = usize::try_from(ordinal).map_err(|_| crate::generation::changed(path))?;
    decode(path)?
        .into_iter()
        .nth(index)
        .ok_or_else(|| crate::generation::changed(path))
}
