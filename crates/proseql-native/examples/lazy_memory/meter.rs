//! Benchmark-only live requested-byte counter. The fixed state and mutex do not
//! allocate. The wrapped System allocator still owns allocations. DHAT runs separately:
//! wrapping it would also count its intentionally untracked profiler metadata.
//! Serialized accounting makes nested phase start/end and allocation peaks one
//! consistent timeline, including allocations made by background threads.
use std::alloc::{GlobalAlloc, Layout};
use std::sync::Mutex;

const PHASES: [&str; 16] = [
    "open",
    "query_total",
    "partition_read_decode_validate",
    "filesystem_read_text_including_recovery",
    "filesystem_read_bytes_including_recovery",
    "decode_id_validation_including_drop",
    "decoded_id_validation",
    "decode_storage",
    "schema_decode_map_construction_including_input_drop",
    "resident_validation_record_and_index_build",
    "resident_validation_replacement_and_index_build",
    "resident_validation_transient_block",
    "query_engine_including_explain_when_requested",
    "eviction",
    "query_partition_filter_accumulate",
    "query_global_finalize",
];

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Sample {
    pub start_live: usize,
    pub end_live: usize,
    pub peak_live: usize,
    /// Sum of successful alloc/alloc_zeroed request sizes and full realloc
    /// destination sizes, not DHAT's differently defined cumulative total.
    pub allocated: usize,
}
#[derive(Clone, Copy)]
struct Counts {
    live: usize,
    peak: usize,
    mask: u64,
    phases: [Sample; PHASES.len()],
}
impl Counts {
    const fn new() -> Self {
        Self {
            live: 0,
            peak: 0,
            mask: 0,
            phases: [Sample {
                start_live: 0,
                end_live: 0,
                peak_live: 0,
                allocated: 0,
            }; PHASES.len()],
        }
    }
    fn change(&mut self, old: usize, new: usize) {
        self.live = self.live - old + new;
        self.peak = self.peak.max(self.live);
        for (index, phase) in self.phases.iter_mut().enumerate() {
            if self.mask & (1 << index) != 0 {
                phase.peak_live = phase.peak_live.max(self.live);
                phase.allocated += new;
            }
        }
    }
}

pub struct Meter<A> {
    inner: A,
    counts: Mutex<Counts>,
}
impl<A> Meter<A> {
    pub const fn new(inner: A) -> Self {
        Self {
            inner,
            counts: Mutex::new(Counts::new()),
        }
    }
    fn update(&self, old: usize, new: usize) {
        self.counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .change(old, new);
    }
    pub fn live_and_peak(&self) -> (usize, usize) {
        let counts = self
            .counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        (counts.live, counts.peak)
    }
    /// Pause phase attribution while the observer creates its JSON/log output.
    /// Global live bytes still track every allocation. Diagnostic allocations
    /// therefore cannot create invented local phase peaks in parent spans.
    pub fn pause(&self) -> u64 {
        let mut counts = self
            .counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let active = counts.mask;
        counts.mask = 0;
        active
    }
    pub fn end(&self, name: &str, active: &mut u64) -> Option<Sample> {
        let index = PHASES.iter().position(|phase| *phase == name)?;
        if *active & (1 << index) == 0 {
            return None;
        }
        *active &= !(1 << index);
        let mut counts = self
            .counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        counts.phases[index].end_live = counts.live;
        Some(counts.phases[index])
    }
    pub fn resume(&self, name: &str, begin: bool, mut active: u64) {
        let index = if begin {
            PHASES.iter().position(|phase| *phase == name)
        } else {
            None
        };
        if let Some(index) = index {
            assert_eq!(
                active & (1 << index),
                0,
                "same-name recursive phase is unsupported"
            );
        }
        let mut counts = self
            .counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(index) = index {
            counts.phases[index] = Sample {
                start_live: counts.live,
                end_live: counts.live,
                peak_live: counts.live,
                allocated: 0,
            };
            active |= 1 << index;
        }
        counts.mask = active;
    }
}

// No allocation, log, clock, or user code runs while the accounting lock is
// held. The inner allocator is always called outside it, including DHAT.
unsafe impl<A: GlobalAlloc> GlobalAlloc for Meter<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = self.inner.alloc(layout);
        if !pointer.is_null() {
            self.update(0, layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = self.inner.alloc_zeroed(layout);
        if !pointer.is_null() {
            self.update(0, layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        self.update(layout.size(), 0);
        self.inner.dealloc(pointer, layout);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let next = self.inner.realloc(pointer, layout, size);
        if !next.is_null() {
            self.update(layout.size(), size);
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::alloc::System;
    #[test]
    fn nested_peaks_observe_alloc_realloc_free_not_endpoint_guesses() {
        // A private meter over the real System allocator isolates this proof
        // from the Rust test runner and the example's global allocator.
        let meter = Meter::new(System);
        meter.resume("query_total", true, 0);
        unsafe {
            let layout = Layout::from_size_align(128, 8).unwrap();
            let p = meter.alloc(layout);
            assert!(!p.is_null());
            let active = meter.pause();
            meter.resume("decode_storage", true, active);
            let p = meter.realloc(p, layout, 512);
            assert!(!p.is_null());
            let other = meter.alloc_zeroed(layout);
            assert!(!other.is_null());
            meter.dealloc(other, layout);
            meter.dealloc(p, Layout::from_size_align(512, 8).unwrap());
            let mut active = meter.pause();
            let child = meter.end("decode_storage", &mut active).unwrap();
            assert_eq!(
                child,
                Sample {
                    start_live: 128,
                    end_live: 0,
                    peak_live: 640,
                    allocated: 640
                }
            );
            meter.resume("decode_storage", false, active);
            let mut active = meter.pause();
            let parent = meter.end("query_total", &mut active).unwrap();
            assert_eq!(
                parent,
                Sample {
                    start_live: 0,
                    end_live: 0,
                    peak_live: 640,
                    allocated: 768
                }
            );
            meter.resume("query_total", false, active);
        }
        assert_eq!(meter.live_and_peak(), (0, 640));
    }
}
