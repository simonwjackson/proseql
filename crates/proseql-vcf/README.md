# proseql-vcf

Optional raw-preserving vCard codec for native proseQL. Uses `calcard = 0.3.13`
with its default JMAP conversion feature disabled. Core crates do not depend on
this crate. The built-in format registry does not register it.

```rust
use proseql_formats::FormatRegistry;
use proseql_vcf::{VCardCodec, vcard_schema};

let mut formats = FormatRegistry::with_builtins();
formats.register(Box::new(VCardCodec));
// collection.descriptor.schema = vcard_schema();
// collection.descriptor.id_strategy = IdStrategy::DerivedFromKey;
// options.formats = formats;
```

Use `DatabaseSourceConfig::RecordFiles(RecordFilesSourceConfig { id, collection,
root, format: "vcf".into() })`. The `.vcf` filename stem is the record ID, **not**
the vCard UID. The UID can contain `urn:uuid:`; the filename ID cannot contain `:`.
See [native sources](../../docs/native-sources.md#one-file-per-record-native-recordfiles)
for ID validation, durable removal, conflicts, managed watching and crash limits.

Run the complete compiling example, which creates only synthetic temporary files:

```sh
nix develop --command cargo run --manifest-path crates/Cargo.toml -p proseql-vcf --example native
```

## Raw truth and canonical projection

`VCardCodec` implements `FormatCodec`, with extension `vcf` and
`round_trips_exactly() == true`. It accepts exactly one complete vCard with one
`VERSION:3.0` or `VERSION:4.0`. Multiple cards, incomplete cards, unsupported or
missing versions, and parser errors are codec errors. Source errors name the file.

`decode` retains the exact input string in `raw`, including CRLF, folding, unknown
properties, grouped properties and `X-` fields. `encode` validates `raw`, returns
it verbatim and ignores all other fields. It never calls the parser serializer.
The registry write check compares the complete canonical projection with the
value being written. Changing only `fn`, or any other derived field, fails before
any file is touched. Keep that check enabled.

Use `vcard_schema()` with `IdStrategy::DerivedFromKey`. This schema describes the
projection without `id`. It strips automatic engine timestamps, which are not
part of a card. An open `Unknown` schema retains those timestamps after mutations
and therefore cannot pass the exact write check. The source hydrates the stem ID
in memory and strips it before the codec check and write.

| Field | Canonical value |
|---|---|
| `raw` | Exact input text; required. |
| `version` | `"3.0"` or `"4.0"`; required. |
| `uid`, `fn` | First corresponding property string; omitted if absent. |
| `n` | Optional object with `family`, `given`, `additional`, `prefix`, `suffix`, each a string. Missing components are `""`; multiple components join with `,`. |
| `nickname`, `categories` | String arrays; escaped commas remain inside their value. |
| `emails`, `tels` | Arrays of `{ value: String, types: [String], pref?: u8 }`. Types are lowercase, in parser order. `PREF` 1–100 is retained; legacy `TYPE=PREF` also sets `pref: 1` and remains in `types`. |
| `adrs` | Array of `{ types, label?, poBox, extended, street, locality, region, postcode, country, geo? }`. Every address part is a string; missing parts are `""`. |
| `related` | Array of `{ value, types }` from `RELATED` and `X-ABRELATEDNAMES`. |
| `rev` | Optional parser timestamp, normalized to ISO date/time with its offset when available. |
| `email_values`, `localities` | Scalar string arrays for existing `$contains` queries. No new engine array-object operator is added. Empty localities are omitted. |

All arrays are present, even when empty. Missing optional properties are omitted,
not `null`. Unknown fields are not added to the projection. The raw text still
contains them. Names, email addresses and address parts retain their parsed case.

`ADR` parameters supply `label` and `geo` first. Otherwise the codec uses a
same-group `LABEL`/`X-ABLabel` or `GEO` property. Ungrouped properties are attached
only when there is exactly one ungrouped address, to avoid assigning ambiguous
coordinates. vCard 4 GEO URIs and legacy vCard 3 coordinate strings stay strings;
this crate does not geocode or reinterpret coordinates. RFC 6868 caret escapes
in parameters are decoded for query fields. Raw bytes remain unchanged.

## Native writes and queries

Decode the new raw text before creating a record. Add only the filename ID:

```rust
use proseql_formats::FormatCodec;
use proseql_vcf::VCardCodec;
use serde_json::json;
let mut record = VCardCodec.decode(raw).expect("valid card");
record["id"] = json!("chosen-href");
// runtime.mutate(|db| db.create("contacts", record))?;
```

Do not pass `{ raw }` alone to the registry: its exact check also needs all derived
fields. For an arbitrary full-card replacement that can remove optional fields,
delete then create the same ID inside **one** `runtime.mutate` transaction. The
RecordFiles net-change plan makes one replacement, not an unlink followed by a
create. Ordinary `update` merges fields; it is suitable when the same optional
fields remain present, but it must also receive the newly decoded projection.
A derived-only update is intentionally refused.

Query any email or any address locality with existing scalar-array filters:

```text
{ "email_values": { "$contains": "example@example.invalid" } }
{ "localities": { "$contains": "Sampletown" } }
```

`NativeSourceRuntimeOptions.on_record_files_reload` receives accepted
`RecordFilesReload { source_id, collection, added, changed, removed }` after
commit and outside runtime locks. It can read or mutate the runtime. Invalid
external bytes retain the last accepted state and emit no diff. Native sessions
retain codec/callback services, not loaded rows.

This is native-only API. The existing TypeScript `directory` API remains; this
crate does not add TypeScript durability, schema, selective-write or callback parity.

## Fixtures and measurement

The checked-in Google-style 3.0 and 4.0 fixtures are explicitly synthetic. They
contain `PHOTO`, groups and `X-` fields, but are **not** real Google exports. No
personal contacts were used, and no real export was sourced for this change.
Tests cover SHA-256/mtime silence, selective writes, queries and exact write checks.

Run the ignored, synthetic 2,000-card PHOTO measurement separately:

```sh
nix develop --command cargo test --manifest-path crates/Cargo.toml -p proseql-vcf --release --test scale -- --ignored --nocapture
```

The test prints file count, byte size, open/full-reload wall time, profile and
platform. It measures warm generated files, not cold-cache or peak-memory cost.
No acceptance latency threshold is claimed. See `docs/native-sources.md` for the
recorded run and environment.
