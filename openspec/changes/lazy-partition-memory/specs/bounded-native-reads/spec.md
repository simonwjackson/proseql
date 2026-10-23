## ADDED Requirements

### Requirement: Compatible opt-in bounded reads

`NativeRuntime` SHALL expose `query_bounded`, `query_bounded_with_stats`, `query_cursor_bounded`, `aggregate_bounded` and `aggregate_grouped_bounded`. No field SHALL be added to existing native configuration struct literals. Existing full-scope reads, mutation reads and watches SHALL retain their documented contracts, including full-scope and pin overages.

#### Scenario: Multi-partition read
- **WHEN** a bounded read visits more than N lazy partitions with a retained limit of N
- **THEN** it SHALL visit partitions in global path/file order and keep at most N unpinned cached partitions plus one incoming partition's records alive
- **AND** matching query rows, identity-check metadata and pinned/watch memory SHALL be additional, explicit costs
- **AND** an allocator test SHALL observe real record-payload allocations and frees during ascending, repeated and multi-month scopes at N=1 and N>1, not only inspect cache metadata afterward

#### Scenario: Global query operators
- **WHEN** a bounded query spans multiple partitions
- **THEN** the engine SHALL filter candidates once and apply stable global sort, search relevance, selection, offset/limit or cursor pagination once to all matches
- **AND** it SHALL not return monthly pages concatenated as a global page

#### Scenario: Ordered aggregation
- **WHEN** an aggregate visits multiple partitions
- **THEN** each row SHALL enter the accumulator in the existing engine candidate order (natural order except indexed multi-value unions/search ordering), preserving every f64 addition and first-encounter group/tie order, including comparable arrays/objects
- **AND** it SHALL not merge monthly SUM or AVG values
- **AND** top-level search and multi-value equality-index union aggregation SHALL retain and globally order matching rows before accumulation, preserving the existing native query-then-aggregate order

#### Scenario: Errors and identity
- **WHEN** an incoming file has invalid syntax, invalid IDs, schema/callback errors, duplicate IDs across visited partitions, or wrong-bucket records
- **THEN** the read SHALL fail with its typed error, even if no row would match
- **AND** the failed incoming candidate SHALL not replace the last accepted cached partition
- **AND** failed reloads SHALL preserve last-known-good records

#### Scenario: Pinned watches
- **WHEN** watches pin partitions during a bounded read
- **THEN** the runtime SHALL not evict them or hide their residency; bounded query statistics SHALL report pins and the retained limit separately
- **AND** committed watch snapshots SHALL not retain unrelated unpinned records after trimming
- **AND** pinned records, watch snapshots/evaluation/delivered results SHALL be outside the unpinned cache bound

### Requirement: Shared engine semantics

The bounded read SHALL compose shared engine query finalization and row accumulators, not a second native query engine. Shared synthetic fixtures SHALL test native engine, WASM boundary and TypeScript/WASM behavior. Records SHALL remain canonical inspectable `serde_json::Value` objects.
