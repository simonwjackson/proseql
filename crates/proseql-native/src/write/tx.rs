//! Commit-time conflict checks for streaming lazy collections.
use crate::{ExecutionModel, RuntimeState};
use proseql_engine::errors::EngineError;
use proseql_storage::generation::{GenerationCheck, SourceGeneration};

/// Check every target before the first durable write. A failed check is not
/// a write-stage failure: mutate rolls back without quarantining the runtime.
pub(crate) fn check_before_commit(state: &RuntimeState) -> Result<(), EngineError> {
    let Some(sources) = state.sources.as_ref() else {
        return Ok(());
    };
    for lazy in sources.lazy.values() {
        if lazy.execution_model != ExecutionModel::Streaming {
            continue;
        }
        for (path, generation) in target_generations(&lazy.stream.append) {
            let unchanged = match generation {
                Some(generation) => {
                    generation.check(state.host.as_ref())? == GenerationCheck::Unchanged
                }
                None => state.host.stat(path)?.is_none(),
            };
            if !unchanged {
                return Err(crate::operation_error(
                    "source-changed",
                    format!("File '{path}' changed since load; reload before retrying"),
                ));
            }
        }
    }
    Ok(())
}

fn target_generations(
    append: &crate::write::append::AppendState,
) -> &[(String, Option<SourceGeneration>)] {
    append.target_generations()
}
