#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), String> {
    use std::fs;
    use std::time::Duration;

    use indexmap::IndexMap;
    use proseql_engine::descriptor::{IdStrategy, SchemaNode, StructField};
    use proseql_formats::FormatRegistry;
    use proseql_storage::fs::FsStorageHost;
    use proseql_storage::persistence::{load_data, save_data, LoadDataOptions, SaveDataOptions};
    use serde_json::json;

    let schema = SchemaNode::Struct {
        fields: vec![
            StructField {
                name: "id".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "name".to_owned(),
                schema: SchemaNode::Str,
            },
            StructField {
                name: "age".to_owned(),
                schema: SchemaNode::Num,
            },
        ],
    };

    let host = FsStorageHost::new_polling(Duration::from_millis(100))
        .map_err(|error| error.to_string())?;
    let formats = FormatRegistry::with_builtins();
    let root = std::env::temp_dir().join("proseql-storage-quickstart");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;

    let json_path = root.join("users.json");
    let yaml_path = root.join("users.yaml");
    let users = IndexMap::from([
        ("u1".to_owned(), json!({"id":"u1","name":"Alice","age":30})),
        ("u2".to_owned(), json!({"id":"u2","name":"Bob","age":25})),
    ]);

    save_data(
        &host,
        &formats,
        json_path.to_str().ok_or_else(|| "utf8 path".to_owned())?,
        &schema,
        &users,
        SaveDataOptions {
            id_strategy: Some(IdStrategy::Provided),
            ..SaveDataOptions::default()
        },
    )
    .map_err(|error| error.to_string())?;

    let loaded = load_data(
        &host,
        &formats,
        json_path.to_str().ok_or_else(|| "utf8 path".to_owned())?,
        &schema,
        LoadDataOptions {
            id_strategy: Some(IdStrategy::Provided),
            ..LoadDataOptions::default()
        },
        None,
    )
    .map_err(|error| error.to_string())?;

    let older_than_26 = loaded
        .values()
        .filter(|user| user["age"].as_i64().unwrap_or_default() > 26)
        .map(|user| user["name"].as_str().unwrap_or("unknown"))
        .collect::<Vec<_>>();

    save_data(
        &host,
        &formats,
        yaml_path.to_str().ok_or_else(|| "utf8 path".to_owned())?,
        &schema,
        &loaded,
        SaveDataOptions {
            format: Some("yaml".to_owned()),
            id_strategy: Some(IdStrategy::Provided),
            ..SaveDataOptions::default()
        },
    )
    .map_err(|error| error.to_string())?;

    println!("saved json: {}", json_path.display());
    println!("saved yaml: {}", yaml_path.display());
    println!("query-like result (>26): {:?}", older_than_26);
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn main() {}
