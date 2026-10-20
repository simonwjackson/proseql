# Native source runtime

The native source runtime opens writable document sources and read-only document graphs in one database. Collection schemas and existing data paths stay unchanged. The single-file `NativeRuntimeConfig { path, collections }` API remains available.

## Configuration

Use `NativeRuntime::open_sources(NativeSourceRuntimeConfig { collections, sources })` for built-in codecs and graphs without transforms. Each collection uses the same `NativeCollectionConfig` descriptor as single-file mode. Sources use the existing `proseql_storage::source_config::DatabaseSourceConfig` types.

Use `open_sources_with_options` to provide a format registry and graph transform host. Use `open_sources_with_host` to provide a durable storage host too. The options default to built-in codecs, no transform host, and a 50 ms watch debounce. The default filesystem host polls every two seconds. Set `watch_debounce` to `None` for explicit reload only.

Every declared collection must have exactly one source owner. Source mode rejects overlapping writable and graph file patterns for discovered files and outboxes. Use `UnknownCollectionPolicy::Preserve` on writable sources when the runtime declares only part of the database. Select only declared collections in those sources. A partial runtime must also declare the relationship targets its records need.

Source mode rejects `replace_all`; use `mutate` for app-owned changes. Single-file `replace_all` remains unchanged. Callback hooks, migrations, and named ID-generator registrations retain the single-file runtime's existing restrictions.

The consumer example at `crates/proseql-native/examples/support/coach.rs` maps the legacy Coach source configuration. It declares one writable source, two YAML graph sources, and one graph with fifteen JSONL roots. It supplies a custom transform and an opt-in lenient JSONL codec. Coach-specific names do not enter the library implementation.

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

Partitioning reduces write size. It does not reduce aggregate memory use, grouping work, or recursive watch polling. Managed reload discovers new partition files, including creation under an initially absent root. Append-only collections skip the grouping work; see the next section.

## Append-only collections

Set `CollectionDescriptor.append_only: true` on a collection whose source is a JSONL or NDJSON `CollectionFile` or `Partitioned` source. A create then appends complete lines to the target file. It never encodes the existing file again. Append-only collections on other formats keep the rewrite path. The engine refuses `update`, `delete` and `upsert` with `OperationError` reason `append-only`, before any write.

A mutation persists append-only collections from the engine transaction journal:

1. The engine stages the candidate records.
2. The runtime routes only the new records to their files. It encodes them with the same encoder as a full rewrite.
3. For each target file it compares the file length and its final 4 KiB with the stored content. A difference fails with `OperationError` reason `source-changed` and nothing is written.
4. One durable append per file, in sorted path order, writes the complete `\n`-terminated lines and synchronizes the file (`fdatasync`), and its directory when the file is new.
5. The runtime publishes the engine state and records the new length and bytes as the stored file state.

No collection is snapshotted, regrouped or compared. One create therefore costs the encoding of its line, a 4 KiB tail read, one append and one file sync, whatever the size of the collection or the partition. Memory use does not change: every partition still loads at open. A transaction that also changes other collections uses the rewrite plan for those collections only.

The rewrite encoder ends a JSONL file without a final newline. The first append to such a file writes the missing `\n` first. Record lines are byte-identical to the lines a full rewrite produces, so a later rewrite differs only by the final newline.

**Failures.** A failed append returns `StorageError` naming the completed paths and the failing path. The engine journal rolls back, and the runtime quarantines under the crash rule below. `FsStorageHost` also truncates the file back to its previous length. Memory never goes ahead of disk.

**Torn final lines.** A crash during an append can leave an incomplete final line. On open, for append-only JSONL files only:

- A final line without a trailing newline that does not parse is an interrupted append. The loader ignores it and reports it through `NativeRuntime::torn_line_diagnostics()`, with the path, line number and byte count. The next append to that file first truncates it to the last complete line.
- A final line without a trailing newline that parses is a valid record. The next append writes the missing newline first.
- Every other malformed line, including a malformed final line that has its newline, is still a strict codec error. Rewritable collections keep the strict behaviour for every line.

There is no batch journal. A crash during a multi-record append to one file can keep a prefix of its complete lines, and a crash between files keeps the completed files. Do not blindly retry a create unless the collection uses `duplicate_ids: ignore_identical`.

**Conflict check limits.** The length and tail comparison does not see an external edit elsewhere in the file that keeps the same length. The managed watcher reload still sees such an edit, because it compares contents.

**Watcher.** The managed watcher does not reload after the runtime's own appends. It skips a reload when every changed file name is a file this runtime appended to, and every file with that name under the watch roots still equals its stored content. It reloads as before when any other file changes, when a graph source root shares a watch root with the appended file (the event names only a basename), and once when an append creates a new file (the directory changes).

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
| `duplicate_ids` | yes | yes (engine) | rejected (fail closed) |
| Partitioned append without rewrite | yes | no, on purpose: partitioned sources keep the rewrite path | no |
| Torn-line recovery and durable append | yes | no; single-file `appendOnly` JSONL appends without a file sync and relies on the debounced canonical save | no |
| `TimeBucket` partition key | yes | yes (shared `partitioned-source.ts`) | yes |

Partitioned append is native only on purpose: the approved time-series contract keeps the rewrite path for partitioned sources in the WASM engine. Its source-oriented configuration also rejects `appendOnly` as an old-style persistence field, so a TypeScript partitioned collection cannot be append-only today.

## JSONL and diagnostics

The built-in JSONL codec remains strict. `proseql_formats::codecs::lenient_jsonl_codec()` replaces malformed lines with `{ "__jsonlParseError": true, "line": N }`. Blank lines count toward physical line numbers but produce no row. A transform must consume the markers and report warnings through an injected sink. Valid rows without a string ID are ignored by the Coach example. Equal IDs use the last row. The transform removes physical IDs before schema validation.

`document_graph_diagnostics()` returns fragment diagnostics from the last accepted graph snapshot. `last_reload_error()` reports a failed reload. Custom transform warnings are separate from fragment diagnostics.

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

For YAML document sources, the loader retains the original text in `LoadedDocument.raw`. On a save, a line-based scan finds top-level collection blocks at column zero. Each block must decode independently to its loaded value. The planner copies unchanged blocks byte-for-byte, including quoting, wrapping, comments and blank-line separators. Changed blocks stay in their original order. New collections append at the end. Within a changed block-style collection, the same scan preserves unchanged record bodies at their original indentation. Separators stay in place when an adjacent record changes or is deleted. Changed records use the codec's quoting and wrapping.

This scan is not a YAML lexer. Root flow maps, indented root maps, complex or multiline collection keys, document markers/directives, and aliases across collections cannot be segmented safely. Changing an existing document with any such shape fails closed. The error is `OperationError`, with operation `save-document-source`, reason `unsupported-document-shape`, and a message containing the file path and the failure detail. No file is written. A document with no changed collections does not need segmentation and remains untouched.

An inline collection such as `gains: {}` is supported inside a block-style root map. An unchanged inline collection keeps its bytes. A changed flow-style collection, or a changed collection with aliases across records, can be emitted as a complete collection block. Only that changed collection is emitted; its neighbours are copied. Comments between collections, blank-line separators, CRLF, quoted keys, and a last block without a final newline remain intact. Appending after an unterminated last block adds a separating newline without replacing that block.

The planner reparses the complete splice and compares it with the projected persisted values using JS number semantics. A parse error or a mismatch also returns `unsupported-document-shape` before any write. It never falls back to whole-document serialization. This check guards scalar chomping and retained blank-line interactions. Existing non-YAML document sources do not have a byte-preserving editor and therefore fail closed when changed. New files have no untouched blocks and can use complete serialization, but their encoding must still pass the same parse-and-state check.

The planner still serializes the complete candidate before splicing, so custom whole-document codec validation and serialization errors keep their existing contract. Splicing reduces byte changes, not serialization work. It adds retained text and per-save parsing work. The saved metadata receives the emitted bytes only when the runtime accepts the durable commit. Callers that construct `LoadedDocument` directly without a text snapshot can use `raw: None`; attempts to change those documents fail closed. Conflict detection and durable replacement operate on the resulting complete file, unchanged.

Preserving an undeclared collection does not preserve excess fields inside an updated declared record. Use a complete schema for each declared collection.

Writable sources require one runtime owner. Before a write, the runtime compares affected files with loaded content and rejects intervening edits. This is conflict detection, not a filesystem lock. Another writer can still race the comparison and replacement.

## Reload

Source-mode opening starts a managed directory watch by default. Reload is eventual, after the filesystem polling interval and debounce. A reload validates the aggregate database before publishing its records, origins and document metadata together. A malformed reload retains the last valid database and exposes `last_reload_error`.

The filesystem poller compares contents because notify 6 timestamps have only second precision. It recursively hashes watched files, including ignored files under the source root. This adds polling I/O. Large raw-shard directories benefit from a longer polling interval through `open_sources_with_host`, a different host, or explicit reload. Source patterns still limit which files the loaders decode.

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
