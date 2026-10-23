//! Opt-in benchmark checkpoints. No observer or clock exists in default builds.
//! Observers must not call back into the database. Phases can nest; checkpoints
//! are boundaries, not exclusive attribution of allocations or elapsed time.

#[cfg(feature = "bench-observe")]
use std::sync::OnceLock;

#[cfg(feature = "bench-observe")]
static OBSERVER: OnceLock<fn(&'static str, bool)> = OnceLock::new();

/// Install the process-wide observer once, before opening a runtime.
#[cfg(feature = "bench-observe")]
pub fn set_observer(observer: fn(&'static str, bool)) -> bool {
    OBSERVER.set(observer).is_ok()
}

pub struct Span {
    #[cfg(feature = "bench-observe")]
    phase: &'static str,
}

#[inline]
pub fn span(_phase: &'static str) -> Span {
    #[cfg(feature = "bench-observe")]
    if let Some(observer) = OBSERVER.get() {
        observer(_phase, true);
    }
    Span {
        #[cfg(feature = "bench-observe")]
        phase: _phase,
    }
}

impl Drop for Span {
    #[inline]
    fn drop(&mut self) {
        #[cfg(feature = "bench-observe")]
        if let Some(observer) = OBSERVER.get() {
            observer(self.phase, false);
        }
    }
}

#[cfg(all(test, feature = "bench-observe"))]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static EVENTS: Mutex<Vec<(&str, bool)>> = Mutex::new(Vec::new());

    #[test]
    fn nested_spans_close_on_error() {
        assert!(set_observer(|phase, begin| {
            EVENTS.lock().unwrap().push((phase, begin));
        }));
        let fail = || -> Result<(), ()> {
            let _outer = span("outer");
            let _inner = span("inner");
            Err(())?;
            Ok(())
        };
        assert!(fail().is_err());
        assert_eq!(
            *EVENTS.lock().unwrap(),
            [
                ("outer", true),
                ("inner", true),
                ("inner", false),
                ("outer", false)
            ]
        );
    }
}
