//! Shared helpers for the query-while-scanning tests. Owner: the parent
//! (contract), then `integrator`. Builders add their own test files
//! (`tests/streaming_<seam>.rs`) that `mod support;` and use these helpers;
//! ask the parent to change this module.
#![allow(dead_code)]

pub mod parity;
