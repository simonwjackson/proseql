//! Writes and watches for streaming lazy collections.
//!
//! `append.rs` belongs to `append` (#16a). `watch.rs` and `tx.rs` belong to
//! `mutate` (#16b). Contract:
//! `openspec/changes/query-while-scanning/contract.md`.
//!
//! Lazy collections are `append_only` (update, delete and upsert are refused
//! with reason `append-only`), have no `unique_fields`, no relationships and
//! no global hooks. So the write path is creates only.

pub(crate) mod append;
pub(crate) mod tx;
pub(crate) mod watch;
