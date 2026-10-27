use crate::{
    fixture,
    query::{Answer, Query},
    Error,
};
use rusqlite::{params, Connection, Row, Statement};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub fn open(root: &Path) -> Result<Connection, Error> {
    let temp = std::env::var("SQLITE_TMPDIR")
        .map_err(|_| "SQLITE_TMPDIR must point to the owned filesystem-backed data directory")?;
    if !Path::new(&temp).starts_with("/home/simonwjackson/work/qws-harness-data")
        || !Path::new(&temp).is_dir()
    {
        return Err(
            "SQLite temporary files must stay under the owned qws-harness data directory".into(),
        );
    }
    let connection = Connection::open(root.join("sqlite.db"))?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    // Deliberately do not change cache_size, mmap_size or temp_store.
    Ok(connection)
}

fn record(row: &Row<'_>, kind: &str) -> rusqlite::Result<Value> {
    let mut r = json!({
        "id":row.get::<_,String>(0)?, "metric":row.get::<_,String>(1)?,
        "at":row.get::<_,String>(2)?, "end":row.get::<_,Option<String>>(3)?,
        "value":row.get::<_,f64>(4)?, "source":row.get::<_,String>(5)?,
        "receivedAt":row.get::<_,String>(6)?, "rawId":row.get::<_,String>(7)?,
        "month":row.get::<_,String>(8)?, "date":row.get::<_,String>(9)?,
        "atUtc":row.get::<_,String>(10)?
    });
    if kind.starts_with("raw") {
        r["shard"] = json!(row.get::<_, String>(11)?);
    }
    Ok(r)
}
fn insert(stmt: &mut Statement<'_>, r: &Value) -> Result<(), Error> {
    stmt.execute(params![
        r["id"].as_str(),
        r["metric"].as_str(),
        r["at"].as_str(),
        r["end"].as_str(),
        r["value"].as_f64(),
        r["source"].as_str(),
        r["receivedAt"].as_str(),
        r["rawId"].as_str(),
        r["month"].as_str(),
        r["date"].as_str(),
        r["atUtc"].as_str(),
        r["shard"].as_str()
    ])?;
    Ok(())
}
fn insert_sql(kind: &str) -> String {
    format!("INSERT INTO {kind} VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)")
}

type MergeHeap = std::collections::BinaryHeap<std::cmp::Reverse<(String, String, usize, String)>>;
fn queue_next(reader: &mut BufReader<File>, i: usize, heap: &mut MergeHeap) -> Result<(), Error> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let row: Value = serde_json::from_str(&line)?;
    heap.push(std::cmp::Reverse((
        row["atUtc"].as_str().ok_or("missing UTC time")?.to_owned(),
        row["id"].as_str().ok_or("missing ID")?.to_owned(),
        i,
        line,
    )));
    Ok(())
}

pub fn import(root: &Path) -> Result<(), Error> {
    let mut conn = open(root)?;
    for kind in fixture::KINDS {
        // Real typed columns, not duplicated scalar columns plus a JSON blob.
        conn.execute_batch(&format!("CREATE TABLE {kind}(id TEXT PRIMARY KEY, metric TEXT NOT NULL, at TEXT NOT NULL, end_time TEXT, value REAL NOT NULL, source TEXT NOT NULL, received_at TEXT NOT NULL, raw_id TEXT NOT NULL, month TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, shard TEXT); CREATE INDEX {kind}_metric_time ON {kind}(metric,time);"))?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(&insert_sql(kind))?;
            // Import in chronological ingestion order, including hash-sharded raw.
            // A bounded k-way merge avoids giving SQLite an artificially scattered
            // table layout just because the plain-text export uses hash shards.
            let mut readers = fixture::paths(root, kind)?
                .into_iter()
                .map(|p| File::open(p).map(BufReader::new))
                .collect::<Result<Vec<_>, _>>()?;
            let mut heap = std::collections::BinaryHeap::new();
            for (i, reader) in readers.iter_mut().enumerate() {
                queue_next(reader, i, &mut heap)?;
            }
            while let Some(std::cmp::Reverse((_, _, i, line))) = heap.pop() {
                insert(&mut stmt, &serde_json::from_str::<Value>(&line)?)?;
                queue_next(&mut readers[i], i, &mut heap)?;
            }
        }
        tx.commit()?;
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

pub fn query(conn: &Connection, kind: &str, q: &Query) -> Result<Answer, Error> {
    if let Some(id) = &q.id {
        let mut stmt = conn.prepare(&format!("SELECT * FROM {kind} WHERE id=?1"))?;
        let rows = stmt
            .query_map([id], |row| record(row, kind))?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Answer::rows(rows));
    }
    let condition = if q.metrics.len() == 1 {
        "metric='steps'"
    } else {
        "metric IN ('steps','heartRate')"
    };
    if q.aggregate {
        let mut stmt = conn.prepare(&format!("SELECT date,metric,count(*),sum(value) FROM {kind} WHERE time>=?1 AND time<?2 AND {condition} GROUP BY date,metric"))?;
        let mut rows = stmt.query(params![q.from, q.to])?;
        let mut answer = Answer::default();
        while let Some(row) = rows.next()? {
            answer.group(
                &row.get::<_, String>(0)?,
                &row.get::<_, String>(1)?,
                u64::try_from(row.get::<_, i64>(2)?)?,
                row.get(3)?,
            );
        }
        Ok(answer)
    } else {
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM {kind} WHERE time>=?1 AND time<?2 AND {condition}"
        ))?;
        let rows = stmt
            .query_map(params![q.from, q.to], |row| record(row, kind))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Answer::rows(rows))
    }
}

pub fn append_rows(conn: &mut Connection, kind: &str, rows: Vec<Value>) -> Result<Answer, Error> {
    let tx = conn.transaction()?;
    {
        let mut lookup = tx.prepare(&format!("SELECT * FROM {kind} WHERE id=?1"))?;
        let mut stmt = tx.prepare(&insert_sql(kind))?;
        for r in &rows {
            let mut existing = lookup.query([r["id"].as_str()])?;
            if let Some(stored) = existing.next()? {
                if &record(stored, kind)? != r {
                    return Err("duplicate ID differs".into());
                }
            } else {
                insert(&mut stmt, r)?;
            }
        }
    }
    tx.commit()?;
    Ok(Answer::rows(rows))
}

pub fn info(root: &Path) -> Result<Value, Error> {
    let conn = open(root)?;
    let mut pragmas = serde_json::Map::new();
    for name in [
        "journal_mode",
        "synchronous",
        "cache_size",
        "page_size",
        "mmap_size",
        "temp_store",
    ] {
        let mut stmt = conn.prepare(&format!("PRAGMA {name}"))?;
        let value = stmt.query_row([], |row| {
            use rusqlite::types::ValueRef;
            Ok(match row.get_ref(0)? {
                ValueRef::Integer(n) => json!(n),
                ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                _ => Value::Null,
            })
        })?;
        pragmas.insert(name.into(), value);
    }
    let mut stmt = conn.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    )?;
    let indexes = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        json!({"sqlite_version":rusqlite::version(),"temp_directory":std::env::var("SQLITE_TMPDIR")?,"pragmas":pragmas,"indexes":indexes}),
    )
}

pub fn heap(reset: bool) -> (i64, i64) {
    unsafe {
        let live = rusqlite::ffi::sqlite3_memory_used();
        let peak = rusqlite::ffi::sqlite3_memory_highwater(i32::from(reset));
        (live, peak)
    }
}
