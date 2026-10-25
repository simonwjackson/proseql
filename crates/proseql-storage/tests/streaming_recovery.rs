#![cfg(not(target_arch = "wasm32"))]

use proseql_storage::fs::FsStorageHost;
use proseql_storage::host::StorageHost;
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

struct RecoveryAllocator;
static TRACKING: AtomicBool = AtomicBool::new(false);
static REQUESTED: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

fn record(size: usize) {
    if TRACKING.load(Ordering::Relaxed) {
        REQUESTED.fetch_add(size, Ordering::Relaxed);
        LARGEST.fetch_max(size, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for RecoveryAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        unsafe { System.realloc(ptr, layout, size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: RecoveryAllocator = RecoveryAllocator;

// This integration binary has one test. Count every requested heap byte during
// recovery, not only the largest allocation or the allocations left afterward.
fn measured<T>(operation: impl FnOnce() -> T) -> (T, usize, usize) {
    REQUESTED.store(0, Ordering::Relaxed);
    LARGEST.store(0, Ordering::Relaxed);
    TRACKING.store(true, Ordering::Relaxed);
    let result = operation();
    TRACKING.store(false, Ordering::Relaxed);
    (
        result,
        REQUESTED.load(Ordering::Relaxed),
        LARGEST.load(Ordering::Relaxed),
    )
}

#[test]
fn stat_and_range_recover_100_mib_files_with_bounded_allocations_and_unchanged_outcomes() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("synthetic.txt");
    let destination = dir.path().join("state.txt");
    let backup = dir.path().join(".state.txt.proseql-backup");
    let marker = dir.path().join(".state.txt.proseql-committed");
    const FILE_BYTES: u64 = 100 * 1024 * 1024;
    let mut block = [b'a'; 64 * 1024];
    block[block.len() - 1] = b'\n';
    let mut file = std::fs::File::create(&original).unwrap();
    for _ in 0..1600 {
        file.write_all(&block).unwrap();
    }
    drop(file);
    let host = FsStorageHost::new_polling(Duration::from_secs(1)).unwrap();
    let path = destination.to_str().unwrap();
    let mut maximum_requested = 0;
    let mut maximum_allocation = 0;
    // No marker covers leftover-backup recovery; P covers pending recovery.
    // A large malformed marker must also remain bounded and mean PENDING.
    for marker_kind in ["absent", "pending", "large-malformed"] {
        for identical in [true, false] {
            for use_stat in [true, false] {
                std::fs::copy(&original, &destination).unwrap();
                std::fs::copy(&original, &backup).unwrap();
                if !identical {
                    let mut candidate = std::fs::OpenOptions::new()
                        .write(true)
                        .open(&destination)
                        .unwrap();
                    candidate.seek(SeekFrom::End(-2)).unwrap();
                    candidate.write_all(b"b").unwrap();
                }
                match marker_kind {
                    "pending" => std::fs::write(&marker, b"P").unwrap(),
                    "large-malformed" => {
                        std::fs::copy(&original, &marker).unwrap();
                    }
                    _ => {}
                }
                #[cfg(unix)]
                let expected_inode = {
                    use std::os::unix::fs::MetadataExt;
                    std::fs::metadata(if identical { &destination } else { &backup })
                        .unwrap()
                        .ino()
                };
                let (result, requested, largest) = measured(|| {
                    if use_stat {
                        host.stat(path)
                            .map(|stat| assert_eq!(stat.unwrap().len, FILE_BYTES))
                    } else {
                        host.read_range(path, FILE_BYTES - 2, 2)
                            .map(|tail| assert_eq!(tail, b"a\n"))
                    }
                });
                result.unwrap();
                maximum_requested = maximum_requested.max(requested);
                maximum_allocation = maximum_allocation.max(largest);
                assert!(requested < 1024 * 1024, "marker={marker_kind} identical={identical} stat={use_stat}: requested={requested}, largest={largest}");
                assert!(!backup.exists());
                assert!(!marker.exists());
                // Identical bytes must keep the destination inode; different
                // bytes must restore the backup inode, as before this change.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    assert_eq!(
                        std::fs::metadata(&destination).unwrap().ino(),
                        expected_inode
                    );
                }
                assert_eq!(host.read_range(path, FILE_BYTES - 2, 2).unwrap(), b"a\n");
                assert_eq!(std::fs::metadata(&destination).unwrap().len(), FILE_BYTES);
            }
        }
    }
    eprintln!("recovery_file_bytes={FILE_BYTES} cases=12 max_requested_heap_bytes={maximum_requested} largest_heap_allocation_bytes={maximum_allocation}");
}
