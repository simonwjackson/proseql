//! Isolated binary so allocator measurements do not include parallel tests.
mod support;

use proseql_engine::query::AggregateConfig;
use serde_json::json;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    io::Write,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use support::parity::RuntimeKind;
use support::parity::{ParityFixture, COLLECTION};

struct Meter;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
fn allocated(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(live, Ordering::Relaxed);
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            allocated(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            allocated(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let new = unsafe { System.realloc(pointer, old, size) };
        if !new.is_null() {
            LIVE.fetch_sub(old.size(), Ordering::Relaxed);
            allocated(size);
        }
        new
    }
}
#[global_allocator]
static ALLOCATOR: Meter = Meter;

#[test]
fn ten_month_grouped_scan_returns_query_allocations() {
    let fixture = ParityFixture::new(720);
    let mut count = 0_u64;
    for (month, days) in [
        ("2025-01", 31),
        ("2025-02", 28),
        ("2025-03", 31),
        ("2025-04", 30),
        ("2025-05", 31),
        ("2025-06", 30),
        ("2025-07", 31),
        ("2025-08", 31),
        ("2025-09", 30),
        ("2025-10", 31),
    ] {
        let mut file =
            std::io::BufWriter::new(std::fs::File::create(fixture.partition_path(month)).unwrap());
        for day in 1..=days {
            for minute in 0..1440 {
                for metric in ["steps", "heartRate"] {
                    if metric == "heartRate" && minute % 2 != 0 {
                        continue;
                    }
                    writeln!(
                        file,
                        "{}",
                        support::parity::sample(month, day, minute, metric)
                    )
                    .unwrap();
                    count += 1;
                }
            }
        }
        file.flush().unwrap();
    }
    assert_eq!(count, 656_640);
    let runtime = fixture.open(RuntimeKind::Lazy);
    let config = AggregateConfig {
        count: true,
        sum: vec!["value".into()],
        avg: vec!["value".into()],
        ..Default::default()
    };
    let group = ["dateUtc".to_owned(), "metric".to_owned()];
    let filter = Some(json!({"metric":{"$in":["heartRate","steps"]}}));
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let start = Instant::now();
    let result = runtime
        .aggregate_grouped_bounded(COLLECTION, filter, &group, &config)
        .unwrap();
    let elapsed = start.elapsed();
    assert_eq!(
        result.iter().map(|group| group.count.unwrap()).sum::<u64>(),
        count
    );
    assert_eq!(result.len(), 608);
    drop(result);
    std::thread::sleep(Duration::from_secs(1));
    let retained = LIVE.load(Ordering::Relaxed).saturating_sub(before);
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(before);
    eprintln!("streaming-exec: rows={count} groups=608 peak_working_bytes={peak} retained_bytes_after_1s={retained} wall_ms={}", elapsed.as_millis());
    assert!(retained < 1024 * 1024, "retained {retained} bytes");
    assert!(runtime
        .lazy_partition_status(COLLECTION)
        .unwrap()
        .unwrap()
        .loaded
        .is_empty());
}
