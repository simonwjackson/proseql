# Partitioned collection sources

The user selected partitioned proseQL storage and confirmed tests at the Rust runtime, TypeScript runtime, and meetings HTTP ingest interfaces.

## Contract

Add a writable `partitioned` source for one collection. Configure its root, format, and partition key. A partition key is either a string field or the prefix of a string field before a nonempty delimiter. The meetings consumer uses the prefix of `id` before `.`. Keep that policy declarative and product-neutral.

Each file is `<root>/<key>.<format>`. Reject empty keys, unsafe filename characters, and misrouted records. Use flat files only. Load all files as one collection. Reject duplicate records across files. Missing roots load empty. Retain empty partition files after deletion.

Prose sources require their own template options. Preserve strict parsing and typed values. Group a candidate collection by key before any writes. Rewrite only partitions with net changes. Updates to a partition field move records between files. Detect edits to affected files before writing. Reuse native per-file recovery, durable replacement, sorted writes, and quarantine. Do not claim cross-file atomicity.

TypeScript uses its existing debounced persistence and flush contract. It does not gain Rust durability guarantees. Keep unrelated sources and codecs unchanged.

## Verification slices

1. Create two meeting partitions through the public Rust runtime, reopen, and query both.
2. Check unchanged-file preservation, update/delete, routing validation, malformed reload, conflicts, overlaps, and write failure recovery.
3. Exercise the equivalent TypeScript runtime with real filesystem storage, query, flush, reopen, and reload.
4. Change meetings ingest to use partitions. Test HTTP ingest and migration on temporary copies, including exact record preservation and duplicate retries.
5. Run library and consumer checks. Land local commits without publishing. Update flake inputs and build the deployment.
6. Obtain explicit approval before live migration. Stop ingest, retain a rollback copy, compare all records, deploy, and verify the running service and one-file-per-meeting layout.

## Verification completed

The Rust workspace tests and Clippy passed. The TypeScript build and 3,486 core, Node, CLI, and partition-engine tests passed. A fresh WASM build passed, followed by all 131 engine tests. The meetings consumer passed five HTTP tests and five migration tests.

Migration on a private copy of the existing archive preserved all 53 meetings, 14,128 turns, and eight people. It compared every record before and after reopening. The metadata files stayed byte-for-byte unchanged. The legacy turn file stayed intact as the backup. The live archive remains unchanged. Live migration and deployment need separate approval.

## Scope limits

Do not implement classification, a batch journal, raw VTT backups, nested partitions, arbitrary routing callbacks, or remote publishing. Source-mode watchers still load an aggregate in-memory database. Partitioning reduces write size, not aggregate memory or polling cost.
