#![recursion_limit = "1024"]
//! proseQL engine — platform-blind core crate.
//!
//! This crate contains the foundational data models, error taxonomy, validation
//! logic, callback seam, and in-memory CRUD engine for proseQL.  It has **no**
//! dependency on any platform I/O: no filesystem, no network, no JS runtime.
//! Storage and transport are provided by separate host crates.
//!
//! # Module layout
//!
//! ## U1 — Scaffold
//! - [`value`] — boundary value type ([`serde_json::Value`] re-export)
//! - [`errors`] — full error taxonomy mirroring the TS `Data.TaggedError` classes
//! - [`descriptor`] — config descriptor model (collections, schemas, sources)
//! - [`validator`] — schema validation: `validate_value(schema, value)`
//!
//! ## U2 — CRUD semantics
//! - [`callbacks`] — sync `CallbackRegistry` for `OptionalWithDefault` defaults
//! - [`id_gen`] — `IdGenerator` trait + `NanoIdGenerator` + `SequentialGenerator`
//! - [`operators`] — update operator application (`deep_merge_updates`)
//! - [`timestamp`] — ISO 8601 UTC timestamp generation (no external deps)
//! - [`collection`] — in-memory `Collection` with full CRUD + unique constraints
//!
//! # Design principle
//!
//! **TS types are the contract; Rust implements the semantics.**
//! The TypeScript type layer in `packages/core/src/types/` is the compile-time
//! contract for all consumers.  This crate's observable behaviour must match that
//! contract as verified by the conformance test corpus (U9 parity gate).
//! Any divergence is a bug in the Rust implementation, not a type-system
//! redefinition.

// U1
pub mod descriptor;
pub mod errors;
pub mod validator;
pub mod value;

// U2
pub mod callbacks;
pub mod clock;
pub mod collection;
pub mod id_gen;
pub mod operators;
pub mod timestamp;
