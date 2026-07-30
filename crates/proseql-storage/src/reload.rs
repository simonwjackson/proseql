use std::sync::{Arc, Mutex, RwLock};

use proseql_engine::errors::EngineError;

#[derive(Clone)]
pub struct LastKnownGood<T> {
    inner: Arc<RwLock<T>>,
}

impl<T: Clone> LastKnownGood<T> {
    pub fn new(value: T) -> Self {
        Self {
            inner: Arc::new(RwLock::new(value)),
        }
    }

    pub fn current(&self) -> T {
        self.inner.read().expect("last known good poisoned").clone()
    }

    pub fn reload<F>(&self, loader: F) -> Result<(), EngineError>
    where
        F: FnOnce() -> Result<T, EngineError>,
    {
        let next = loader()?;
        *self.inner.write().expect("last known good poisoned") = next;
        Ok(())
    }
}

#[derive(Clone)]
pub struct ReloadCoordinator<T> {
    last_known_good: LastKnownGood<T>,
    last_error: Arc<Mutex<Option<EngineError>>>,
}

impl<T: Clone> ReloadCoordinator<T> {
    pub fn new(last_known_good: LastKnownGood<T>) -> Self {
        Self {
            last_known_good,
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn reload<F>(&self, loader: F) -> Result<(), EngineError>
    where
        F: FnOnce() -> Result<T, EngineError>,
    {
        match self.last_known_good.reload(loader) {
            Ok(()) => {
                *self.last_error.lock().expect("reload coordinator poisoned") = None;
                Ok(())
            }
            Err(error) => {
                *self.last_error.lock().expect("reload coordinator poisoned") = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn last_error(&self) -> Option<EngineError> {
        self.last_error
            .lock()
            .expect("reload coordinator poisoned")
            .clone()
    }
}
