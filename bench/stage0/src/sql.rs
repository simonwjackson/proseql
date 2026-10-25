use crate::{
    fixture,
    query::{Answer, Query},
    Error,
};
use rusqlite::{params, Connection};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub fn open(root: &Path) -> Result<Connection, Error> {
    let connection = Connection::open(root.join("sqlite.db"))?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    // Deliberately do not change cache_size, mmap_size or temp_store.
    Ok(connection)
}

pub fn import(root: &Path) -> Result<(), Error> {
    let mut conn = open(root)?;
    for kind in fixture::KINDS {
        conn.execute_batch(&format!("CREATE TABLE {kind}(id TEXT PRIMARY KEY, metric TEXT NOT NULL, time TEXT NOT NULL, date TEXT NOT NULL, value REAL NOT NULL, record TEXT NOT NULL); CREATE INDEX {kind}_time ON {kind}(time); CREATE INDEX {kind}_metric_time ON {kind}(metric,time);"))?;
        let tx = conn.transaction()?;
        {
            let mut insert =
                tx.prepare(&format!("INSERT INTO {kind} VALUES (?1,?2,?3,?4,?5,?6)"))?;
            for path in fixture::paths(root, kind)? {
                for line in BufReader::new(File::open(path)?).lines() {
                    let line = line?;
                    let r: serde_json::Value = serde_json::from_str(&line)?;
                    insert.execute(params![
                        r["id"].as_str(),
                        r["metric"].as_str(),
                        r["atUtc"].as_str(),
                        r["date"].as_str(),
                        r["value"].as_f64(),
                        line
                    ])?;
                }
            }
        }
        tx.commit()?;
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

pub fn query(conn: &Connection, kind: &str, q: &Query) -> Result<Answer, Error> {
    if let Some(id) = &q.id {
        let mut stmt = conn.prepare(&format!("SELECT record FROM {kind} WHERE id=?1"))?;
        let rows = stmt
            .query_map([id], |row| row.get::<_, String>(0))?
            .map(|s| Ok(serde_json::from_str(&s?)?))
            .collect::<Result<Vec<_>, Error>>()?;
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
            "SELECT record FROM {kind} WHERE time>=?1 AND time<?2 AND {condition}"
        ))?;
        let rows = stmt
            .query_map(params![q.from, q.to], |row| row.get::<_, String>(0))?
            .map(|s| Ok(serde_json::from_str(&s?)?))
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(Answer::rows(rows))
    }
}

pub fn append(conn: &mut Connection, kind: &str) -> Result<Answer, Error> {
    let rows = fixture::append_rows(kind);
    let tx = conn.transaction()?;
    {
        let mut lookup = tx.prepare(&format!("SELECT record FROM {kind} WHERE id=?1"))?;
        let mut insert = tx.prepare(&format!("INSERT INTO {kind} VALUES (?1,?2,?3,?4,?5,?6)"))?;
        for r in &rows {
            let mut existing = lookup.query([r["id"].as_str()])?;
            if let Some(stored) = existing.next()? {
                let stored: serde_json::Value = serde_json::from_str(&stored.get::<_, String>(0)?)?;
                if &stored != r {
                    return Err("duplicate ID differs".into());
                }
            } else {
                insert.execute(params![
                    r["id"].as_str(),
                    r["metric"].as_str(),
                    r["atUtc"].as_str(),
                    r["date"].as_str(),
                    r["value"].as_f64(),
                    serde_json::to_string(r)?
                ])?;
            }
        }
    }
    tx.commit()?;
    Ok(Answer::rows(rows))
}

pub fn heap(reset: bool) -> (i64, i64) {
    unsafe {
        let live = rusqlite::ffi::sqlite3_memory_used();
        let peak = rusqlite::ffi::sqlite3_memory_highwater(i32::from(reset));
        (live, peak)
    }
}
