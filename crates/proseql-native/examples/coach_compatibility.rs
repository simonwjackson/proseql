//! Open a disposable Coach copy, report counts, and close without mutation.
#[path = "support/coach.rs"]
mod coach;

use proseql_native::NativeRuntime;
use std::path::PathBuf;
use std::sync::Arc;

fn main() {
    if let Err(error) = run() {
        // Native errors are reduced to tags before reaching this boundary.
        eprintln!("Coach copy check failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let schema_path = args
        .next()
        .ok_or("Usage: coach_compatibility SCHEMA_JSON COPIED_DATA_DIR")?;
    let root = std::fs::canonicalize(args.next().ok_or("Missing copied data directory")?)?;
    let home = PathBuf::from(std::env::var("HOME")?);
    let live = home.join(".local/share/coach");
    if live.exists() {
        let live = std::fs::canonicalize(live)?;
        if root.starts_with(&live) || live.starts_with(&root) {
            return Err("Refusing live Coach directory or an overlapping root".into());
        }
    }
    // Symlinks can route filesystem recovery into the live directory. Reject
    // them before opening even when the copy's root itself is elsewhere.
    reject_symlinks(&root)?;
    let schema: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(schema_path)?)?;
    let config = coach::config(root.to_str().ok_or("Non-UTF8 data path")?, &schema)?;
    let names: Vec<_> = config
        .collections
        .iter()
        .map(|collection| collection.descriptor.name.clone())
        .collect();
    let mut options = coach::options(Arc::new(|_, line| {
        eprintln!("Skipped malformed provider JSONL line {line}")
    }));
    options.watch_debounce = None;
    let runtime = NativeRuntime::open_sources_with_options(config, options).map_err(redact)?;
    for name in &names {
        let count = runtime
            .read(|database| {
                Ok(database
                    .collection(name)
                    .expect("declared collection")
                    .list()
                    .len())
            })
            .map_err(redact)?;
        println!("{name}: {count}");
    }
    runtime.close().map_err(redact)?;
    println!("Opened {} collections without a mutation.", names.len());
    Ok(())
}

fn redact(error: proseql_engine::errors::EngineError) -> std::io::Error {
    std::io::Error::other(error.tag())
}

fn reject_symlinks(root: &std::path::Path) -> Result<(), std::io::Error> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(std::io::Error::other(
                "Symlinks are not allowed in the disposable copy",
            ));
        }
        if kind.is_dir() {
            reject_symlinks(&entry.path())?;
        }
    }
    Ok(())
}
