//! Additive byte-chunk boundary, independent of resident database persistence.
//! Browser lazy partitions remain native-only; this exposes the shared row
//! source for a future browser streaming executor without a whole-file read.

use js_sys::{BigInt, Function, Uint8Array};
use proseql_engine::scan::framer::ChunkLines;
use proseql_engine::scan::RowSource;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct JsonlChunkScanner {
    lines: ChunkLines,
}

#[wasm_bindgen]
impl JsonlChunkScanner {
    #[wasm_bindgen(constructor)]
    pub fn new(partition: u32, start_offset: u64, first_ordinal: u64) -> Self {
        Self {
            lines: ChunkLines::new(partition, start_offset, first_ordinal),
        }
    }

    /// The callback receives owned bytes, partition, absolute offset, ordinal
    /// and final_unterminated. It runs synchronously; no rows are retained here.
    pub fn push(
        &mut self,
        bytes: &[u8],
        final_chunk: bool,
        on_row: &Function,
    ) -> Result<u32, JsValue> {
        self.lines
            .push(bytes, final_chunk)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let mut count = 0;
        while let Some(row) = self
            .lines
            .next_row()
            .map_err(|error| JsValue::from_str(&error.to_string()))?
        {
            let args = js_sys::Array::new();
            args.push(&Uint8Array::from(row.bytes));
            args.push(&JsValue::from(row.location.partition));
            args.push(&BigInt::from(row.location.offset));
            args.push(&BigInt::from(row.location.ordinal));
            args.push(&JsValue::from(row.final_unterminated));
            on_row.apply(&JsValue::UNDEFINED, &args)?;
            count += 1;
        }
        Ok(count)
    }

    pub fn buffered_bytes(&self) -> usize {
        self.lines.buffered_bytes()
    }

    pub fn next_ordinal(&self) -> u64 {
        self.lines.next_ordinal()
    }
}
