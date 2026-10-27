mod support;
use proseql_engine::query::pipeline::query_input;
use proseql_formats::FormatCodec;
use proseql_native::{NativeRuntime, NativeSourceSessions};
use proseql_storage::fs::FsStorageHost;
use proseql_vcf::VCardCodec;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, sync::Arc, time::Duration};
use support::{FOUR, GOOGLE};
fn hashes(root: &std::path::Path) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
    let mut entries = fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().into_owned(),
                Sha256::digest(fs::read(entry.path()).unwrap()).to_vec(),
                entry.metadata().unwrap().modified().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}
#[test]
fn native_queries_and_selective_raw_writes_leave_siblings_and_flush_hashes_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("google.vcf"), GOOGLE).unwrap();
    fs::write(dir.path().join("four.vcf"), FOUR).unwrap();
    let before = hashes(dir.path());
    let runtime = support::open(dir.path());
    let by_email = runtime
        .query(
            "contacts",
            query_input(
                Some(json!({"email_values":{"$contains":"example@example.invalid"}})),
                vec![],
                None,
                None,
                None,
            ),
            None,
        )
        .unwrap();
    assert_eq!(by_email.len(), 1);
    assert_eq!(by_email[0]["id"], "google");
    let by_locality = runtime
        .query(
            "contacts",
            query_input(
                Some(json!({"localities":{"$contains":"Othercity"}})),
                vec![],
                None,
                None,
                None,
            ),
            None,
        )
        .unwrap();
    assert_eq!(by_locality.len(), 1);
    assert_eq!(by_locality[0]["id"], "four");
    runtime.flush().unwrap();
    assert_eq!(hashes(dir.path()), before);
    let mut created = VCardCodec
        .decode(&FOUR.replace("Second Example", "Third Example"))
        .unwrap();
    created["id"] = json!("new-href");
    runtime.mutate(|db| db.create("contacts", created)).unwrap();
    assert_eq!(hashes(dir.path()).len(), 3);
    assert_eq!(
        hashes(dir.path())
            .into_iter()
            .filter(|entry| entry.0 != "new-href.vcf")
            .collect::<Vec<_>>(),
        before
    );
    let after_create = hashes(dir.path());
    runtime
        .mutate(|db| {
            db.update(
                "contacts",
                "google",
                VCardCodec
                    .decode(&GOOGLE.replace("Example Person", "Changed Person"))
                    .unwrap(),
            )
        })
        .unwrap();
    let after_update = hashes(dir.path());
    for index in [0, 2] {
        assert_eq!(after_update[index], after_create[index]);
    }
    assert_ne!(after_update[1].1, after_create[1].1);
    assert_eq!(
        fs::read_to_string(dir.path().join("google.vcf")).unwrap(),
        GOOGLE.replace("Example Person", "Changed Person")
    );
    runtime
        .mutate(|db| db.delete("contacts", "new-href"))
        .unwrap();
    runtime.close().unwrap();
    assert_eq!(hashes(dir.path()).len(), 2);
    assert!(!dir.path().join("new-href.vcf").exists());
    let before = hashes(dir.path());
    let runtime = support::open(dir.path());
    runtime.flush().unwrap();
    runtime.close().unwrap();
    assert_eq!(hashes(dir.path()), before);
}
#[test]
fn derived_only_and_multi_record_write_check_failure_refuse_without_touching_bytes() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.vcf"), GOOGLE).unwrap();
    fs::write(dir.path().join("b.vcf"), FOUR).unwrap();
    let runtime = support::open(dir.path());
    let before = hashes(dir.path());
    let error = runtime
        .mutate(|db| db.update("contacts", "a", json!({"fn":"derived only"})))
        .unwrap_err();
    assert!(error.to_string().contains("round-trip-mismatch"));
    assert_eq!(hashes(dir.path()), before);
    assert!(runtime
        .mutate(|db| {
            db.delete("contacts", "a")?;
            db.update("contacts", "b", json!({"raw":"not a vcard"}))
        })
        .is_err());
    assert_eq!(hashes(dir.path()), before);
    assert_eq!(
        runtime.find_by_id("contacts", "a").unwrap().unwrap()["fn"],
        "Example Person"
    );
}
#[test]
fn invalid_file_path_is_reported_and_external_reload_preserves_the_last_raw() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.vcf"), GOOGLE).unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let mut options = support::options();
    options.watch_debounce = Some(Duration::from_millis(10));
    options.on_record_files_reload = Some(Arc::new(move |diff| send.send(diff).unwrap()));
    let runtime = NativeRuntime::open_sources_with_host(
        support::config(dir.path()),
        Arc::new(FsStorageHost::new_polling(Duration::from_millis(10)).unwrap()),
        options,
    )
    .unwrap();
    fs::write(
        dir.path().join("a.vcf"),
        "BEGIN:VCARD\nVERSION:4.0\nFN:Unclosed\n",
    )
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while runtime.last_reload_error().unwrap().is_none() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(runtime
        .last_reload_error()
        .unwrap()
        .unwrap()
        .to_string()
        .contains("a.vcf"));
    assert_eq!(
        runtime.find_by_id("contacts", "a").unwrap().unwrap()["raw"],
        GOOGLE
    );
    assert!(receive.try_recv().is_err());
    fs::write(
        dir.path().join("a.vcf"),
        GOOGLE.replace("Example Person", "External Person"),
    )
    .unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .changed,
        vec!["a"]
    );
    runtime.close().unwrap();
}
#[test]
fn source_sessions_keep_custom_codec_registration_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.vcf"), GOOGLE).unwrap();
    let sessions =
        NativeSourceSessions::new(support::config(dir.path()), support::options()).unwrap();
    sessions
        .with_session(|runtime| {
            assert_eq!(runtime.find_by_id("contacts", "a")?.unwrap()["raw"], GOOGLE);
            Ok(())
        })
        .unwrap();
    fs::write(dir.path().join("a.vcf"), FOUR).unwrap();
    sessions
        .with_session(|runtime| {
            assert_eq!(
                runtime.find_by_id("contacts", "a")?.unwrap()["version"],
                "4.0"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn full_card_replacement_can_remove_optional_fields_in_one_durable_replace() {
    use proseql_storage::fs::{DurabilityFaultInjector, DurabilityFaultPoint};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Counts {
        replaces: AtomicUsize,
        unlinks: AtomicUsize,
    }
    impl DurabilityFaultInjector for Counts {
        fn check(
            &self,
            point: DurabilityFaultPoint,
        ) -> Result<(), proseql_engine::errors::EngineError> {
            match point {
                DurabilityFaultPoint::AtomicReplace => {
                    self.replaces.fetch_add(1, Ordering::SeqCst);
                }
                DurabilityFaultPoint::RemoveUnlink => {
                    self.unlinks.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            };
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.vcf"), GOOGLE).unwrap();
    let counts = Arc::new(Counts {
        replaces: AtomicUsize::new(0),
        unlinks: AtomicUsize::new(0),
    });
    let runtime = NativeRuntime::open_sources_with_host(
        support::config(dir.path()),
        Arc::new(
            FsStorageHost::new_polling_with_fault_injector(Duration::from_secs(2), counts.clone())
                .unwrap(),
        ),
        support::options(),
    )
    .unwrap();
    let raw = "BEGIN:VCARD\nVERSION:4.0\nFN:Replacement without UID or N\nEND:VCARD\n";
    let mut replacement = VCardCodec.decode(raw).unwrap();
    replacement["id"] = json!("a");
    runtime
        .mutate(|db| {
            db.delete("contacts", "a")?;
            db.create("contacts", replacement)
        })
        .unwrap();
    assert_eq!(counts.replaces.load(Ordering::SeqCst), 1);
    assert_eq!(counts.unlinks.load(Ordering::SeqCst), 0);
    assert!(runtime
        .find_by_id("contacts", "a")
        .unwrap()
        .unwrap()
        .get("uid")
        .is_none());
    assert_eq!(fs::read_to_string(dir.path().join("a.vcf")).unwrap(), raw);
    let before = hashes(dir.path());
    runtime
        .mutate(|db| db.update("contacts", "a", VCardCodec.decode(raw).unwrap()))
        .unwrap();
    runtime.flush().unwrap();
    runtime.close().unwrap();
    assert_eq!(hashes(dir.path()), before);
    assert_eq!(counts.replaces.load(Ordering::SeqCst), 1);
}
