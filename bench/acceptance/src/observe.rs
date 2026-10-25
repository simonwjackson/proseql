use crate::Error;
use std::alloc::{GlobalAlloc, Layout, System};
use std::fs;
use std::sync::Mutex;

pub struct Meter(Mutex<(usize, usize)>);
impl Meter {
    pub const fn new() -> Self {
        Self(Mutex::new((0, 0)))
    }
    fn change(&self, old: usize, new: usize) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.0 = state.0 - old + new;
        state.1 = state.1.max(state.0);
    }
    pub fn reset(&self) {
        let mut s = self.0.lock().unwrap();
        s.1 = s.0;
    }
    pub fn sample(&self) -> (usize, usize) {
        *self.0.lock().unwrap()
    }
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            self.change(0, l.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(l);
        if !p.is_null() {
            self.change(0, l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        self.change(l.size(), 0);
        System.dealloc(p, l);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = System.realloc(p, l, n);
        if !q.is_null() {
            self.change(l.size(), n);
        }
        q
    }
}

pub fn status(field: &str) -> Result<u64, Error> {
    let status = fs::read_to_string("/proc/self/status")?;
    let line = status
        .lines()
        .find(|s| s.starts_with(field))
        .ok_or("missing proc field")?;
    Ok(line
        .split_whitespace()
        .nth(1)
        .ok_or("missing proc value")?
        .parse::<u64>()?
        * 1024)
}
pub fn reset_rss_peak() -> Result<(), Error> {
    Ok(fs::write("/proc/self/clear_refs", "5")?)
}

/// Linux perf user-instruction counter, enabled only around the operation.
/// Version-0 perf_event_attr is 64 bytes. No architecture-specific instructions.
#[repr(C)]
struct PerfAttr {
    event_type: u32,
    size: u32,
    config: u64,
    sample_period: u64,
    sample_type: u64,
    read_format: u64,
    flags: u64,
    wakeup: u32,
    bp_type: u32,
    config1: u64,
}
pub struct Instructions(libc::c_int);
impl Instructions {
    pub fn new() -> Result<Self, Error> {
        let attr = PerfAttr {
            event_type: 0,
            size: 64,
            config: 1,
            sample_period: 0,
            sample_type: 0,
            read_format: 0,
            flags: 1 | 2 | 32 | 64,
            wakeup: 0,
            bp_type: 0,
            config1: 0,
        };
        let fd = unsafe { libc::syscall(libc::SYS_perf_event_open, &attr, 0, -1, -1, 0) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(fd as libc::c_int))
    }
    pub fn start(&self) -> Result<(), Error> {
        for request in [0x2403, 0x2400] {
            if unsafe { libc::ioctl(self.0, request) } < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        Ok(())
    }
    pub fn stop(&self) -> Result<u64, Error> {
        if unsafe { libc::ioctl(self.0, 0x2401) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut count = 0u64;
        if unsafe { libc::read(self.0, (&mut count as *mut u64).cast(), 8) } != 8 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(count)
    }
}
impl Drop for Instructions {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.0);
        }
    }
}
