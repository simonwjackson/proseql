#![recursion_limit = "1024"]
//! proseQL engine — platform-blind core crate.
//!
//! This crate contains the foundational data models, error taxonomy, and
//! validation logic for the proseQL engine.  It has no dependency on any
//! platform I/O: no filesystem, no network, no JS runtime.  Storage and
//! transport are provided by separate host crates.
//!
//! # Module layout (U1 scaffold)
//!
//! - [`value`] — boundary value type ([`Value`], re-exported from `serde_json`)
//! - [`errors`] — full error taxonomy mirroring the TS `Data.TaggedError` classes
//! - [`descriptor`] — config descriptor model (collections, schemas, sources)
//! - [`validator`] — schema validation: `validate_value(schema, value)`
//!
//! # Design principle
//!
//! **TS types are the contract; Rust implements the semantics.**
//! The TypeScript type layer in `packages/core/src/types/` is the compile-time
//! contract for all consumers.  This crate's observable behaviour must match that
//! contract as verified by the conformance test corpus (U9 parity gate).
//! Any divergence is a bug in the Rust implementation, not a type-system
//! redefinition.

pub mod descriptor;
pub mod errors;
pub mod validator;
pub mod value;
