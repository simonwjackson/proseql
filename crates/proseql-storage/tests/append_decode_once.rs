use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
use proseql_formats::{FormatCodec, FormatOptions, FormatRegistry};
use proseql_storage::{
    append::load_append_file, host::StorageHost, memory::MemoryStorageHost,
    persistence::CollectionStorageConfig, source_config::NormalizedCollectionFileSourceConfig,
};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

// A registered codec is a real extension seam. Its invocation count also guards
// against reintroducing the native partition's former validation decode pass.
struct CountingJsonl(Arc<AtomicUsize>);
impl FormatCodec for CountingJsonl {
    fn name(&self) -> &str {
        "jsonl"
    }
    fn extensions(&self) -> &[&str] {
        &["jsonl"]
    }
    fn encode(&self, value: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        proseql_formats::codecs::jsonl_codec().encode(value, options)
    }
    fn decode(&self, raw: &str) -> Result<Value, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        proseql_formats::codecs::jsonl_codec().decode(raw)
    }
}

#[test]
fn append_partition_decodes_once_and_keeps_strict_id_and_tail_checks() {
    let calls = Arc::new(AtomicUsize::new(0));
    let formats = FormatRegistry::new(vec![Box::new(CountingJsonl(calls.clone()))]);
    let host = MemoryStorageHost::default();
    let source = NormalizedCollectionFileSourceConfig {
        id: "samples".into(),
        collection: "samples".into(),
        path: "/samples.jsonl".into(),
        format: "jsonl".into(),
        prose: None,
    };
    let collection = CollectionStorageConfig {
        name: "samples".into(),
        schema: SchemaNode::Struct {
            fields: vec![
                StructField {
                    name: "id".into(),
                    schema: SchemaNode::Str,
                },
                StructField {
                    name: "value".into(),
                    schema: SchemaNode::NumFromStr,
                },
            ],
        },
        id_strategy: IdStrategy::Provided,
        version: None,
        migrations: vec![],
    };
    for tail in ["\n", "", "\n{\"id\":"] {
        host.write(
            &source.path,
            &format!("{{\"id\":\"a\",\"value\":\"42\",\"excess\":true}}{tail}"),
        )
        .unwrap();
        calls.store(0, Ordering::SeqCst);
        let loaded = load_append_file(&host, &formats, &source, &collection, true).unwrap();
        assert_eq!(
            loaded.records["a"],
            serde_json::json!({"id":"a", "value":42})
        );
        assert_eq!(loaded.torn.is_some(), tail.contains("id"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "one codec decode, including an unterminated/torn final line"
        );
    }
    for raw in [
        "{\"id\":\"a\",\"value\":\"1\"}\n{\"id\":\"a\",\"value\":\"2\"}\n",
        "{\"value\":\"1\"}\n",
        "42\n",
    ] {
        host.write(&source.path, raw).unwrap();
        assert_eq!(
            load_append_file(&host, &formats, &source, &collection, true)
                .unwrap_err()
                .tag(),
            "SourceConfigError"
        );
    }
    host.write(&source.path, "{broken}\n{\"id\":\"a\",\"value\":\"1\"}\n")
        .unwrap();
    assert_eq!(
        load_append_file(&host, &formats, &source, &collection, true)
            .unwrap_err()
            .tag(),
        "SerializationError"
    );
}
