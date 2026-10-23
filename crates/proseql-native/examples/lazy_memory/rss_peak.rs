//! Benchmark-only Linux process RSS peaks. Never use this process's reset HWM
//! or GNU time maximum as an unmodified whole-process acceptance measurement.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::Mutex;
use std::thread::ThreadId;

const MAX_DEPTH: usize = 32;
const STATUS_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub rss: u64,
    pub hwm: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub start_rss: u64,
    pub end_rss: u64,
    pub peak_rss: u64,
    pub segments: u64,
}
#[derive(Clone, Copy)]
struct Active {
    phase: &'static str,
    start_rss: u64,
    peak_rss: u64,
    segments: u64,
}
pub struct Boundary {
    pub before: Snapshot,
    pub after_reset: Snapshot,
    pub local: Option<Sample>,
    pub depth_before: usize,
    pub depth_after: usize,
}
struct State {
    status: File,
    clear_refs: File,
    buffer: [u8; STATUS_BYTES],
    stack: [Option<Active>; MAX_DEPTH],
    depth: usize,
    owner: ThreadId,
}
pub struct Tracker(Mutex<State>);

impl State {
    fn snapshot(&mut self) -> io::Result<Snapshot> {
        self.status.seek(SeekFrom::Start(0))?;
        let mut used = 0;
        loop {
            if used == self.buffer.len() {
                return Err(io::Error::other(
                    "/proc/self/status exceeds fixed observer buffer",
                ));
            }
            let read = self.status.read(&mut self.buffer[used..])?;
            if read == 0 {
                break;
            }
            used += read;
        }
        let text = std::str::from_utf8(&self.buffer[..used]).map_err(io::Error::other)?;
        let value = |key: &str| -> io::Result<u64> {
            let line = text
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .ok_or_else(|| io::Error::other("missing kernel RSS field"))?;
            let mut parts = line.split_ascii_whitespace();
            let kib = parts
                .next()
                .ok_or_else(|| io::Error::other("missing RSS number"))?
                .parse::<u64>()
                .map_err(io::Error::other)?;
            if parts.next() != Some("kB") {
                return Err(io::Error::other("unexpected RSS unit"));
            }
            kib.checked_mul(1024)
                .ok_or_else(|| io::Error::other("RSS overflow"))
        };
        Ok(Snapshot {
            rss: value("VmRSS:")?,
            hwm: value("VmHWM:")?,
        })
    }
    fn propagate(&mut self, observed: Snapshot) {
        let peak = observed.rss.max(observed.hwm);
        for span in self.stack[..self.depth].iter_mut().flatten() {
            span.peak_rss = span.peak_rss.max(peak);
            span.segments += 1;
        }
    }
    fn reset_self(&mut self) -> io::Result<()> {
        self.clear_refs.seek(SeekFrom::Start(0))?;
        self.clear_refs.write_all(b"5\n")
    }
}
impl Tracker {
    pub fn new() -> io::Result<Self> {
        Ok(Self(Mutex::new(State {
            status: File::open("/proc/self/status")?,
            clear_refs: OpenOptions::new()
                .write(true)
                .open("/proc/self/clear_refs")?,
            buffer: [0; STATUS_BYTES],
            stack: [None; MAX_DEPTH],
            depth: 0,
            owner: std::thread::current().id(),
        })))
    }
    pub fn boundary(&self, phase: &'static str, begin: bool) -> io::Result<Boundary> {
        if !phase
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        {
            return Err(io::Error::other(
                "RSS observer requires static ASCII phase names",
            ));
        }
        let mut state = self
            .0
            .lock()
            .map_err(|_| io::Error::other("RSS observer poisoned"))?;
        if state.owner != std::thread::current().id() {
            return Err(io::Error::other(
                "RSS benchmark spans must be nested on one thread",
            ));
        }
        let depth_before = state.depth;
        // Capture the old segment BEFORE clearing it, including a transient
        // which was freed before this boundary. Every active parent inherits it.
        let before = state.snapshot()?;
        state.propagate(before);
        let local = if !begin && state.depth > 0 {
            let index = state.depth - 1;
            let span = state.stack[index].take().expect("active stack entry");
            if span.phase != phase {
                return Err(io::Error::other("non-nested RSS phase exit"));
            }
            state.depth = index;
            Some(Sample {
                start_rss: span.start_rss,
                end_rss: before.rss,
                peak_rss: span.peak_rss,
                segments: span.segments,
            })
        } else {
            None
        };
        // A depth-zero end is a benchmark checkpoint, not a fabricated span.
        state.reset_self()?;
        let after_reset = state.snapshot()?;
        state.propagate(after_reset);
        if begin {
            let index = state.depth;
            if index == MAX_DEPTH {
                return Err(io::Error::other("RSS observer stack exhausted"));
            }
            state.stack[index] = Some(Active {
                phase,
                start_rss: after_reset.rss,
                peak_rss: after_reset.rss.max(after_reset.hwm),
                segments: 1,
            });
            state.depth += 1;
        }
        Ok(Boundary {
            before,
            after_reset,
            local,
            depth_before,
            depth_after: state.depth,
        })
    }
}

/// Direct formatting avoids allocating a serde Value tree at every boundary.
/// Observer I/O/code-page/stack overhead is still part of observed process RSS.
pub fn emit(phase: &str, begin: bool, elapsed_us: u128, boundary: Boundary) {
    let Boundary {
        before,
        after_reset,
        local,
        depth_before,
        depth_after,
    } = boundary;
    if let Some(sample) = local {
        eprintln!(
            concat!(
                "LM_PHASE {{\"phase\":\"{}\",\"begin\":{},\"elapsed_us\":{},",
                "\"heap\":null,\"local_heap\":null,\"rss\":{},\"rss_hwm\":null,",
                "\"phase_local_rss\":{{\"start_rss\":{},\"end_rss\":{},\"peak_rss\":{},",
                "\"peak_over_start\":{},\"peak_over_endpoints\":{},\"segments\":{}}},",
                "\"kernel_segment_hwm_before_reset\":{},\"kernel_segment_hwm_after_reset\":{},",
                "\"rss_after_reset\":{},\"depth_before\":{},\"depth_after\":{}}}"
            ),
            phase,
            begin,
            elapsed_us,
            before.rss,
            sample.start_rss,
            sample.end_rss,
            sample.peak_rss,
            sample.peak_rss.saturating_sub(sample.start_rss),
            sample
                .peak_rss
                .saturating_sub(sample.start_rss.max(sample.end_rss)),
            sample.segments,
            before.hwm,
            after_reset.hwm,
            after_reset.rss,
            depth_before,
            depth_after
        );
    } else {
        eprintln!(
            concat!(
                "LM_PHASE {{\"phase\":\"{}\",\"begin\":{},\"elapsed_us\":{},",
                "\"heap\":null,\"local_heap\":null,\"rss\":{},\"rss_hwm\":null,",
                "\"phase_local_rss\":null,\"kernel_segment_hwm_before_reset\":{},",
                "\"kernel_segment_hwm_after_reset\":{},\"rss_after_reset\":{},",
                "\"depth_before\":{},\"depth_after\":{}}}"
            ),
            phase,
            begin,
            elapsed_us,
            before.rss,
            before.hwm,
            after_reset.hwm,
            after_reset.rss,
            depth_before,
            depth_after
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MIB: u64 = 1024 * 1024;
    fn transient(mib: usize) {
        let mut bytes = vec![0_u8; mib * 1024 * 1024];
        for offset in (0..bytes.len()).step_by(4096) {
            // Real resident pages; neither lazy calloc nor dead-code elimination.
            unsafe {
                bytes.as_mut_ptr().add(offset).write_volatile(0xa5);
            }
        }
        std::hint::black_box(&bytes);
        drop(bytes);
    }
    #[test]
    fn earlier_parent_peak_does_not_leak_into_child_after_reset() {
        let tracker = Tracker::new().unwrap();
        tracker.boundary("parent", true).unwrap();
        transient(128);
        let entered = tracker.boundary("child", true).unwrap();
        transient(64);
        let child = tracker.boundary("child", false).unwrap().local.unwrap();
        let parent = tracker.boundary("parent", false).unwrap().local.unwrap();
        assert!(
            parent.peak_rss >= parent.start_rss + 120 * MIB,
            "parent {parent:?}"
        );
        assert!(
            child.peak_rss >= child.start_rss + 56 * MIB,
            "child {child:?}"
        );
        assert!(
            child.peak_rss + 32 * MIB < parent.peak_rss,
            "reset must exclude old parent peak: {parent:?} {child:?}"
        );
        assert!(
            child.peak_rss > child.start_rss.max(child.end_rss) + 50 * MIB,
            "must observe freed transient, not endpoints: {child:?}"
        );
        assert!(entered.after_reset.hwm + 100 * MIB < entered.before.hwm);
        eprintln!(
            "RSS_REGRESSION parent={parent:?} child={child:?} reset={:?}",
            entered.after_reset
        );
    }
    #[test]
    fn grandchild_peak_propagates_to_every_active_parent_before_reset() {
        let tracker = Tracker::new().unwrap();
        tracker.boundary("parent", true).unwrap();
        tracker.boundary("child", true).unwrap();
        tracker.boundary("grandchild", true).unwrap();
        transient(96);
        let grandchild = tracker
            .boundary("grandchild", false)
            .unwrap()
            .local
            .unwrap();
        let child = tracker.boundary("child", false).unwrap().local.unwrap();
        let parent = tracker.boundary("parent", false).unwrap().local.unwrap();
        for sample in [grandchild, child, parent] {
            assert!(
                sample.peak_rss >= sample.start_rss + 88 * MIB,
                "all parents must inherit: {sample:?}"
            );
            assert!(
                sample.peak_rss > sample.start_rss.max(sample.end_rss) + 80 * MIB,
                "not an endpoint estimate: {sample:?}"
            );
        }
        assert!(parent.segments > child.segments && child.segments > grandchild.segments);
        eprintln!("RSS_REGRESSION grandchild={grandchild:?} child={child:?} parent={parent:?}");
    }
}
