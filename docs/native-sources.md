# Native source runtime

The native source runtime opens writable document sources and read-only document graphs in one database. Collection schemas and existing data paths stay unchanged. The single-file `NativeRuntimeConfig { path, collections }` API remains available.

## Configuration

Use `NativeRuntime::open_sources(NativeSourceRuntimeConfig { collections, sources })` for built-in codecs and graphs without transforms. Each collection uses the same `NativeCollectionConfig` descriptor as single-file mode. Sources use the existing `proseql_storage::source_config::DatabaseSourceConfig` types.

Use `open_sources_with_options` to provide a callback registry, plugin codecs, a format registry and graph transform host. Use `open_sources_with_host` to provide a durable storage host too. The options default to built-in codecs, no transform host, and a 50 ms watch debounce. The default filesystem host polls every two seconds. Set `watch_debounce` to `None` for explicit reload only.

Every declared collection must have exactly one source owner. Source mode rejects overlapping writable and graph file patterns for discovered files and outboxes. Use `UnknownCollectionPolicy::Preserve` on writable sources when the runtime declares only part of the database. Select only declared collections in those sources. A partial runtime must also declare the relationship targets its records need.

Source mode rejects `replace_all`; use `mutate` for app-owned changes. Single-file `replace_all` remains available. Both modes accept registered callbacks through their options (see "Native callbacks"). Existing `NativeRuntimeConfig { path, collections }` values and `open`, `open_with_host`, and `open_with_dyn_host` calls need no changes; they use an empty callback registry.

The consumer example at `crates/proseql-native/examples/support/coach.rs` maps the legacy Coach source configuration. It declares one writable source, two YAML graph sources, and one graph with fifteen JSONL roots. It supplies a custom transform and an opt-in lenient JSONL codec. Coach-specific names do not enter the library implementation.

## Source sessions with no idle row cache

Use `NativeSourceSessions` when durable records must leave memory after an operation. The owner retains configuration and registered services, not a loaded database. It supports the same durable collection files, writable documents, partitions, and read-only graphs as `NativeRuntime`.

```rust
use proseql_native::{IdleMemoryReclaim, NativeSourceSessions};

// Existing source configuration and options. Keep watch_debounce: None when
// this operation does not need external-change notifications.
let sessions = NativeSourceSessions::new(config, options)?;
#[cfg(all(target_os = "linux", target_env = "gnu"))]
let sessions = sessions.reclaim_idle_memory(IdleMemoryReclaim::GlibcTrim)?;

let count = sessions.with_session(|runtime| {
    let rows = runtime.query_bounded("samples", input)?;
    // Finish record processing here. Returning a small aggregate lets close
    // release both the internal state and unused allocator pages.
    Ok(rows.len())
})?;
```

Creation validates configuration and registered services without decoding files. `open_session` and `with_session` report source parse and record errors when they open the sources. Each session uses the existing native engine, guarded mutations, durable writes, reload behavior, and codecs. It reopens sources, rebuilds needed indexes, and reruns load-time defaults, migrations, transforms, and generator factories. This costs I/O and CPU. Repeated reads do not get a permanent warm cache. Use restart-safe ID generators and deterministic migrations.

Concurrent sessions on one owner wait for each other. A nested open on the same thread returns `OperationError` with reason `session-reentrant`. After-hooks can use the active `NativeRuntime`; they must not open another session on that owner. Do not target the same paths through a second owner or runtime instance.

A session keeps its accepted state until it closes, including last-known-good state after a failed reload. A later session reopens disk; it does not retain the prior session's snapshot. Keep one coherent operation inside one session if it needs a stable view. Eager last-known-good state remains resident. Lazy state follows the streaming watch contract below.

`with_session` closes before returning, including when the caller returns an error. Its guard also closes during panic unwinding. Cleanup preserves the original caller error. A poisoned runtime is discarded without persisting its uncommitted state. Closed runtime clones cannot read and no longer retain rows. Normal source writes remain durable before success.

For a live watch or deliberate cache reuse, hold `let session = sessions.open_session()?;` and use its existing runtime methods. Drop watches and then drop or close that guard. An open guard deliberately retains active state, even between calls. The guard stays on its opening thread; share the owner across threads and open each session on the worker that uses it. A watch returned from `with_session` does not stay live after that session closes.

### Allocator and output ownership

| Policy or owner | Memory behavior | Cost or limit |
|---|---|---|
| Default `IdleMemoryReclaim::None` | Session state is dropped. The allocator can keep freed pages. | No forced allocator pass; low live heap does not guarantee low RSS. |
| Explicit `IdleMemoryReclaim::GlibcTrim` | After session state drops, call glibc `malloc_trim(0)`. | Linux GNU only. Unsupported targets fail at policy selection. It acts on process-wide unused glibc pages and adds latency; arbitrary custom allocators need their own policy. |
| Caller-owned results | Returned records remain valid and allocated until the caller drops them. | Session close cannot release live output. After dropping it, `sessions.release_unused_memory()` applies the selected allocator policy again. Its boolean is glibc's release result, not an RSS measurement. |
| Open sessions and watches | Their required data stays active. | These are explicit owners, not an idle-cache guarantee. |
| Custom hosts, callbacks, transforms, and codecs | Registered services remain with the owner. | Memory they retain must be included separately in the consumer budget. |

The session interface does not compact loaded rows, bound an eager source's active load, or eliminate large sorts and returned results. Use bounded reads for eligible lazy sources. Put aggregation inside the session where possible. Do not hold a session while waiting for network input or a user action.

Adoption is an explicit access change, not an automatic benefit for existing consumers. Logbook needs an owner and session boundary around each coherent storage operation; switching a dependency pin alone does not remove its eager resident data. Existing consumers can keep their current runtime and source options unchanged. No persisted format or source layout change is required.

## Native callbacks

`NativeRuntimeOptions` and `NativeSourceRuntimeOptions` accept a `callbacks: CallbackRegistry` (empty by default). Register Rust closures before opening. The runtime consumes the registry and shares it with the engine; there is no second callback implementation or JavaScript dependency. `CallbackRegistry` is re-exported by `proseql-native`.

For single-file mode use `open_with_options(config, options)`, `open_with_host_and_options(config, host, options)`, or `open_with_dyn_host_and_options(config, host, options)`. Source mode uses the existing `open_sources_with_options` or `open_sources_with_host` methods.

```rust
use proseql_native::{CallbackRegistry, NativeRuntime, NativeRuntimeOptions};
use proseql_engine::descriptor::ComputedFieldDescriptor;
use proseql_engine::id_gen::SequentialGenerator;

// `config` is an existing NativeRuntimeConfig with a users collection.
config.collections[0].descriptor.before_create_hooks.push("trim-name".into());
config.collections[0].descriptor.computed_fields.push(ComputedFieldDescriptor {
    name: "displayName".into(), callback_id: "display-name".into(),
});
config.collections[0].descriptor.id_generator = Some("user-sequence".into());

let mut callbacks = CallbackRegistry::new();
callbacks.register_before_create_hook("trim-name", Box::new(|context| {
    let mut data = context.data.clone();
    if let Some(name) = data.get("name").and_then(serde_json::Value::as_str) {
        data["name"] = serde_json::json!(name.trim());
    }
    Ok(data)
}));
callbacks.register_computed("display-name", Box::new(|record| record["name"].clone()));
callbacks.register_id_generator("user-sequence", Box::new(|| {
    Box::new(SequentialGenerator::new("user"))
}));
let runtime = NativeRuntime::open_with_options(config, NativeRuntimeOptions {
    callbacks, ..Default::default()
})?;
```

A sequential generator is an example, not a persistent ID counter. It restarts when the runtime reopens. Use a generator whose IDs remain unique across restarts for production data.

| Registration | Descriptor or use | Closure contract |
|---|---|---|
| `register_before_create_hook` | `before_create_hooks` IDs | context contains input `data`; return replacement data or `EngineError` |
| `register_before_update_hook` | `before_update_hooks` IDs | context contains `existing` and `update`; return replacement updates or `EngineError` |
| `register_before_delete_hook` | `before_delete_hooks` IDs | inspect entity and ID; return `Result<(), EngineError>` |
| `register_after_create_hook`, `register_after_update_hook`, `register_after_delete_hook` | corresponding after-hook IDs | observe successful changes; returned errors do not veto them |
| `register_on_change_hook` | `on_change_hooks` IDs | receives `OnChangeContext::{Create, Update, Delete}` |
| `register_computed` | `computed_fields: Vec<ComputedFieldDescriptor>` | derive a JSON value from a record on query; computed values are not persisted |
| `register_migration` | `migrations: Vec<MigrationDescriptor>` and `version` | transform a collection's ID-keyed JSON object; return a map or `EngineError` |
| `register_id_generator` | `id_generator: Some(name)` | factory produces a fresh `Box<dyn IdGenerator>` per collection |
| `register_custom_operator` | query field operators, for example `$multipleOf` | declare supported types; evaluate field value and operand as a boolean |
| `register_codec_encode`, `register_codec_decode` | `plugin_codecs: Vec<PluginCodecMetadata>` in options | convert boundary values to/from text, or return `EngineError` |
| `register_default`, `register_predicate` | engine schema/query callback IDs | synchronous JSON default or boolean predicate, respectively |

Collection and global hook IDs, computed IDs, migration IDs and generator names must resolve at open. A missing registration returns `OperationError` with reason `missing-callback`, naming the collection and ID. Plugin codec metadata is also checked; its error names the codec and callback ID. Registration does not execute a callback at validation time. Default/predicate callback signatures and the supported schema subset remain the engine's contract.

Custom operators use the engine's existing behavior: unregistered or type-incompatible query operators are ignored. Register an operator before querying it; do not treat an unknown operator as a validation boundary. Built-in operator names and plugin naming rules remain defined by `proseql_engine::plugins`.

### Callback ordering and failure

`mutate` serializes engine mutations, synchronous before-hooks, encoding and durable writes. A before-hook error, schema failure, migration failure during loading, codec error, or persistence error does not publish the candidate. A failed mutation rolls memory back; a failed source write also quarantines under the crash rule. Callback bodies must not panic. Rust callbacks such as computed fields, operators, defaults and ID generators have infallible return signatures; they cannot return an `EngineError` through those signatures.

Native after-hooks and `onChange` deliberately differ from WASM timing: native defers them so no callback can observe or cause effects from an uncommitted, non-durable write. The engine enqueues their contexts during a mutation. Native dispatches them in the original event order, once, after durable persistence and engine commit, **after releasing the mutation lock**. A callback may read or mutate this runtime without deadlocking. Returned hook errors are swallowed, as in WASM. The mutation caller gets success even when an after-hook returns an error.

A rollback, codec failure or failed durable write discards all queued after-hooks and `onChange` events. This includes creates earlier in a multi-operation `mutate` that later fails. Events retain their operation-time record snapshots even when a later operation in the same transaction changes that record again. Reentrant or concurrent mutations can interleave callback delivery between batches. This is not an exactly-once external messaging protocol: a crash after persistence but before callback delivery loses that delivery.

Before-hooks and other synchronous callbacks still run under the runtime lock. Do not call this runtime from them. Use pure transformations where possible: rollback restores database state, not arbitrary external side effects that a callback already performed. Use after-hooks for post-commit effects.

### Migrations and plugin codecs

A migration receives the whole collection map, not one record. `MigrationDescriptor { from, to, description, callback_id }` references a registered closure. The existing engine migration chain validation and version rules apply. A migration error fails open or reload; it does not overwrite the source. Single-file migration writeback is staged in memory, validated as a complete database, then written with `replace_durable` before open succeeds. Source-mode migrations do not write during open: migrated records persist when the owning file next changes. Read-only graph sources are never written. Until then, a reopen or reload runs their migrations again; make migrations deterministic. Versioned array formats still cannot hold a version envelope.

For callback-backed codecs, register the encode/decode closures in the same `callbacks` registry and supply metadata:

```rust
use proseql_engine::plugins::PluginCodecMetadata;

let codec = PluginCodecMetadata {
    name: "custom-json".into(),
    extensions: vec!["custom".into()],
    encode_callback_id: "custom-encode".into(),
    decode_callback_id: "custom-decode".into(),
};
// Register both closures before open. Their aliases match the metadata IDs.
callbacks.register_codec_encode("custom-encode", Box::new(|value, _indent| {
    Ok(value.to_string())
}));
callbacks.register_codec_decode("custom-decode", Box::new(|raw| {
    serde_json::from_str(raw).map_err(|error| {
        proseql_engine::errors::EngineError::Serialization(Box::new(
            proseql_engine::errors::SerializationError {
                format: "custom-json".into(), message: error.to_string(), cause: None,
            },
        ))
    })
}));
let options = NativeRuntimeOptions {
    callbacks, plugin_codecs: vec![codec], ..Default::default()
};
```

`formats` still accepts native `FormatCodec` implementations. Callback codecs register after that registry; the last codec for an extension wins. Callback codecs use the same shared registry as the engine. Each codec must preserve the format's supported database shape and surface failures, not silently drop records. Existing non-YAML document sources still reject changes to an existing document because native byte-preserving edits support YAML only. Use a collection-file source for another whole-file codec, or a new document outbox where appropriate.

## Write a Rust storage host

Implement `proseql_storage::host::StorageHost: Send + Sync` for runtime I/O, not database behavior. The engine remains platform-blind. For `NativeRuntime`, also implement `proseql_storage::persistence::DurableStorageHost`. Supply an `Arc<H>` to `open_with_host` / `open_with_host_and_options`, or an `Arc<dyn DurableStorageHost>` to `open_with_dyn_host` / source-mode `open_sources_with_host`.

| Surface | Required behavior |
|---|---|
| `read`, `read_bytes` | complete file contents; missing reads fail. Override `read_bytes` for files that can end inside a UTF-8 sequence, including torn JSONL lines. |
| `write`, `append`, `remove`, `exists` | explicit `Result` failures; do not report failed work as success. These ordinary methods alone do not promise crash durability. |
| `ensure_dir(path)` | prepare the parent of the supplied **file path**, not a directory named after it |
| `list_directory`, `list_recursive` | complete file paths, not bare names or directory entries; direct children vs all descendants; stable ordering where possible |
| `watch`, `watch_dir` | return a `WatchHandle`; stop releases the subscription. Report replacement, creation and removal, including descendants for directory watches. |
| `replace_durable(path, data)` | success only when the complete new file is recoverable after process/machine interruption; recover or retain the committed state on failure |
| `append_durable(path, keep_len, data)` | truncate the torn suffix to `keep_len`, append, synchronize bytes and length, and synchronize the directory when newly created |
| `read_tail(path, max_tail)` | return byte length plus up to `max_tail` final bytes, or `None` when absent; do not decode a partial UTF-8 tail |

Use consistent path identifiers in storage, listings and watch events. `StorageEvent` contains optional `filename`, `kind: StorageEventKind::{Add, Change, Remove}`, and optional `path`. Supply `path` when known so native reload can distinguish its own append from an unrelated file with the same basename. Notifications can coalesce; the runtime reloads the authoritative contents. Do not invoke watch callbacks while holding a host lock that a callback needs for I/O. Managed watches must release their resources on stop/close.

Return `EngineError::Storage(Box<StorageError>)` for I/O failures with the original path, operation and optional structured JSON cause. Its wire tag is exactly `StorageError`; never rename `_tag` or coerce a structured cause to text. Preserve other typed engine errors when forwarding. Host paths are trusted configuration. Add sandboxing in the host when untrusted callers can choose paths.

`FsStorageHost` is the worked native implementation: it stages a replacement, synchronizes the file and directory, and uses per-file recovery markers. Native checks aggregate validation before it writes and publishes memory only after durable success. A host that returns early from `replace_durable` breaks that guarantee. Do not implement durability by calling an unsynchronized ordinary `write`.

`append_durable` and `read_tail` have correct defaults that read and replace a whole file. Override them for bounded append I/O. A wrapper around `FsStorageHost` must forward both methods as well as `replace_durable`, or appends fall back to full rewrites. `MemoryStorageHost` implements the contracts for in-process tests but does not survive process exit.

One runtime must own writable paths. Hosts do not implicitly supply cross-process locking, multi-file atomic commits, transactional watch delivery or backup. A remote host must state which acknowledgement is durable and how it recovers interrupted writes. Source conflict checks still have a race with another writer. See "Crash rule" below before implementing retries.

Test against the real backend: missing files, full path listings, byte reads, replace/reopen, file and directory sync failures, interrupted replacement/append, torn UTF-8 final lines, watch stop/replacement/removal, and writes to multiple files with a failure partway through. The conformance tests use temporary files and the filesystem durability fault interface; no live Coach directory is needed.

## Collection files

`DatabaseSourceConfig::CollectionFile` stores one collection in one file. Use it for array formats such as Prose and JSONL, which document sources cannot hold. The format comes from `format` or from the path extension. A missing file is an empty collection. A mutation rewrites the file only when its collection changed, so writes to other collections leave it untouched.

A Prose collection file needs `prose: Some(ProseCodecOptions { template: Some(..), .. })`. The source builds its own codec from these options, so two Prose files never share a learned template. The first write creates the file with its `@prose` header. Decoding uses the file's own directive; encoding uses the configured template, so a file written with an older template loads and is rewritten with the new one.

Set `unmatched_lines: UnmatchedLines::Error` when the file is a database. Opening then fails on any non-blank line that is not a record, an overflow line, or a continuation, and the error names the line. With `Ignore`, such lines are skipped on load and lost on the next write.

Prose keeps value types: a string whose bare text would read as a number, boolean, null, array, or quoted text is written in quotes, and quoted text always decodes as a string. Arrays are written bare and end at their closing bracket. A number, boolean, or null that contains the template literal after it cannot be encoded, and the write fails.

Each changed collection file is rewritten whole. A 1.9 MB Prose file with 12,112 records takes about 75 ms per durable mutation on a desktop SSD.

## Partitioned collections

`DatabaseSourceConfig::Partitioned(PartitionedSourceConfig { id, collection, root, format, partition_by, prose })` stores one collection across flat `<root>/<key>.<format>` files. A missing root is empty. All files load into one queryable collection.

Use `PartitionKey::Field { field }` for a string field's complete value. Use `PartitionKey::Prefix { field, delimiter }` for its prefix before the first delimiter. The delimiter must be nonempty and present in every value. For example, `field: "id"` and `delimiter: "."` route `meeting-a.0001` into `meeting-a.prose`. The library does not know about meetings.

Use `PartitionKey::TimeBucket { field, bucket }` to derive the key from a timestamp. `TimeBucket::Year`, `Month` and `Day` give `YYYY`, `YYYY-MM` and `YYYY-MM-DD`. For example, `field: "timestamp"` and `bucket: TimeBucket::Month` route `2026-04-01T08:15:00.123Z` into `2026-04.jsonl`, so records need no redundant `month` field. The value must be a UTC string `YYYY-MM-DDTHH:MM:SS(.f+)?Z` with a valid calendar date and time. An offset other than `Z`, a missing `Z`, a date without a time, or an invalid date such as `2026-02-29` fails with `SourceConfigError`: on a write before any file changes, and on open naming the file. The bucket only reads the leading characters, so it never converts time zones. The TypeScript shape is `{ kind: "timeBucket", field, bucket: "year" | "month" | "day" }` in `packages/core` and applies the same rules in the WASM engine and the legacy core runtime; there, like other keys, the check runs when the partition is saved.

Keys start with an ASCII letter, digit, `_`, or `-`. Remaining characters can also include `.`. Empty keys, leading dots, slashes, backslashes, and other characters fail before writes. Fields must be strings. These are filename rules, not a filesystem sandbox. The configured root remains trusted.

Prose partitions require `ProseCodecOptions` with a template, just like collection files. Set `UnmatchedLines::Error` for database files. Each file uses its own codec. Opening rejects duplicate array IDs and records in the wrong partition. Versioned partitions require an object-keyed format because Prose and JSONL do not store a version envelope.

A mutation groups the candidate records, then encodes only net changed partitions. Updates to the partition field move records between files. Deletes leave empty files with their format header or empty collection. Unchanged files, no-op mutations, flush, and close remain unchanged. Source overlap and intervening edits fail before durable replacement. The existing crash rule applies, including partial commits and quarantine after write failure.

Partitioning reduces write size. On its own it does not reduce aggregate memory use, grouping work, or recursive watch polling. Managed reload discovers new partition files, including creation under an initially absent root. Append-only collections skip the grouping work (see "Append-only collections"). Lazy partitions scan only the selected scope and poll watch-covered generations (see "Lazy partitions").

## Time-series settings

| Setting | Where | Default | Native | Cost |
|---|---|---|---|---|
| Append-only | `CollectionDescriptor.append_only: true` on a JSONL/NDJSON `CollectionFile` or `Partitioned` source | `false` | creates append lines; update, delete and upsert are refused | one line, a 4 KiB tail read and one file sync per create |
| Duplicate IDs | `CollectionDescriptor.duplicate_ids: DuplicateIdPolicy` (`"error"`, `"ignore_identical"`) | `"error"` | identical re-creates write nothing | one stored-record comparison per create |
| Time bucket | `PartitionKey::TimeBucket { field, bucket: TimeBucket::{Year, Month, Day} }` | — | key `YYYY`, `YYYY-MM` or `YYYY-MM-DD` from a UTC timestamp | none measurable |
| Ordered index | `CollectionDescriptor.ordered_indexes: Vec<String>` | empty | ranges and single-field sorts use the index | about 175 B of memory per row; longer open |
| Lazy partitions | `NativeSourceRuntimeOptions.lazy_partitions: IndexMap<source id, LazyPartitionPolicy { max_loaded_partitions, full_scan }>` and `lazy_watch_interval` | empty map (eager), 2 s | open lists names; operations scan the selected scope; no row cache | first access to a partition reads and decodes it |

The new descriptor fields are omitted from serialized descriptors at their defaults, so existing descriptor JSON keeps its bytes. Every setting is opt-in. The sections below give the rules and limits.

## Append-only collections

Set `CollectionDescriptor.append_only: true` on a collection whose source is a JSONL or NDJSON `CollectionFile` or `Partitioned` source. A create then appends complete lines to the target file. It never encodes the existing file again. Append-only collections on other formats keep the rewrite path. The engine refuses `update`, `delete` and `upsert` with `OperationError` reason `append-only`, before any write.

A mutation persists append-only collections from the engine transaction journal:

1. The engine stages the candidate records.
2. The runtime routes only the new records to their files. It encodes them with the same encoder as a full rewrite.
3. For each target file it compares the file length and its final 4 KiB with the stored content. A difference fails with `OperationError` reason `source-changed` and nothing is written.
4. One durable append per file, in sorted path order, writes the complete `\n`-terminated lines and synchronizes the file (`fdatasync`), and its directory when the file is new.
5. The runtime publishes the engine state and records the new length and bytes as the stored file state.

No collection is snapshotted, regrouped or compared. One create therefore costs the encoding of its line, a 4 KiB tail read, one append and one file sync, whatever the size of the collection or the partition. Memory use does not change: every partition still loads at open, unless the source is lazy. A transaction that also changes other collections uses the rewrite plan for those collections only.

The rewrite encoder ends a JSONL file without a final newline. The first append to such a file writes the missing `\n` first. Record lines are byte-identical to the lines a full rewrite produces, so a later rewrite differs only by the final newline.

**Failures.** A failed append returns `StorageError` naming the completed paths and the failing path. The engine journal rolls back, and the runtime quarantines under the crash rule below. `FsStorageHost` also truncates the file back to its previous length. Memory never goes ahead of disk.

**Torn final lines.** A crash during an append can leave an incomplete final line. On open, for append-only JSONL files only:

- A final line without a trailing newline that does not parse is an interrupted append. The loader ignores it and reports it through `NativeRuntime::torn_line_diagnostics()`, with the path, line number and byte count. The next append to that file first truncates it to the last complete line.
- A final line without a trailing newline that parses is a valid record. The next append writes the missing newline first.
- Every other malformed line, including a malformed final line that has its newline, is still a strict codec error. Rewritable collections keep the strict behaviour for every line.

There is no batch journal. A crash during a multi-record append to one file can keep a prefix of its complete lines, and a crash between files keeps the completed files. Do not blindly retry a create unless the collection uses `duplicate_ids: ignore_identical`.

**Conflict check limits (eager appends).** Lazy appends additionally check generations and detect same-length prefix edits. The length and tail comparison does not see an external edit elsewhere in the file that keeps the same length. The managed watcher reload still sees such an edit, because it compares contents.

**Watcher.** The managed watcher does not reload after the runtime's own appends. When the host reports the changed paths (`StorageEvent.path`; `FsStorageHost` and `MemoryStorageHost` do), it skips a reload when every changed path is a file this runtime appended to and that file still equals its stored bytes. A same-named file elsewhere, for example under a graph source root that shares the watch root, has another path and reloads. When a host reports only file names, it falls back to the names: every file with that name under the watch roots must still equal its stored content, and a graph source root that shares a watch root forces a reload. Any other change reloads as before, and so does the directory change when an append creates a new file.

**Storage hosts.** `DurableStorageHost` has `append_durable` and `read_tail` with defaults that read the file and call `replace_durable`. The defaults are durable but cost a full rewrite. `FsStorageHost` overrides both. A host that wraps `FsStorageHost` must forward both methods to keep the append cost.

## Duplicate IDs

`CollectionDescriptor.duplicate_ids` sets how `create` and `create_many` treat an ID that already exists. The default `DuplicateIdPolicy::Error` keeps today's `DuplicateKeyError`. With `DuplicateIdPolicy::IgnoreIdentical` (`"ignore_identical"` in JSON):

- The same ID with the same payload succeeds, writes nothing and returns the stored record. The comparison runs after schema decode and defaults, uses JS number semantics (`81` equals `81.0`) and ignores the engine-filled `createdAt` and `updatedAt`.
- The same ID with a different payload returns `DuplicateKeyError` with the existing payload.
- `create_many` returns new and stored records in input order. If any record conflicts, nothing in the batch is written.

The policy is separate from `append_only`, so existing append-only users see no change. It suits importers that retry. The engine implements it once for native and WASM; TypeScript uses `duplicateIds: "error" | "ignoreIdentical"`. The legacy core runtime rejects the setting with `ValidationError`. The default is omitted from serialized descriptors, so existing descriptor JSON round-trips byte-identically. `NativeMutation::create_many` exposes batch creates in the native runtime.

## Runtime parity

| Feature | Native | WASM (`packages/engine`) | Legacy core (`packages/core` runtime) |
|---|---|---|---|
| After-hooks and `onChange` | deferred until durable commit, then dispatched outside the mutation lock | immediate, including inside transactions; errors swallowed | immediate; errors swallowed |
| `duplicate_ids` | yes | yes (engine) | rejected (fail closed) |
| Partitioned append without rewrite | yes | no, on purpose: partitioned sources keep the rewrite path | no |
| Torn-line recovery and durable append | yes | no; single-file `appendOnly` JSONL appends without a file sync and relies on the debounced canonical save | no |
| `TimeBucket` partition key | yes | yes (shared `partitioned-source.ts`) | yes |
| Ordered index | yes (ranges and sorts) | yes (engine; ranges only, because the binding sorts through the host) | accepted, not used for planning; same results |
| Lazy partitions | yes | no, on purpose | no |
| Native query stats (`partitions_loaded`) | yes | no (`explainQuery` gives `index_used` and `candidate_rows`) | no |
| YAML encoder | Rust codec (`proseql-formats`) with the write check | TypeScript `yaml` package through `@proseql/core` | TypeScript `yaml` package |

Lazy partitions are native only on purpose: the approved time-series contract keeps the WASM engine and the legacy core fully in memory, and lazy loading needs a host that can read single files on demand during a query.

Partitioned append is native only on purpose: the approved time-series contract keeps the rewrite path for partitioned sources in the WASM engine. Its source-oriented configuration also rejects `appendOnly` as an old-style persistence field, so a TypeScript partitioned collection cannot be append-only today.

## JSONL and diagnostics

The built-in JSONL codec remains strict. `proseql_formats::codecs::lenient_jsonl_codec()` replaces malformed lines with `{ "__jsonlParseError": true, "line": N }`. Blank lines count toward physical line numbers but produce no row. A transform must consume the markers and report warnings through an injected sink. Valid rows without a string ID are ignored by the Coach example. Equal IDs use the last row. The transform removes physical IDs before schema validation.

`document_graph_diagnostics()` returns fragment diagnostics from the last accepted graph snapshot. `last_reload_error()` reports a failed reload. Custom transform warnings are separate from fragment diagnostics.

## Ordered indexes

`CollectionDescriptor.ordered_indexes` lists fields that get an ordered (range) index, one field path per entry. Dot paths through nested structs are allowed. The TypeScript name is `orderedIndexes`. The field is omitted from serialized descriptors when empty, so older descriptor JSON keeps its bytes. Opening fails with `ValidationError` (issue field `ordered_indexes`) when an entry is not a declared schema field, is a computed field, or is listed twice.

The planner uses the index for `$gt`, `$gte`, `$lt` and `$lte` on the field, at the top level of the where clause and inside `$and`, so `{ timestamp: { $gte: A, $lt: B } }` and `{ $and: [{ timestamp: { $gte: A } }, { timestamp: { $lt: B } }] }` both qualify. Other conditions in the same clause still run on every candidate. A comparison inside `$or` or `$not`, an equality, or a nested object shape does not use the index; that query scans as before. An equality index on the same clause wins.

The index copies the engine's comparison rules, so results never change: a string operand bounds string values bytewise and does not constrain numbers, and a number operand bounds numbers and does not constrain strings. Null, missing fields, booleans, arrays and objects never match a comparison. Store one type per indexed field; a field that mixes strings and numbers returns the other type's rows for every range, as the scan does.

A sort with one key on an indexed field reads rows in index order and stops at the limit, so newest-first pages do not sort the collection. Ties keep insertion order and null or missing values come last, as in the ordinary sort. The index does not order the sort when the field holds both strings and numbers, or booleans, arrays or objects; when a string collator is registered; when the host sorts (the WASM binding registers `localeCompare` as a host sort, so `@proseql/engine` uses ordered indexes for ranges only); with a top-level `$search`; or with computed fields to materialize. Those queries sort as before. Cursor queries and aggregates use the same candidates.

`Database::explain_query(collection, &QueryInput)` returns `QueryStats { index_used, candidate_rows, index_sorted }` without running the query. `index_used` is `none`, `equality`, `ordered` or `search`. Native callers use `runtime.read(|db| db.explain_query("heartrate", &input))`, or `NativeRuntime::query_with_stats`, which runs the query and adds `partitions_loaded` (see "Lazy partitions"); the WASM boundary method is `explainQuery`.

Costs: each indexed row holds an encoded key, its insertion ordinal and its ID in a B-tree. The benchmark measured about 175 bytes of RSS per row for an ISO timestamp key (170 MiB at 1M rows). Opening builds the index after loading. Every insert, update and delete updates it in logarithmic time. Rollback, reload and snapshot restore rebuild it. Open took 7% to 14% longer in the benchmark; a one-hour query at 1M rows fell from 1.1 s to 21 µs. See `docs/benchmarks/timeseries.md` (Step 4). The legacy TypeScript core accepts `orderedIndexes` and ignores it for planning.

## Lazy partitions

Streaming is the only lazy execution model. Eager collections keep the resident
engine. The 13 round-1 [changed guarantees](design/query-while-scanning.md#changed-guarantees)
and the approved round-2 additions now apply to every lazy caller.
`ExecutionModel` and `NativeSourceRuntimeOptions::execution_model` are deprecated
compatibility items. The default is `Streaming`; `Resident` behaves identically.
Existing option literals, including Logbook's explicit Streaming setting, compile
without edits (with deprecation warnings).
The [cutover verification report](../bench/acceptance/results/cutover-round2.md)
records the tested SHA, full release-check and consumer results.

Native only. Set `NativeSourceRuntimeOptions.lazy_partitions` to map a source ID to a policy:

```rust
NativeSourceRuntimeOptions {
    lazy_partitions: IndexMap::from([(
        "heartrate".to_owned(),
        LazyPartitionPolicy { max_loaded_partitions: 4, full_scan: FullScanPolicy::Error },
    )]),
    ..Default::default()
}
```

The default is an empty map, so every existing configuration stays eager. `NativeSourceRuntimeOptions.lazy_watch_interval` (default 2 s) sets how often the managed watch polls lazy sources.

**Preconditions.** The source must be a `Partitioned` JSONL or NDJSON source. Its collection must have `append_only: true`, no `unique_fields`, no relationships, and no other collection may have a relationship to it. Otherwise open fails with `SourceConfigError` naming the source. `max_loaded_partitions` is accepted but ignored. No lazy partitions stay resident. Lazy collections must have no hooks, computed fields or migrations, even when the callbacks are registered. Global hooks are also refused when a runtime has lazy sources. Eager collections support these callbacks.

**Open.** Open lists partition file names without decoding their rows. Listing time and filename metadata grow with partition count, not record count within each file. Source sessions discard this manifest when they close.

**Partition pruning.** Reads refresh the manifest and select files from the
partition-field filter before scanning. The runtime reads the conditions on the partition field: a direct value, `$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte` and `$startsWith` with string operands, at the top level and through `$and` and `$or`. For a `TimeBucket` key, each bound is cut to the bucket length (`2026-04-10T05:00:00.000Z` → `2026-04`), which keeps the string order, so a range of timestamps maps to a range of file keys. For a `Field` key the value is the key. A `Prefix` key prunes on equality and `$in` only, because the prefix does not keep the string order.

Pruning compares string intervals and is conservative: it never skips a partition that can hold a match. The cost is that edges can select one more partition than the data needs. Timestamps may carry any number of fraction digits, so `2026-05-01T00:00:00.0000Z` sorts before `2026-05-01T00:00:00.000Z`; a query `{ $gte: "2026-04-01T00:00:00.000Z", $lt: "2026-05-01T00:00:00.000Z" }` therefore selects April and May. An upper bound at or below the first possible timestamp of a bucket excludes it: `$lt: "2026-05-01T00:00:00"` selects only April. Records live only in the file of their own key, because scanning rejects wrong-partition records.

**Preconditions and policy remain binding.** An unprunable query, aggregate or
watch scans every partition with `FullScanPolicy::Allow`, or fails with
`OperationError`, reason `lazy-full-scan`, with Error. An index cannot bypass
this policy. ID lookup requires Allow, except for records staged in the current
mutation. Relationships, unique fields, hooks, computed fields and migrations
remain unavailable on lazy collections. Use runtime APIs, not raw engine calls,
for lazy data.

### Query while scanning


Every configured lazy collection uses this path. Remove old query-then-`read`
hydration and zero-limit warm-up probes. Consume returned rows instead. Eager
collections, YAML write safety and on-disk text formats are unchanged.

**Reads and memory.** Runtime query, cursor, aggregate and bounded-read methods
scan selected JSONL/NDJSON files through 64 KiB host chunks and reusable line
buffers. They validate scanned rows, filter/project while scanning, and preserve
global stable ordering, cursors and individual f64 accumulation order. They never
load a lazy partition into the engine. `max_loaded_partitions` is ignored under
all lazy collections; no lazy LRU, resident read cache or pins remain.

Memory includes the longest physical line, query-local ID metadata, returned
records, sort/top-k/cursor or group workspace, derived indexes, append baselines
and watch results. Search and equality-union ordering can buffer matching rows.
Custom JSONL codecs decode and verify one whole partition at a time without
positional seeks. Canonical error replay and append-baseline construction can
also use one partition's bytes. No constant-RSS or allocator-reclamation promise
is added. YAML is never lazy: eager documents retain original bytes, decoded
records and candidate serialized output during writes. Multiple documents can
retain their combined sizes. YAML byte preservation and fail-closed safety stay
unchanged.

**Indexes and creates.** Sparse time offsets are built on first eligible range
use and checked against source generations. Unsorted files and custom codecs
decline positional seeking. The first `find_by_id` builds global ID membership
and validates every row once per generation. A create's first duplicate check
scans only ID fields, then validates matching candidates, not unrelated payloads.
Round-2 synthetic aka point lookups take about 0.6–0.8 s and retain about 10 MiB
of locator metadata; these still miss SQLite targets. No binary sidecar is written. Embedded ID timestamps are not trusted
as routing invariants.

Creates check duplicates globally, not only loaded/routed partitions.
`ignore_identical` still compares validated records. The engine stages the batch
and verified duplicate candidates, never entire partitions. Generated batch IDs
are resolved before validation and need not be gap-free. Own creates immediately
appear in path/file natural order. Existing durability, rollback, partial-file
commit and quarantine behavior stays. Generation checks also catch same-length
prefix edits. Concurrent source changes during index building or verification
fail explicitly with `source-changed`/`streaming-source-changed`; no snapshot
isolation or cross-process lock is added. Schema/query callbacks must be pure
predicates; their order and invocation count can change.

**Full-scan policy and `read`.** Indexes never bypass FullScanPolicy. Under Error,
`find_by_id` always fails with `lazy-full-scan`, except for records created earlier
in the same mutation. There is no cached-hit exception. Use
Allow or a partition-filtered query instead. `NativeRuntime::read` sees no lazy
rows: a `query_bounded` with `limit: 0` does not populate a cache.
Consume returned rows, use `select`, or aggregate inside the runtime instead.

**Watches and reload.** A streaming watch retains delivered results, a serialized
equality baseline and covered file generations, not covered rows. Initial
results, own/external deliveries, debounce and last-known-good delivered results
after invalid edits stay. The lazy poller lists files and checks live-watch
generations on `lazy_watch_interval`. Own appends do not cause duplicate poller
deliveries. Unwatched reads see the current file and fail on invalid edits;
`reload()` reports lazy validation errors only for watched partitions. This was
already Resident behavior whenever a partition was not cached. Eager reload
last-known-good is unchanged.

| Stats field under Streaming | Meaning |
|---|---|
| `partitions_loaded`, `partitions_visited` | Selected partition scope, not loaded rows |
| `partitions_read` | Existing files opened by the query |
| `partitions_resident`, `pinned_partitions`, `retained_partition_limit` | 0 |
| `candidate_rows` | Validated scan rows, including rows filtered/paged out |
| `index_used` | Positional seeking, not resident equality/search indexes |
| `index_sorted` | false; the executor sorts |
| `lazy_partition_status.loaded`, `.pinned` | Always empty |

Eager stats keep their previous meaning. All public bounded, mutation, watch
and status functions remain available. `max_loaded_partitions` is ignored.

### Bounded reads

The existing method names remain source-compatible. All lazy query entry points
now scan; the bounded methods are no longer a separate residency strategy.

| Method | Behavior |
|---|---|
| `query_bounded(collection, input)` | One globally ordered/selected page |
| `query_bounded_with_stats(collection, input)` | Same results plus physical scan stats |
| `query_cursor_bounded(collection, input, cursor)` | One global cursor page |
| `aggregate_bounded(collection, where_clause, config)` | Individual f64 additions in canonical order |
| `aggregate_grouped_bounded(collection, where_clause, group_by, config)` | Same addition order; first-encounter group order |

These methods never concatenate monthly pages or merge monthly partial sums.
Search and equality-index unions can buffer matching rows to preserve canonical
candidate and f64 order. Min/max keep comparable-value rules and first ties.
Memory grows with output, matching-row buffers, groups and visited-ID metadata,
not a configured resident-partition limit. Custom codecs and canonical error
replay can decode one whole partition. This is not a constant-memory promise.
Non-lazy collections still use the engine's ordinary resident query path.

First-use eligible range scans validate the full file while building time
checkpoints; later checked seeks can skip outside-range invalid rows. Every row
actually scanned is validated. `candidate_rows` counts validated scan rows, not
index-maintenance rows. `NativeQueryStats::index_used` is Ordered only for an
actual seek, not first-use index construction.

`release_streaming_indexes()` drops derived ID/time indexes, validated generations
and append proofs, while retaining codec context. It trades retained allocations
for rebuild work. It does not promise RSS reclamation. No binary cache is written.
Hosts returning `FileStat::change_id = Some` must change that token on every
content edit, append, truncation and replacement. Other hosts return None and
use checked-prefix hashing. Metadata tokens alone never authorize accepting an
own append: checked prefix evidence is still required. The additive durable-host
`append_durable_with_identity` method can supply that evidence from its open
append descriptor. Its safe default calls `append_durable` and returns None,
which keeps the runtime's separate checked-prefix proof.

Fs reads the kept prefix after the append sync, compares the read-back suffix
with the requested bytes, and checks descriptor metadata before and after that
read-back. The runtime compares the prefix hash with its pre-append baseline,
then freshly checks the path's accepted generation before publishing derived
coverage. The prefix is still read once; only separate post-commit prefix reads,
opens and recovery probes are removed. Torn baselines conservatively keep the
old proof. A read-back failure discards evidence, not a durable success.

There is no exclusive filesystem lock. An external prefix edit during the
write changes the checked hash; a suffix edit fails read-back; replacement of
the path after open fails the runtime's fresh path check. A change after that
last check and before metadata publication is still possible, as with the old
proof. The next operation freshly checks cached generations. This does not add
snapshot isolation or permit concurrent writable runtime owners.

See the [read report](benchmarks/query-while-scanning-perf-read.md),
[write report](benchmarks/query-while-scanning-write-round2.md) and
[design](design/query-while-scanning.md) for measured costs, limits and adoption.

### Decode and source-buffer ownership

Built-in append JSONL/NDJSON loading parses every physical nonblank line once, including a valid unterminated or torn final line. ID checks inspect that decoded value. Owned schema decoding moves string/array payloads instead of cloning them. It still applies NumberFromString, optional/undefined, unknown-field stripping, Record-key checks and host checks. Registered custom codecs retain their whole-file decoder interface; fallback tail classification can parse an unterminated final line separately.

Lazy scans use chunked host reads. Append preparation can capture one target's
bytes to build its compact durable baseline (length, tail and prefix hash).
Own appends extend derived state only after durable success and checked prefix
proofs. Eager rewrite/document sources retain full bytes where conflict checks
and byte-preserving replacement need them. No rewrite is reconstructed from a
tail. Resident eager rows remain insertion-ordered `serde_json::Value`.

### Configuration for a monthly heart-rate collection

```rust
let descriptor = CollectionDescriptor {
    name: "heartrate".into(),
    // id, timestamp, bpm, source
    append_only: true,
    duplicate_ids: DuplicateIdPolicy::IgnoreIdentical,
    ordered_indexes: vec!["timestamp".into()],
    unique_fields: vec![],
    relationships: vec![],
    ..
};
let source = DatabaseSourceConfig::Partitioned(PartitionedSourceConfig {
    id: "heartrate".into(),
    collection: "heartrate".into(),
    root: "/data/oura/heartrate".into(),
    format: "jsonl".into(),
    partition_by: PartitionKey::TimeBucket { field: "timestamp".into(), bucket: TimeBucket::Month },
    prose: None,
});
let options = NativeSourceRuntimeOptions {
    lazy_partitions: IndexMap::from([(
        "heartrate".to_owned(),
        LazyPartitionPolicy { max_loaded_partitions: 4, full_scan: FullScanPolicy::Error },
    )]),
    ..Default::default()
};
```

Use IDs `heartrate:<timestamp>`. Query with a `timestamp` range through `NativeRuntime::query_with_stats` or `query`, and append with `mutate(|db| db.create_many("heartrate", samples))`; retries of the same samples write nothing.

## Approved test boundaries

Tests use the public native runtime, real files in temporary directories, custom codecs and graph transforms, and the filesystem durability fault interface. The fault points `AppendWrite` (after half of the append's bytes) and `AppendSync` (before the file sync) cover durable appends; a subprocess parked at `AppendWrite` and killed leaves a real torn final line. They observe record reads, mutation errors, reopened data, file contents, managed reload, and subprocess interruption. Tests do not call private runtime methods.

Coach compatibility checks use a temporary copy outside this repository. Never open the live Coach directory with this runtime. Its storage host can recover interrupted writes during reads. Never commit personal records or include them in logs.

## Crash rule

Source-mode mutations durably replace changed files in sorted path order. Each replacement synchronizes the staged file and containing directory and uses the existing per-file recovery markers. Append-only collections append to their files in the same sorted order instead; each append synchronizes the file, and the directory for a new file. Success means every replacement and append completed durably before the runtime publishes the engine transaction.

There is no batch journal. A process or machine crash between replacements can leave a prefix of changed files committed. Recovery does not reverse that prefix. A failed response does not prove that no change reached disk. Related records across files can disagree after an interrupted mutation.

A write-stage error quarantines the runtime. The error names completed paths and the failing path. Close releases watches without flushing a quarantined candidate. Reopen to recover each file and inspect the resulting data. Opening can fail if a partial mutation breaks a relationship. Repair a copy before replacing live data. Do not blindly retry a non-idempotent mutation.

Coach's installed `@proseql/node` 0.15.0 also writes documents sequentially with no batch journal. Its per-file writes use a temporary file and rename, but no explicit file or directory sync. The native source mode strengthens per-file durability without promising cross-file atomicity.

## Rewrite effects

Only files containing net changed records are rewritten. Existing records return to their origin file. New records go to the configured outbox. Deletes remove records from their origin. No-op mutations, flush, and close do not rewrite unchanged files.

Undeclared collection values and unchanged record payloads remain intact. Existing section and record positions remain intact. New records append. Re-encoded record fields follow descriptor order. Unchanged files remain byte-for-byte unchanged.

For YAML document sources, the loader retains the original text in `LoadedDocument.raw`. On a save, a line-based scan finds top-level collection blocks at column zero. Each block must decode independently to its loaded value. The planner copies unchanged blocks byte-for-byte, including quoting, wrapping, comments and blank-line separators. Changed blocks stay in their original order. New collections append at the end. Within a changed block-style collection, the same scan preserves unchanged record bodies at their original indentation. Separators stay in place when an adjacent record changes or is deleted. A record's body is the shortest span that decodes to its loaded value, so a block-scalar line that looks like a blank line or a `#` comment stays with its record. Changed records use the codec's quoting and wrapping (see "YAML writes").

This scan is not a YAML lexer. Root flow maps, indented root maps, complex or multiline collection keys, document markers/directives, and aliases across collections cannot be segmented safely. Changing an existing document with any such shape fails closed. The error is `OperationError`, with operation `save-document-source`, reason `unsupported-document-shape`, and a message containing the file path and the failure detail. No file is written. A document with no changed collections does not need segmentation and remains untouched.

An inline collection such as `gains: {}` is supported inside a block-style root map. An unchanged inline collection keeps its bytes. A changed flow-style collection, or a changed collection with aliases across records, can be emitted as a complete collection block. Only that changed collection is emitted; its neighbours are copied. Comments between collections, blank-line separators, CRLF, quoted keys, and a last block without a final newline remain intact. Appending after an unterminated last block adds a separating newline without replacing that block.

The planner reparses the complete splice and compares it with the projected persisted values using JS number semantics. A parse error or a mismatch also returns `unsupported-document-shape` before any write. It never falls back to whole-document serialization. This check guards scalar chomping and retained blank-line interactions. Existing non-YAML document sources do not have a byte-preserving editor and therefore fail closed when changed. New files have no untouched blocks and can use complete serialization, but their encoding must still pass the same parse-and-state check.

The planner still serializes the complete candidate before splicing, so custom whole-document codec validation and serialization errors keep their existing contract. Splicing reduces byte changes, not serialization work. It adds retained text and per-save parsing work. The saved metadata receives the emitted bytes only when the runtime accepts the durable commit. Callers that construct `LoadedDocument` directly without a text snapshot can use `raw: None`; attempts to change those documents fail closed. Conflict detection and durable replacement operate on the resulting complete file, unchanged.

Preserving an undeclared collection does not preserve excess fields inside an updated declared record. Use a complete schema for each declared collection.

Writable sources require one runtime owner. Before a write, the runtime compares affected files with loaded content and rejects intervening edits. This is conflict detection, not a filesystem lock. Another writer can still race the comparison and replacement.

## YAML writes

Every YAML file that the native runtime writes must read back to the value it wrote. Two parts enforce this: the encoder rules below, and a write check that refuses any output that does not read back.

**Write check.** `FormatRegistry::serialize` decodes the output of every codec whose `FormatCodec::round_trips_exactly` is true and compares it with the input. Numbers compare with JS number semantics (`1` equals `1.0`); key order does not matter. The built-in YAML codec returns true. Other built-in codecs, plugin codecs and custom codecs return the default `false` and are not checked. Every durable write of codec output goes through `serialize`: collection files, partitions, document sources, single-file mode and migration write-back.

A mismatch returns `SerializationError` with `format: "yaml"`, a message that starts with `Refused to write yaml`, and `cause: { reason: "round-trip-mismatch", pointer?, detail }`. `pointer` is the JSON pointer of the first difference, such as `/2026.meal-0001/items/0/food`; it is absent when the output does not parse. The error names the location, never the values. Planning encodes every changed file before the first write, so a refused write rolls the mutation back with no file touched. Because nothing reached disk, the runtime is not quarantined and the next mutation can proceed (see "Crash rule").

The check is on by default. `FormatRegistry::set_write_check(false)` turns it off for a registry passed in `NativeSourceRuntimeOptions::formats` or `NativeRuntimeOptions::formats`. Turn it off only when the caller already decodes and compares the exact bytes it writes. Document sources run their own parse-and-state check on the spliced file in addition (see "Rewrite effects"), so a changed YAML document is decoded twice.

**Cost.** The check costs one decode of each written file. Measured with `cargo run --release -p proseql-native --example yaml_write_check_bench -- --lines 8000 --runs 100` on a synthetic partition of 800 meals (8,346 lines, 287 KB), on a 16-core machine under other load (load average about 16):

| Operation | Check off (median) | Check on (median) |
|---|---|---|
| `serialize` of the partition | 4.7 ms | 13.0 ms |
| One `create` into the partition (encode, durable replace with fsync) | 21.8 ms | 30.2 ms |

The check adds about 8 ms per write of that size, about 40% of a durable create. The default stays on: a write that cannot be opened again costs a restart loop and manual repair, which is worse than 8 ms per write. Write cost already grows with file size because a changed partition or file is encoded again in full.

**Encoder rules.** The codec writes block-style YAML with a default indent of 2 and folds long plain scalars at 80 columns (`yaml_codec_with(indent, line_width)` sets both). Output at indent 2 is unchanged for every value that already read back, except that keys starting with `---` or `...` and strings containing a BOM (U+FEFF) are now quoted. Only records that are written again get the new bytes. These rules changed after the 2026-10-21 failure:

- A folded plain scalar continues at the indent that its caller gives: one level deeper than its key. The first key of a list item (`- food: ...`) used to continue at its own column, which does not parse.
- A fold happens only at a single space between two non-blank characters. Text with runs of spaces or tabs keeps them.
- Multi-line text uses `|-` only when that reads back exactly. Text that ends with a line break, whose first non-empty line starts with a space or tab, or that contains `\r`, NEL, LS, PS, BOM or another control character is double-quoted instead.
- These strings are double-quoted: strings that the decoder reads as non-strings (`0x1A`, `0o17`, `0b101`, `+.inf`, `.NaN`, as well as the earlier `true`, `null`, `1e5` and similar), a lone `-`, `?` or `:`, strings that start with `-`, `?` or `:` and a tab, strings that end with `:` or a tab, strings that start with a tab, and strings with `:` and a tab. LS, PS and BOM are escaped inside quotes.
- At indent 4, a list item's keys share one column: `-   key: value`. Previously its later keys sat two columns to the right of the first key.
- Root keys that start with `---` or `...` are quoted.

**Files written before this change.** The decoder did not change, so every file that parses still opens with the same values. The old encoder wrote files that do not parse when:

- the first key of a list item held a plain string, with spaces, longer than the line width (the 2026-10-21 failure);
- a string value was a lone `-`, `?` or `:`, or ended with `:`;
- a string contained LS (U+2028) or PS (U+2029), which the parser reads as a line break;
- a multi-line string's first non-empty line started with a space or tab.

Open fails on such a file with `SerializationError` and a line and column; repair the named line by hand. The old encoder also wrote files that parse but changed some strings: `0x1A`-style text read back as a number and `.inf`/`.nan`-style text as `null` (a `String` field then fails validation on open), trailing line breaks were dropped, `\r\n` inside multi-line text became `\n`, leading and trailing tabs were dropped, and a fold next to a run of spaces could drop spaces. Those changes are already on disk and cannot be detected from the file.

These classes were checked by encoding with the encoder at `b7202d4` and decoding with the current decoder. For example, `0x1A` read back as `26` and `.inf` as `null`.

## Reload

Source-mode opening starts a managed directory watch by default. Reload is eventual, after the filesystem polling interval and debounce. A reload validates the aggregate database before publishing its records, origins and document metadata together. A malformed reload retains the last valid database and exposes `last_reload_error`.

The filesystem poller compares contents because notify 6 timestamps have only second precision. It recursively hashes watched files, including ignored files under the source root. This adds polling I/O. Lazy partitioned roots are not watched by this poller; the runtime polls them itself and checks only watch-covered generations (see "Lazy partitions"). Large raw-shard directories benefit from a longer polling interval through `open_sources_with_host`, a different host, or explicit reload. Source patterns still limit which files the loaders decode.

Optional missing roots and unmatched optional file patterns produce empty collections. Creation, replacement and removal of provider files trigger reload. Graph-owned collections reject mutations with `OperationError` reason `read-only-source`. They never participate in write projection.

## Coach copy check

The fixture at `crates/proseql-native/tests/fixtures/coach-schema.json` contains all 42 legacy descriptors and the Oura filename map. It contains no records. Its SHA-256 identifies the exact legacy schema source used to generate it.

From the proseql checkout, run:

```sh
./scripts/check-coach-copy.py
```

The script checks the legacy schema hash, rejects source symlinks, copies the data outside the repository, and runs the Rust `coach_compatibility` example against that copy. It compares every copied file's hash before and after open/close. It suppresses child output so record IDs and contents cannot enter logs. It removes the copy on success or failure. The example also refuses the live Coach directory.

The script accepts `--coach-repo PATH` and `--data-dir PATH` to check another source copy. It does not change or restart Coach or Comics. This repository provides a library, not a deployment target for either service.

Refresh the schema-only fixture when the legacy declaration changes:

```sh
./scripts/export-coach-schema.mjs ~/code/sandbox/coach crates/proseql-native/tests/fixtures/coach-schema.json
```

The exporter reads `legacy:src/app/data/db-config.ts` through Git. It uses Coach's installed TypeScript parser and rejects unsupported schema expressions. It never reads the data directory. Review and rerun the synthetic tests after refreshing the fixture.

The copy check verifies loading the current data, not writes to personal records. Synthetic filesystem tests verify write-back and crash behavior.

Native selects the engine's `owned-mutations` Cargo feature. Other hosts keep the
existing borrowed CRUD decode path. Both paths use the same schema semantics;
the feature avoids linking an additional owned decoder into the production
WASM artifact. It does not change a source configuration or a wire contract.


## Disposable index files

Native `FsStorageHost` can write derived files under each lazy partitioned
source's `<root>/.proseql-index/` directory. For `2025-05.jsonl` the files are
`2025-05.jsonl.ids.idx`, `2025-05.jsonl.valid.idx`, and
`2025-05.jsonl.time-<field-hash>.idx` for each used ordered field. Partition
listings and managed filesystem watch notifications ignore this directory.
WASM/browser and memory hosts do not persist indexes. Custom codecs, schemas
with checks/default callbacks, and migration configurations keep the text path:
closure implementations cannot be fingerprinted across processes.

Text remains the only source of truth. Delete `.proseql-index` at any time,
including while the runtime runs. Missing, unreadable, truncated, damaged,
old-format, old-index-version or different-schema files are cache misses, never
new database errors. Files can reappear on release or close. Orphan `*.tmp`
files are ignored and can also be deleted. Cache files are not an interchange
format or a substitute for text backups.

The little-endian versioned envelope contains magic, format/index versions,
relative text path, covered byte length, trusted change token and modification
time, a checked prefix hash, schema/config fingerprint, payload length and a
checksum over the entire envelope/payload. An unchanged trusted generation
needs metadata checks, not a text read. A grown file needs one checked hash
read per distinct covered prefix, shared across sidecar kinds, followed by
suffix scanning. Edits, truncation, replacement or mismatched prefixes rebuild
from text. Every restored source is checked again before publication. These
checks retain the existing race window; they do not add locking or snapshots.

ID sidecars contain hashes and exact file-local locations, never authoritative
IDs or records. The merged locator still checks cross-partition duplicate IDs,
including collisions verified against text. A stale or missing sidecar cannot
make a duplicate create succeed. Reads still decode/validate candidate records.
Validation records certify only the checked text generation under the saved
schema/config fingerprint. Loading membership without a validation record does
not bypass payload validation or validation-before-duplicate precedence. Its
checked validation prefix must cover the cached membership prefix; otherwise
the locator scans that file and validates the uncovered gap before merging.

Time sidecars are eligible only after whole-file canonical validation succeeded
under that fingerprint. A failed read disables pending time publication. A
grown time sidecar falls back to the canonical full-file scan: payload validation
of the suffix alone cannot prove that its IDs are unique against the prefix.
Existing in-memory safe-seek semantics remain unchanged. Tests compare invalid
original and appended payload errors with and without sidecars.

Publication uses a unique `create_new` temporary file and a same-directory
rename. There is deliberately no file or directory fsync for this derived data:
losing it only costs rebuilding. A crash before rename leaves the old index or
none; a power-loss-damaged file fails checksum/generation checks. Text append
sync, read-back evidence, rollback and quarantine rules do not change.

Writes are deferred to `release_streaming_indexes()` and successful `close()`,
not performed per appended row or per query. Checked own-appends advance locator
and validation coverage through the existing append evidence. A process that
exits without release/close may lose recent index work, never text. Index writes
and hashing can increase release/close latency. After loading a checked index,
publication reuses its checked full-prefix hash when the token is unchanged.

Disk cost: an ID payload is 24 bytes per row plus 24 bytes per file; a validation
payload is empty. Each envelope adds 112 bytes plus the relative-path byte
length. Time payloads use JSON scalar checkpoints inside the binary envelope,
one checkpoint every 32 rows, so cost depends on key length and field count.
The reader caps each individual sidecar at 64 MiB; larger indexes fall back to
text. This caps corrupt-file allocation, not collection size. Checksums detect
accidental damage, not a hostile writer forging cache files and checksums.
[Round-4 measured sizes, latency, memory and remaining misses](benchmarks/query-while-scanning-persist-round4.md).
