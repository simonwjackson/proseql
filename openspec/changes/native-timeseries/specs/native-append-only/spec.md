## ADDED Requirements

### Requirement: Native append without rewrite

In native source mode, a collection with `append_only: true` on a JSONL or NDJSON `CollectionFile` or `Partitioned` source SHALL persist each create as complete `\n`-terminated lines appended to the target file with the same encoder as a full rewrite. It SHALL NOT encode the existing file again. Other formats SHALL keep the rewrite path.

#### Scenario: Append one record to a partition
- **WHEN** a record is created in an append-only partitioned JSONL collection
- **THEN** the bytes written equal the encoded line plus its newline, the earlier file bytes are unchanged, and a later full rewrite produces the same bytes

#### Scenario: Durable order
- **WHEN** an append succeeds
- **THEN** the line was written and the file was synchronized (and its directory, when the file is new) before the runtime published the engine state

#### Scenario: Append write failure
- **WHEN** the append write or its synchronization fails
- **THEN** the caller receives `StorageError`, the engine transaction rolls back, the runtime quarantines under the existing crash rule, and memory is not ahead of disk

#### Scenario: Update, delete and upsert are refused
- **WHEN** a caller updates, deletes or upserts a record in an append-only collection
- **THEN** the engine returns the existing typed refusal and writes nothing

#### Scenario: Own appends do not reload
- **WHEN** the managed watcher observes the runtime's own append
- **THEN** the runtime does not reload the source and the stored state stays equal to the file

### Requirement: Torn final line handling

On open, an append-only JSONL file SHALL tolerate only an interrupted final append.

#### Scenario: Unparseable unterminated final line
- **WHEN** the final line has no trailing newline and does not parse
- **THEN** the loader ignores it, reports a diagnostic, and the next append first truncates the file to the last complete line

#### Scenario: Parseable unterminated final line
- **WHEN** the final line has no trailing newline and parses
- **THEN** it is a valid record and the next append writes the missing newline first

#### Scenario: Other malformed lines
- **WHEN** any other line is malformed
- **THEN** open fails with the strict codec error

### Requirement: Duplicate ID policy

`CollectionDescriptor.duplicate_ids` SHALL accept `"error"` (default) and `"ignore_identical"`. The engine SHALL apply it to `create` and `createMany` for native and WASM. The default SHALL be omitted from serialized descriptors.

#### Scenario: Identical re-append
- **WHEN** `duplicate_ids` is `"ignore_identical"` and a create repeats an existing ID with the same payload after decode and defaults (JS number semantics, ignoring engine-filled `createdAt`/`updatedAt`)
- **THEN** the call succeeds, writes nothing, and returns the stored record

#### Scenario: Conflicting re-append
- **WHEN** a create repeats an existing ID with a different payload
- **THEN** the engine returns `DuplicateKeyError` with the existing tag and payload

#### Scenario: Conflict in a batch
- **WHEN** one record in a `createMany` batch conflicts
- **THEN** no record of the batch is written

#### Scenario: Legacy core
- **WHEN** the legacy TypeScript core receives a `duplicateIds` setting
- **THEN** it rejects the configuration
