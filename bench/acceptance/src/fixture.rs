use crate::{sql, Error};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub const DAYS: [usize; 10] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31];
pub const KINDS: [&str; 3] = ["samples", "raw", "raw_month"];
pub const WORKLOADS: [&str; 8] = [
    "point",
    "hour",
    "month",
    "ten",
    "append",
    "append-range",
    "open",
    "idle",
];

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
    if kind.starts_with("raw") {
        raw(r)
    } else {
        r
    }
}

/// 1,000 genuinely new IDs in an existing month (backfilled timestamps).
pub fn append_rows(kind: &str) -> Vec<Value> {
    (0..1000)
        .map(|i| {
            let r = row(10, i, 0, true);
            if kind.starts_with("raw") {
                raw(r)
            } else {
                r
            }
        })
        .collect()
}

/// Ordered sync: unique append IDs at the last existing October timestamp.
pub fn sync_rows(kind: &str) -> Vec<Value> {
    let tail = row(10, DAYS[9] * 1440 - 1, 0, false);
    append_rows(kind)
        .into_iter()
        .map(|mut row| {
            for field in ["at", "atUtc", "date", "receivedAt"] {
                row[field] = tail[field].clone();
            }
            row
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
pub fn prepare(root: &Path, cap: Option<usize>, shard_count: u64) -> Result<Manifest, Error> {
    if ![16, 256].contains(&shard_count) {
        return Err("shard_count must be 16 or 256".into());
    }
    if root.exists() {
        return Err("data directory must not exist".into());
    }
    fs::create_dir_all(root.join("samples"))?;
    fs::create_dir(root.join("raw"))?;
    fs::create_dir(root.join("raw_month"))?;
    let mut shards = (0..shard_count)
        .map(|i| File::create(root.join(format!("raw/{i:02x}.jsonl"))).map(BufWriter::new))
        .collect::<Result<Vec<_>, _>>()?;
    let mut count = 0;
    for (month, days) in DAYS.iter().enumerate() {
        let mut out = BufWriter::new(File::create(
            root.join(format!("samples/2025-{:02}.jsonl", month + 1)),
        )?);
        let mut monthly_raw = BufWriter::new(File::create(
            root.join(format!("raw_month/2025-{:02}.jsonl", month + 1)),
        )?);
        for minute in 0..cap.unwrap_or(days * 1440).min(days * 1440) {
            for metric in 0..if minute % 2 == 0 { 2 } else { 1 } {
                let r = row(month + 1, minute, metric, false);
                serde_json::to_writer(&mut out, &r)?;
                out.write_all(b"\n")?;
                let mut r = raw(r);
                let shard = (hash(r["id"].as_str().unwrap().as_bytes()) % shard_count) as usize;
                r["shard"] = json!(format!("{shard:02x}"));
                serde_json::to_writer(&mut shards[shard], &r)?;
                shards[shard].write_all(b"\n")?;
                serde_json::to_writer(&mut monthly_raw, &r)?;
                monthly_raw.write_all(b"\n")?;
                count += 1;
            }
        }
        out.flush()?;
        out.get_ref().sync_all()?;
        monthly_raw.flush()?;
        monthly_raw.get_ref().sync_all()?;
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
        }
    }
    sql::import(root)?;
    let manifest = Manifest {
        generator: 2,
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
