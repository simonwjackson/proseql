use crate::Error;
use std::alloc::{GlobalAlloc, Layout, System};
use std::fs;
use std::sync::Mutex;

pub struct Meter(Mutex<(usize, usize)>);
impl Meter {
    pub const fn new() -> Self {Self(Mutex::new((0,0)))}
    fn change(&self, old: usize, new: usize) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.0 = state.0 - old + new;
        state.1 = state.1.max(state.0);
    }
    pub fn reset(&self) {let mut s = self.0.lock().unwrap(); s.1 = s.0;}
    pub fn sample(&self) -> (usize, usize) {*self.0.lock().unwrap()}
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {let p = System.alloc(l); if !p.is_null() {self.change(0,l.size());} p}
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {let p = System.alloc_zeroed(l); if !p.is_null() {self.change(0,l.size());} p}
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {self.change(l.size(),0);System.dealloc(p,l);}
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {let q = System.realloc(p,l,n);if !q.is_null() {self.change(l.size(),n);}q}
}

pub fn status(field: &str) -> Result<u64, Error> {
    let status = fs::read_to_string("/proc/self/status")?;
    let line = status.lines().find(|s| s.starts_with(field)).ok_or("missing proc field")?;
    Ok(line.split_whitespace().nth(1).ok_or("missing proc value")?.parse::<u64>()? * 1024)
}
pub fn reset_rss_peak() -> Result<(), Error> {Ok(fs::write("/proc/self/clear_refs", "5")?)}
