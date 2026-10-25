//! Throwaway scalar JSONL scan. No production call site imports this module.
use crate::{
    fixture,
    query::{Answer, Query},
    Error,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct Row<'a> {
    #[serde(borrow)]
    id: Cow<'a, str>,
    #[serde(borrow)]
    metric: Cow<'a, str>,
    #[serde(borrow, rename = "atUtc")]
    at: Cow<'a, str>,
    value: f64,
}
#[derive(Serialize, Deserialize)]
struct Index {
    len: u64,
    modified: (i64, i64),
    ordered: bool,
    entries: Vec<(String, u64)>,
}
fn sidecar(path: &Path) -> PathBuf {
    path.with_extension("sparse.json")
}
fn fingerprint(path: &Path) -> Result<(u64, (i64, i64)), Error> {
    let m = fs::metadata(path)?;
    Ok((m.len(), (m.mtime(), m.mtime_nsec())))
}

pub fn build_index(path: &Path) -> Result<(), Error> {
    let (len, modified) = fingerprint(path)?;
    let mut index = Index {
        len,
        modified,
        ordered: true,
        entries: Vec::new(),
    };
    let mut reader = BufReader::new(File::open(path)?);
    let mut line = String::new();
    let mut offset = 0;
    let mut row_no = 0usize;
    let mut previous = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        let row: Row<'_> = serde_json::from_str(&line)?;
        if row.at.as_ref() < previous.as_str() {
            index.ordered = false;
        }
        if row_no.is_multiple_of(256) {
            index.entries.push((row.at.to_string(), offset));
        }
        previous.clear();
        previous.push_str(&row.at);
        row_no += 1;
        offset += n as u64;
    }
    let temp = path.with_extension("sparse.pending");
    fs::write(&temp, serde_json::to_vec(&index)?)?;
    fs::rename(temp, sidecar(path))?;
    Ok(())
}

pub struct Scanner {
    files: Vec<(PathBuf, Index)>,
    kind: String,
}
impl Scanner {
    pub fn open(root: &Path, kind: &str) -> Result<Self, Error> {
        let mut files = Vec::new();
        for path in fixture::paths(root, kind)? {
            let (len, modified) = fingerprint(&path)?;
            let existing = fs::read(sidecar(&path))
                .ok()
                .and_then(|b| serde_json::from_slice::<Index>(&b).ok());
            let index = match existing {
                Some(index) if index.len == len && index.modified == modified => index,
                _ => {
                    build_index(&path)?;
                    serde_json::from_slice(&fs::read(sidecar(&path))?)?
                }
            };
            files.push((path, index));
        }
        Ok(Self {
            files,
            kind: kind.into(),
        })
    }
    pub fn query(&self, q: &Query) -> Result<Answer, Error> {
        let mut rows = Vec::new();
        let mut answer = Answer::default();
        let mut line = String::with_capacity(1024);
        for (path, index) in &self.files {
            let stem = path.file_stem().unwrap().to_str().unwrap();
            if let Some(shard) = &q.shard {
                if stem != shard {
                    continue;
                }
            }
            if q.id.is_none()
                && self.kind == "samples"
                && (stem < &q.from[..7] || stem > &q.to[..7])
            {
                continue;
            }
            let mut reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
            if q.id.is_none() && index.ordered {
                // Start strictly before lower_bound: equal timestamps may straddle blocks.
                let pos = index
                    .entries
                    .partition_point(|(key, _)| key.as_str() < q.from)
                    .saturating_sub(1);
                if let Some((_, offset)) = index.entries.get(pos) {
                    reader.seek(SeekFrom::Start(*offset))?;
                }
            }
            loop {
                line.clear();
                if reader.read_line(&mut line)? == 0 {
                    break;
                }
                let row: Row<'_> = serde_json::from_str(&line)?;
                if let Some(id) = &q.id {
                    if row.id.as_ref() == id {
                        rows.push(serde_json::from_str::<Value>(&line)?);
                    }
                    continue;
                }
                if row.at.as_ref() >= q.to {
                    if index.ordered {
                        break;
                    } else {
                        continue;
                    }
                }
                if row.at.as_ref() < q.from || !q.metrics.contains(&row.metric.as_ref()) {
                    continue;
                }
                if q.aggregate {
                    answer.group(&row.at[..10], &row.metric, 1, row.value);
                } else {
                    rows.push(serde_json::from_str::<Value>(&line)?);
                }
            }
        }
        if q.aggregate {
            Ok(answer)
        } else {
            Ok(Answer::rows(rows))
        }
    }
}

pub fn append(root: &Path, kind: &str) -> Result<Answer, Error> {
    let rows = fixture::append_rows(kind);
    let mut by_file: BTreeMap<PathBuf, Vec<&Value>> = BTreeMap::new();
    for row in &rows {
        let stem = if kind == "samples" {
            row["month"].as_str().unwrap()
        } else {
            row["shard"].as_str().unwrap()
        };
        by_file
            .entry(root.join(kind).join(format!("{stem}.jsonl")))
            .or_default()
            .push(row);
    }
    // Verify exact duplicates before any write. This spike has one owner, no watches,
    // external-write conflict protocol, cross-file journal or rollback promise.
    let mut pending = Vec::new();
    for (path, requested) in by_file {
        let mut wanted = requested
            .iter()
            .map(|r| (r["id"].as_str().unwrap(), *r))
            .collect::<HashMap<_, _>>();
        let mut line = String::new();
        let mut reader = BufReader::new(File::open(&path)?);
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            let row: Row<'_> = serde_json::from_str(&line)?;
            if let Some(expected) = wanted.remove(row.id.as_ref()) {
                let stored: Value = serde_json::from_str(&line)?;
                if &stored != expected {
                    return Err("duplicate ID differs".into());
                }
            }
        }
        pending.push((path, wanted.into_values().collect::<Vec<_>>()));
    }
    for (path, mut new) in pending {
        if new.is_empty() {
            continue;
        }
        new.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let mut out = OpenOptions::new().append(true).open(&path)?;
        for row in new {
            serde_json::to_writer(&mut out, row)?;
            out.write_all(b"\n")?;
        }
        out.sync_data()?;
        // Correct on the next query even when an append is not monotonic.
        build_index(&path)?;
    }
    Ok(Answer::rows(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unescaped_fields_are_borrowed_and_escaped_fields_decode() {
        let row: Row<'_> = serde_json::from_str(
            r#"{"id":"x","metric":"steps","atUtc":"2025-01-01T00:00:00.000Z","value":1}"#,
        )
        .unwrap();
        assert!(matches!(row.id, Cow::Borrowed(_)));
        assert!(matches!(row.metric, Cow::Borrowed(_)));
        let row: Row<'_> = serde_json::from_str(
            r#"{"id":"x\ny","metric":"steps","atUtc":"2025-01-01T00:00:00.000Z","value":1}"#,
        )
        .unwrap();
        assert_eq!(row.id, "x\ny");
    }
}
