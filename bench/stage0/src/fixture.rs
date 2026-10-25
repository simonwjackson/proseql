use crate::{spike, sql, Error};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub const DAYS: [usize; 10] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31];
pub const KINDS: [&str; 2] = ["samples", "raw"];
pub const WORKLOADS: [&str; 7] = ["point", "hour", "month", "ten", "append", "open", "idle"];

pub fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}

pub fn row(month: usize, minute: usize, metric: usize, append: bool) -> Value {
    let at = format!(
        "2025-{month:02}-{:02}T{:02}:{:02}:00.000Z",
        minute / 1440 + 1,
        minute / 60 % 24,
        minute % 60
    );
    json!({
        "id": format!("synthetic:{month:02}:{minute:07}:{metric}:{}{}", if append {"append:"} else {""}, "i".repeat(60)),
        "metric": if metric == 0 {"steps"} else {"heartRate"},
        "at": at.replace('Z', "+00:00"), "end": null,
        "value": (50 + minute % 100) as f64,
        "source": if minute.is_multiple_of(3) {"phone"} else {"watch"},
        "receivedAt": at, "rawId": format!("raw:{month:02}:{minute:07}:{}", "r".repeat(33)),
        "month": format!("2025-{month:02}"), "date": &at[..10], "atUtc": at
    })
}

pub fn raw(mut row: Value) -> Value {
    row["shard"] = json!(format!(
        "{:02x}",
        hash(row["id"].as_str().unwrap().as_bytes()) % 256
    ));
    row
}

pub fn point(kind: &str) -> Value {
    let r = row(5, 12, 0, false);
    if kind == "raw" {
        raw(r)
    } else {
        r
    }
}

/// 900 new IDs and 100 exact duplicates; each implementation verifies all 1,000.
pub fn append_rows(kind: &str) -> Vec<Value> {
    (0..1000)
        .map(|i| {
            let r = row(10, i, 0, i < 900);
            if kind == "raw" {
                raw(r)
            } else {
                r
            }
        })
        .collect()
}

pub fn paths(root: &Path, kind: &str) -> Result<Vec<PathBuf>, Error> {
    let mut paths = fs::read_dir(root.join(kind))?
        .map(|p| p.map(|p| p.path()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.retain(|p| p.extension().is_some_and(|s| s == "jsonl"));
    paths.sort();
    Ok(paths)
}

#[derive(Serialize, Deserialize)]
pub struct Manifest {
    pub generator: u32,
    pub rows_per_kind: usize,
    pub minutes_per_month: Option<usize>,
    pub bytes: u64,
}

/// A small minute cap is only used by focused equivalence tests.
pub fn prepare(root: &Path, cap: Option<usize>) -> Result<Manifest, Error> {
    if root.exists() {
        return Err("data directory must not exist".into());
    }
    fs::create_dir_all(root.join("samples"))?;
    fs::create_dir(root.join("raw"))?;
    let mut shards = (0..256)
        .map(|i| File::create(root.join(format!("raw/{i:02x}.jsonl"))).map(BufWriter::new))
        .collect::<Result<Vec<_>, _>>()?;
    let mut count = 0;
    for (month, days) in DAYS.iter().enumerate() {
        let mut out = BufWriter::new(File::create(
            root.join(format!("samples/2025-{:02}.jsonl", month + 1)),
        )?);
        for minute in 0..cap.unwrap_or(days * 1440).min(days * 1440) {
            for metric in 0..if minute % 2 == 0 { 2 } else { 1 } {
                let r = row(month + 1, minute, metric, false);
                serde_json::to_writer(&mut out, &r)?;
                out.write_all(b"\n")?;
                let r = raw(r);
                let shard = usize::from_str_radix(r["shard"].as_str().unwrap(), 16)?;
                serde_json::to_writer(&mut shards[shard], &r)?;
                shards[shard].write_all(b"\n")?;
                count += 1;
            }
        }
        out.flush()?;
        out.get_ref().sync_all()?;
    }
    for shard in &mut shards {
        shard.flush()?;
        shard.get_ref().sync_all()?;
    }
    drop(shards);
    let mut bytes = 0;
    for kind in KINDS {
        for path in paths(root, kind)? {
            bytes += fs::metadata(&path)?.len();
            spike::build_index(&path)?;
        }
    }
    sql::import(root)?;
    let manifest = Manifest {
        generator: 1,
        rows_per_kind: count,
        minutes_per_month: cap,
        bytes,
    };
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(manifest)
}
