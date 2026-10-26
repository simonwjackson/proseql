use proseql_engine::errors::{EngineError, OperationError};
use proseql_storage::{
    generation::SourceGeneration, host::StorageHost, index::IdLocator, memory::MemoryStorageHost,
};
use std::collections::BTreeMap;

#[test]
fn stale_shared_observation_never_blesses_cached_membership() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"old\"}\n").unwrap();
    let stale = BTreeMap::from([("a".into(), SourceGeneration::observe(&host, "a").unwrap())]);
    host.write("a", "{\"id\":\"new\"}\n").unwrap();
    let mut locator = IdLocator::build(&host, &["a".into()]).unwrap();
    let mut visited = 0;
    let result =
        locator.refresh_observed_decoded(&host, &["a".into()], &stale, &mut |_, _, _, _| {
            visited += 1;
            Ok(None)
        });
    assert!(
        result.is_err(),
        "fresh post-scan check rejects stale observation"
    );
    assert_eq!(visited, 1);
    assert!(
        locator.locate("new").is_err(),
        "failed refresh leaves no usable coverage"
    );
}

#[test]
fn decoded_visitor_matches_self_parsed_locations() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}\n{\"id\":\"b\"}\n").unwrap();
    let paths = ["a".into()];
    let parsed = IdLocator::build(&host, &paths).unwrap();
    let decoded = IdLocator::build_observed_decoded(
        &host,
        &paths,
        &BTreeMap::new(),
        &mut |_, bytes, _, _| {
            let row: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            Ok(Some(row["id"].as_str().unwrap().into()))
        },
    )
    .unwrap();
    for id in ["a", "b", "missing"] {
        assert_eq!(parsed.locate(id).unwrap(), decoded.locate(id).unwrap());
    }
    assert_eq!(parsed.generation_for("a"), decoded.generation_for("a"));
}

#[test]
fn decoded_visitor_error_aborts_build() {
    let host = MemoryStorageHost::default();
    host.write("a", "{\"id\":\"a\"}\n").unwrap();
    let error = IdLocator::build_observed_decoded(
        &host,
        &["a".into()],
        &BTreeMap::new(),
        &mut |_, _, _, _| {
            Err(EngineError::Operation(OperationError {
                operation: "test".into(),
                reason: "visitor".into(),
                message: "stop".into(),
            }))
        },
    )
    .unwrap_err();
    assert!(matches!(error, EngineError::Operation(error) if error.reason == "visitor"));
}
