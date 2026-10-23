//! Optional allocator diagnostics, never used by the runtime library. Linux
//! GNU mallinfo2 reports actual allocator-held free space, not an RSS guess.
use serde_json::Value;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[repr(C)]
struct Mallinfo2 {
    arena: usize,
    ordblks: usize,
    smblks: usize,
    hblks: usize,
    hblkhd: usize,
    usmblks: usize,
    fsmblks: usize,
    uordblks: usize,
    fordblks: usize,
    keepcost: usize,
}
#[cfg(all(target_os = "linux", target_env = "gnu"))]
extern "C" {
    fn mallinfo2() -> Mallinfo2;
    fn malloc_trim(pad: usize) -> std::ffi::c_int;
}

pub fn stats() -> Value {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // glibc's fixed-size ABI: ten size_t fields, with no owned pointers.
        let info = unsafe { mallinfo2() };
        serde_json::json!({"arena_bytes":info.arena,"in_use_arena_bytes":info.uordblks,
            "free_arena_bytes":info.fordblks,"mmapped_bytes":info.hblkhd,"releasable_top_bytes":info.keepcost,
            "free_chunks":info.ordblks,"fastbin_chunks":info.smblks,"mmapped_regions":info.hblks,
            "fastbin_bytes":info.fsmblks,"obsolete_highwater_bytes":info.usmblks})
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    Value::Null
}

/// An explicit diagnostic intervention AFTER the timed workload. It does not
/// reduce the recorded peak and is never enabled in primary acceptance runs.
pub fn trim() -> Option<bool> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // glibc releases only unused allocator pages; no live Rust object moves.
        Some(unsafe { malloc_trim(0) } != 0)
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    None
}
