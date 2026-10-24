# Keep durable records on disk at idle

## Why

The previous memory work bounds a lazy query's partition working set but deliberately retains a cache. Smaller rows do not explain why historical records must remain decoded after an operation. The consumer handoff reports 240–266 MiB before queries, 461 MiB after sync, and about 1,090 MiB after a yearly summary. These are external reported observations, not measurements from this change.

This change adds a compatible native zero-retention policy. Existing positive-cache behavior stays unchanged. The idle contract covers durable data, not an in-memory database's only copy. Active caller results, active subscriptions, and uncommitted writes have separate ownership and costs.

## Scope

- Measure empty runtime, populated open, append/sync, bounded reads, dropped results, error cleanup, and idle memory immediately and after 30 seconds.
- Separate live requested bytes, allocator-owned bytes, current RSS, and peak RSS. Attribute retained rows, IDs, indexes, source text, snapshots, and metadata.
- Cover every durable source kind used by the current Logbook configuration. A zero lazy-partition counter alone is not completion.
- Keep source bytes and query, mutation, and watch behavior compatible. Add a native option rather than change existing defaults.
- Preserve original active-memory and load-performance targets as separate acceptance checks. Report failures and measured floors rather than weaken the targets.

## Evidence and fixtures

Initial local main is `0943d9be784cdeec906cf27d09ea8853f90739f8`. The tested comparison is `9a11d3665bcc881c568ee1d77d81596543c6ac07`; main changes only task documentation relative to that runtime. Runtime identity must be checked again before each qualification.

The consumer field list has **11** fields: `id`, `metric`, `at`, `end`, `value`, `source`, `receivedAt`, `rawId`, `month`, `date`, and `atUtc`. The workflow's claim that this list has 12 fields was a counting error. Keep the separate existing 12-field, 316-byte fixture unchanged. The new synthetic fixture preserves the reported string lengths and field types; report its actual bytes instead of forcing the handoff's reported 334-byte average by changing the shape.

The real consumer checkout is read only. At inspection, Logbook source `a61a45c8dc4abdc91df7cfdd694e81ccf45089df` configures samples with one lazy partition and raw records with two lazy partitions. Other sources include eager ID-only JSONL, YAML documents, and eager YAML/JSONL partitions. The current raw configuration is newer than the handoff's description and must not be treated as proof of the configuration behind its historical measurements.

Synthetic evidence belongs outside the checkout, under the session artifact directory. The exact commands, source identities, binary hashes, failures, and measurements will be linked from the design and benchmark report.

## Costs and exclusions

Zero cache reuse can require another disk read and parse on the next operation. Watch requirements, source errors, dirty data, and concurrency must not become silent exceptions. Unsupported zero-retention source/configuration combinations must fail explicitly. Do not add an index or allocator subsystem without evidence that it is needed.

No production access, consumer pin changes, pushes, publication, or service restarts are authorized. Follow-up to issue #11; no new external issue is filed by this local change. Open work is recorded here, not under `work/items/done/`.
