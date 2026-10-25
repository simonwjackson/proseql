use crate::fixture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct Query {
    pub from: &'static str,
    pub to: &'static str,
    pub metrics: Vec<&'static str>,
    pub id: Option<String>,
    pub shard: Option<String>,
    pub aggregate: bool,
}

impl Query {
    pub fn new(kind: &str, workload: &str) -> Self {
        let (from, to) = match workload {
            "hour" => ("2025-05-01T00:00:00.000Z", "2025-05-01T01:00:00.000Z"),
            "month" => ("2025-05-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z"),
            _ => ("2025-01-01T00:00:00.000Z", "2025-11-01T00:00:00.000Z"),
        };
        let point = fixture::point(kind);
        Self {
            from, to, metrics: if workload == "month" {vec!["steps"]} else {vec!["steps", "heartRate"]},
            id: (workload == "point").then(|| point["id"].as_str().unwrap().to_owned()),
            shard: (workload == "point" && kind == "raw").then(|| point["shard"].as_str().unwrap().to_owned()),
            aggregate: ["month", "ten"].contains(&workload),
        }
    }
    pub fn filter(&self) -> Value {
        if let Some(id) = &self.id {
            if let Some(shard) = &self.shard { serde_json::json!({"id":id,"shard":shard}) }
            else { serde_json::json!({"id":id}) }
        } else {
            serde_json::json!({"atUtc":{"$gte": self.from,"$lt":self.to}, "metric":{"$in":self.metrics}})
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Group {
    pub count: u64,
    pub sum: f64,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Answer {
    pub count: u64,
    pub sum: f64,
    pub digest: u64,
    pub groups: BTreeMap<String, Group>,
}
impl Answer {
    pub fn rows(mut rows: Vec<Value>) -> Self {
        rows.sort_by(|a,b| a["id"].as_str().cmp(&b["id"].as_str()));
        let mut result = Self {count: rows.len() as u64, ..Self::default()};
        let mut encoded = Vec::new();
        for row in rows {
            result.sum += row["value"].as_f64().unwrap();
            let ordered = row.as_object().unwrap().iter().collect::<BTreeMap<_, _>>();
            serde_json::to_writer(&mut encoded, &ordered).unwrap();
        }
        result.digest = fixture::hash(&encoded);
        result
    }
    pub fn group(&mut self, date: &str, metric: &str, count: u64, sum: f64) {
        self.count += count;
        self.sum += sum;
        let group = self.groups.entry(format!("{date}/{metric}")).or_default();
        group.count += count;
        group.sum += sum;
    }
}
