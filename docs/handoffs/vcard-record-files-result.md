# Return handoff: native record files and vCard codec

## Status

The implementation is on `main` and pushed to `origin/main` in `simonwjackson/proseql`.
The rebase onto `main` changed no commits. Landing was a fast-forward, with no merge commit.

- Implementation and review fixes: `cf2fad811f8a391d111feb1645e4cf60a37e78c2..69465bc23bdcfc5c53752f75c2e4b2171a898ea4`.
- Exact source verified on AKA: `69465bc23bdcfc5c53752f75c2e4b2171a898ea4`.
- This return-handoff document is a later documentation-only commit.
- The crates were not published to a registry. Consume the repository through path dependencies or a pinned Git revision.

Both independent reviews ended with no must-fix findings. Real Google-export compatibility remains **unverified**. All card fixtures are explicitly synthetic.

## What the downstream agent must do

1. Update the downstream ProseQL dependencies to the implementation revision above, or a descendant that contains it.
2. Register `proseql_vcf::VCardCodec` explicitly. Use `vcard_schema()` and `IdStrategy::DerivedFromKey` for the contacts collection.
3. Configure a `DatabaseSourceConfig::RecordFiles` source with `format: "vcf"` and the contacts folder as `root`.
4. Decode each new raw card with `VCardCodec.decode(raw)`, add the chosen filename ID, then create or replace the record.
5. Connect `on_record_files_reload` to the downstream sync-log code. Account for the notification and crash limits below.
6. Verify a sanitized real Google 3.0 export and the downstream clients' 4.0 cards before claiming that acceptance item passes.

The CardDAV protocol, ETags, sync-log implementation, auth, geocoding and Google synchronization remain downstream work.

## Part A: RecordFiles source

Public types are in `proseql_storage::source_config`:

```rust
use proseql_storage::source_config::{DatabaseSourceConfig, RecordFilesSourceConfig};

let source = DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig {
    id: "contact-files".into(),
    collection: "contacts".into(),
    root: "./contacts".into(),
    format: "vcf".into(),
});
```

The normalized source enum uses the same config struct, with normalized root and extension.

| Area | Delivered behavior |
|---|---|
| Layout | One collection per source, one object per flat `<root>/<id>.<format>` file, no recursion. |
| Identity | The filename stem is the record ID, not the vCard UID. `DerivedFromKey` hydrates an in-memory ID and removes it before encoding. |
| Provided IDs | Supported only when the payload ID equals the filename stem. Missing or mismatched IDs fail on open. |
| Missing root | Opens as an empty collection. First create makes the folder durably. Managed watching covers an existing ancestor. |
| Filtering | Dot entries, directories and other extensions are ignored. Matching arrays, scalars, malformed bytes or invalid stems fail with a file path. |
| Create/update/delete | Create writes one file. Update replaces only net changed files. Delete unlinks the file and synchronizes its directory. |
| No change | No-op mutations, unchanged siblings, `flush` and `close` write nothing. |
| Planning | All changed files are encoded and write-checked before the first durable operation. A preflight or codec failure rolls memory back without touching files. |
| Conflicts | Per-file source generations reject intervening target-file edits before durable writes or removal. This is not cross-process locking. |
| Reload | Explicit and managed reload discover additions, edits and removals. Invalid bytes keep the last accepted state and baseline. A later valid edit recovers. |
| Sessions | `NativeSourceSessions` retains codecs and callbacks across reopen without retaining loaded records at idle. |

IDs use the existing `safe_component` rule: nonempty ASCII alphanumeric characters, `-`, `_` and `.`, with no leading `.`.
An invalid create ID fails before writes. An invalid matching non-dot stem found on open fails with its file path.
Dotfiles are intentionally ignored, as requested for Radicale metadata.

The extension accepts one optional leading dot and is ASCII-lowercased: `.JSON` becomes `json`.
Compound extensions such as `card.json` fail configuration validation before writes.
This avoids treating part of the configured extension as part of the record ID.

`MemoryStorageHost` has permanent separate virtual roots: `.` for relative paths and `/` for absolute paths.
Their listings and watches stay in their own namespace. Missing relative roots work with default managed watching.
A custom host with no available watch ancestor receives `OperationError` reason `watch-root`, rather than looping.

### Durable host and crash contract

`DurableStorageHost` adds `preflight_remove_durable(path)` and `remove_durable(path)`.
Custom hosts must implement both for deletion. The defaults refuse deletion before batch writes rather than unlinking without durability.
`FsStorageHost` synchronizes the containing directory after unlink. It also synchronizes newly created parent-directory chains.
`MemoryStorageHost` implements the in-process contract, not machine-crash persistence.

Mutations execute sorted durable operations after preflight. There is no batch journal or cross-file atomic commit.
A crash or I/O failure partway through can leave a committed prefix on disk. The runtime rolls back staged memory and quarantines after write failure.
Reopen and inspect before retrying a failed batch. A failed response does not prove that disk stayed unchanged.

## Record-level reload notifications

The shared engine `ChangeEvent` shape is unchanged. Native source options add an optional callback:

```rust
use proseql_native::{NativeSourceRuntimeOptions, RecordFilesReload};
use std::sync::Arc;

let options = NativeSourceRuntimeOptions {
    on_record_files_reload: Some(Arc::new(|diff: RecordFilesReload| {
        // Forward to the downstream sync-log owner.
        // diff.source_id: String
        // diff.collection: String
        // diff.added: Vec<String>
        // diff.changed: Vec<String>
        // diff.removed: Vec<String>
    })),
    ..Default::default()
};
```

The ID vectors are sorted. Diffs compare per-file generations, not every decoded payload.
A byte edit that leaves parsed values unchanged still reports a changed generation.
Callbacks run after an accepted source/engine commit and outside runtime locks. Reentrant reads and mutations are tested.
Unchanged reloads and the runtime's own writes emit no record-file diff. A rejected reload emits no accepted diff.

These are accepted-snapshot notifications, not an exactly-once transactional outbox.
Watch notifications can be coalesced. Do not assume every transient external file version becomes a separate callback.
A process crash between acceptance and downstream log persistence can lose delivery.
The downstream owns sync-log persistence and any startup reconciliation needed for its CardDAV guarantees.

## Part B: proseql-vcf

The optional crate is `crates/proseql-vcf`, version `0.1.0`. It exposes `VCardCodec` and `vcard_schema()`.
Its extension is `vcf`. It uses `calcard = 0.3.13`, with default JMAP conversion disabled.
Core crates do not depend on the parser, and `FormatRegistry::with_builtins()` does not register the codec.

```rust
use proseql_formats::FormatRegistry;
use proseql_vcf::{vcard_schema, VCardCodec};

let mut formats = FormatRegistry::with_builtins();
formats.register(Box::new(VCardCodec));
// Set the collection schema to vcard_schema().
// Set its ID strategy to IdStrategy::DerivedFromKey.
// Supply formats through NativeSourceRuntimeOptions.
```

A complete runnable native example is `crates/proseql-vcf/examples/native.rs`.
A JSON RecordFiles example is `crates/proseql-native/examples/record_files.rs`.

### Canonical record shape

Every name/address component below is a string. Optional properties are omitted, not `null`. Arrays are always present.

```text
{
  raw: String,
  version: "3.0" | "4.0",
  uid?: String,
  fn?: String,
  n?: { family, given, additional, prefix, suffix },
  nickname: [String],
  emails: [{ value: String, types: [String], pref?: u8 }],
  tels: [{ value: String, types: [String], pref?: u8 }],
  adrs: [{ types: [String], label?: String, poBox, extended, street,
           locality, region, postcode, country, geo?: String }],
  related: [{ value: String, types: [String] }],
  categories: [String],
  rev?: String,
  email_values: [String],
  localities: [String]
}
```

`raw` is the exact original text, including CRLF, folding, unknown properties, grouped properties and `X-` fields.
`encode` validates that `raw` contains exactly one supported card, then returns it verbatim. It never uses the parser's serializer.
Missing/non-string raw, invalid cards, unsupported versions and multiple cards fail as codec errors. Source errors add the file path.

`round_trips_exactly()` returns `true`. The registry compares the canonical projection with the value being written.
Changing only `fn` or another derived field fails before any file changes. Keep the registry write check enabled.
Use `vcard_schema()`: it removes automatic engine timestamps that are not card fields and would otherwise fail the exact check.

Types are lowercase. `pref` retains vCard 4 preferences from 1 through 100; legacy `TYPE=PREF` also sets preference 1.
Addresses retain all requested parts. Label/GEO parameters take priority, followed by same-group properties.
An ungrouped GEO or label is attached only when there is one ungrouped address, to avoid assigning ambiguous coordinates.
GEO remains a string, including legacy coordinate strings and vCard 4 `geo:` URIs. No geocoding is performed.
`rev` is normalized from the parser timestamp. Raw revision bytes remain unchanged inside `raw`.

`email_values` and `localities` are additional scalar arrays for existing membership queries:

```json
{ "email_values": { "$contains": "example@example.invalid" } }
```

```json
{ "localities": { "$contains": "Sampletown" } }
```

### Create and replace complete cards

Decode the new text to get a consistent projection, then add the filename ID:

```rust
use proseql_formats::FormatCodec;
use proseql_vcf::VCardCodec;
use serde_json::json;

let mut record = VCardCodec.decode(raw).expect("valid card");
record["id"] = json!(chosen_href);
// runtime.mutate(|db| db.create("contacts", record))?;
```

Passing only `{ raw }` is insufficient for an exact registry write check.
Ordinary updates merge fields. To replace a card while removing optional properties, delete then create the same ID inside one `runtime.mutate`.
The net RecordFiles plan makes one durable replacement, not an unlink followed by a create. This behavior has a native integration test.

## Verification and remaining limits

Final full verification ran on AKA at exact implementation SHA `69465bc23bdcfc5c53752f75c2e4b2171a898ea4`.
The later landing did not change that SHA. Initial development checks ran on ZAO before the host requirement was clarified.
A repository pre-push hook also ran typecheck and 493 tests on ZAO during landing; all passed, but they are not the final verification evidence.
Subsequent Git housekeeping disables hooks per command to avoid local test execution.

| Check | Final AKA result |
|---|---|
| `nix run .#test` | 4,098 passed, two existing browser-performance skips, zero failures. |
| `nix run .#typecheck` | Passed. |
| `nix run .#lint` | Passed. |
| `nix run .#rust-test` | Passed. Cargo harness summaries total 1,426 passes, 16 ignored entries, zero failures. |
| `nix run .#rust-lint` | Passed. |
| `nix run .#rust-format-check` | Passed. |
| Explicit ignored release-scale test | Passed. |

Subprocess-only helpers are exercised by their parent tests. The ignored scale test was run explicitly.
Real temporary files, SHA-256/mtime comparisons, fault injection and killed subprocesses cover persistence and crash boundaries.
Both reproduced review defects are fixed: compound-extension ID drift and missing-relative-root memory-host hangs.

The final AKA scale run used 2,000 synthetic PHOTO cards, 400,350,670 bytes total, maximum 200,177 bytes per file.
Open took **2,420.415 ms**. Full reload after one external edit took **2,150.282 ms**.
Environment: NixOS/Linux x86_64, AMD Ryzen 5 7600X, 12 logical CPUs, Cargo release profile, warm generated files.
The source guide retains an earlier AKA run at 2,226.581 ms open and 2,476.386 ms reload.
Neither run measures cold-cache behavior or peak memory, and neither establishes a latency guarantee.

| Limit or deviation | Reason / downstream action |
|---|---|
| No real Google export tested. | Fixtures are labeled synthetic Google-style 3.0 and 4.0 cards. Verify sanitized real exports before claiming compatibility. |
| Native-only implementation. | The existing TypeScript `directory` API remains unchanged. Its physical layout matches, but no durability/schema/selective-write/reload-detail parity is claimed. |
| RecordFiles rejects named generators, version metadata and migrations. | Filename identity and raw single-record files do not implement those additional persistence contracts. |
| One card per file; eager loading. | Multi-card support was optional. Lazy loading was not required. |
| Compound extensions rejected. | Preserve unambiguous filename-stem identity. |
| Conservative document/graph ancestor overlap rejection. | Avoid multiple source owners for writable paths. Disjoint sibling roots remain valid. |
| Complete replacements can need delete/create in one mutation. | Existing update semantics merge optional fields rather than replacing the whole record. |
| Custom durable hosts need explicit removal support. | The safe default refuses unsupported durable deletion before batch writes. |
| No multi-file atomicity, cross-process lock or exactly-once notification guarantee. | Existing prefix-commit crash rule and accepted-snapshot callback model remain in effect. |

Standards review left one optional duplication note about filename-stem extraction. No current behavior defect requires that refactor.
There is no applicable running-library deployment target. No registry publication or downstream service deployment was performed.

## Evidence and source pointers

- Guide: `docs/native-sources.md`, sections "One file per record" and "Optional vCard codec".
- Codec details: `crates/proseql-vcf/README.md`.
- Integration tests: `crates/proseql-native/tests/record_files_runtime.rs`, `record_files_durability.rs`, and `crates/proseql-vcf/tests/`.
- Full final AKA logs: `/tmp/proseql-vcard-verification-04f165a9-aka-review/`, also copied to ZAO at the same path.
- Independent final contract reproduction log on AKA: `/tmp/proseql-vcard-contract-review-r2-04f165a9.log`.
- Temporary verification logs are evidence for this run, not permanent repository artifacts. Re-run the checked-in tests to produce fresh evidence.
