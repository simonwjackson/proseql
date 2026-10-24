//! Deterministic lifecycle races. Private state access makes the closing
//! boundary observable without scheduling sleeps or a public test seam.
use super::*;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::mpsc,
    thread,
    time::Instant,
};

struct PanickingWatch;
impl WatchHandle for PanickingWatch {
    fn stop(&self) -> Result<(), EngineError> {
        panic!("synthetic watch stop panic");
    }
}

#[test]
fn close_unwind_releases_state_and_completes_lifecycle() {
    let runtime = NativeRuntime::open_with_host(
        NativeRuntimeConfig {
            path: "/synthetic-unwind.json".into(),
            collections: vec![],
        },
        Arc::new(MemoryStorageHost::default()),
    )
    .unwrap();
    runtime
        .inner
        .state
        .lock()
        .unwrap()
        .watch
        .push(Box::new(PanickingWatch));
    assert!(catch_unwind(AssertUnwindSafe(|| runtime.close())).is_err());
    let state = runtime
        .inner
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let released = state.resources_released;
    drop(state);
    assert!(released, "unwind left runtime state retained");
    assert_eq!(runtime.inner.lifecycle.load(Ordering::Acquire), CLOSED);
    // This must not wait forever for the unwound first closer.
    runtime.close().unwrap();
}

#[test]
fn concurrent_close_waits_for_cleanup_before_returning() {
    let runtime = NativeRuntime::open_with_host(
        NativeRuntimeConfig {
            path: "/synthetic-empty.json".into(),
            collections: vec![],
        },
        Arc::new(MemoryStorageHost::default()),
    )
    .unwrap();
    // Hold active work so the first closer has marked CLOSING but cannot yet
    // flush or clear state. A second close must not let a session lease go.
    let active = runtime.inner.state.lock().unwrap();
    let first = {
        let runtime = runtime.clone();
        thread::spawn(move || runtime.close())
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while runtime.inner.lifecycle.load(Ordering::Acquire) == OPEN {
        assert!(Instant::now() < deadline, "first closer did not start");
        thread::yield_now();
    }
    let (done, completed) = mpsc::channel();
    let second = {
        let runtime = runtime.clone();
        thread::spawn(move || done.send(runtime.close()).unwrap())
    };
    let premature = completed.recv_timeout(Duration::from_millis(50));
    drop(active);
    first.join().unwrap().unwrap();
    second.join().unwrap();
    if premature.is_err() {
        completed
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
    }
    assert!(
        premature.is_err(),
        "a concurrent close returned before cleanup"
    );
    assert!(runtime.inner.state.lock().unwrap().resources_released);
}
