# Consumer compatibility on aka

Verified against the consumers' current committed sources, without editing either original repository. Builds and tests used `RUSTFLAGS='-C target-cpu=x86-64-v2'`, the ProseQL Nix dev shell, disabled remote builders, nice 10, separate Cargo targets, and filesystem-backed synthetic temporary data.

| Consumer | Consumer commit | Original ProseQL pin |
|---|---|---|
| Coach | `06719890e27212cf61fa77987dc4432cd68f1dd4` | `0e3666a2a39909a80ad7dd84b935c89249e9784f` |
| Logbook | `5dbb01551ecc9ff9530e9e193e60a48daedd025c` | `9a11d3665bcc881c568ee1d77d81596543c6ac07` |

| ProseQL source | Coach build | Coach tests | Logbook build | Logbook tests |
|---|---|---|---|---|
| Original pins, **no Cargo override**, committed locks | pass | 27 passed, 0 failed | pass | 219 passed, 0 failed, 2 pre-existing ignored |
| Pre-skeleton main `5d1a2aae29b90742f917d3153c72907d4bbef56e` | pass | 27 passed, 0 failed | pass | 219 passed, 0 failed, 2 pre-existing ignored |
| `qws/base` `11b3b80a398c985b3c2bf8fb915bd647e99d27f5` | pass | 27 passed, 0 failed | pass | 219 passed, 0 failed, 2 pre-existing ignored |
| Integrated `qws/integration` `267427c69c819a7612e50b596be12409019e0ba5`, default Resident | pass | 27 passed, 0 failed | pass | 219 passed, 0 failed, 2 pre-existing ignored |

**Verified:** the integrated Resident-default source matches all baseline counts. No new build or test failure occurred. Neither consumer needed an API edit. `cargo tree` resolved all four `proseql-*` crates to the integrated path overrides, not the original pins.

| Integrated Resident build | Build exit | Warnings, including ProseQL API deprecations/changes |
|---|---|---|
| Coach, `--workspace --all-targets` | 0 | 0 |
| Logbook, `--workspace --all-targets` | 0 | 0 |

This is source/test compatibility, not a real-data latency or deployment claim. The two Logbook ignores are its existing full-fixture RSS and 500k-row import measurements; this workflow did not enable them. Streaming remains opt-in; its separate experiment below is not acceptance.

## Reproduce

```sh
# zao: Git/archive/rsync only. The script runs every build and test on aka.
bash scripts/consumers/run.sh /absolute/path/to/proseql --compare-baseline
```

The complete copies include Coach's tracked `server` and synthetic `contract/fixtures`, and Logbook's tracked `Cargo.toml`, `Cargo.lock`, `crates` and test-required `scripts/stage-history`. Each variant restores the original committed consumer lock in its **copy**. The original repositories remain untouched.

Commands executed in each copied consumer workspace on aka:

```sh
# Original pins: no --config, no [patch]. --locked keeps committed resolution.
cargo build --locked --workspace --all-targets
cargo test --locked --workspace -- --test-threads=1

# main, qws/base and integrated Resident: four proseql-* Cargo config path patches.
cargo --config /.../<label>/<consumer>-patch.toml build --workspace --all-targets
cargo --config /.../<label>/<consumer>-patch.toml test --workspace -- --test-threads=1
```

Tests run through `timeout 1200`. No-override fetching uses an environment-only Git URL rewrite to `/home/simonwjackson/work/qws-harness-pinned-git`, a bare mirror holding the exact original commit objects transferred in a bundle. This changes transport, not Cargo dependencies. `cargo tree --prefix none` confirmed the exact Git pins and all four intended local override paths.

The baseline recorded logs under `scripts/consumers/results/{pinned,main,qws-base}/`. Verify ran `bash scripts/consumers/run.sh "$PWD"` at the integrated SHA above. Its logs, Cargo patch configs, resolved trees and command records are preserved on aka under `/home/simonwjackson/work/qws-logs/consumers-267427c/resident/`; ignored local logs are under `scripts/consumers/results/current/`. See cleanup below for the removed source copies and targets.

## Baseline setup failures and classification

These earlier failed setup runs were corrected and rerun; none is a final consumer failure.

| First error | Call site | Classification | Fix / verification |
|---|---|---|---|
| Coach: `couldn't read tests/../../contract/fixtures/finish/normal-open.json` | `server/tests/store.rs:122`, `include_str!` | Environment/tooling: incomplete archive, not API drift or skeleton | Include committed synthetic contract fixtures. Both builds and all 27 tests pass for all 3 sources. |
| Logbook: `assertion failed: output.status.success()` in `staging_copies_only_allowlisted_files_and_never_prints_contents` | `crates/importers/history/tests/import.rs:517`; child invokes `../../../scripts/stage-history` at line 505 | Environment/tooling: missing test script, not API drift or skeleton | Include the tracked script. The test supplies a synthetic temporary HOME. All 219 tests pass for all 3 sources. |
| Pins: `fatal: couldn't find remote ref HEAD` | Cargo's Git dependency fetch, before compilation; owned bare mirror had `main` but HEAD named unborn `master` | Environment/tooling transport setup, not a consumer test failure | Set mirror HEAD to `refs/heads/main`. Reran both pins without Cargo overrides; both build and test runs pass. |

No test failure was attributed to flakiness. No consumer source or engine source was changed to obtain these passes.

## Informational Logbook Streaming experiment

**Verified:** at the same integrated SHA and Logbook commit, the throwaway copy built with **0 warnings**, then ran **159 passed, 60 failed, 2 ignored** across **13 failing test targets**. Cargo test exited 101; it did not time out. These failures do not affect the unedited Resident result above.

Only `/home/simonwjackson/work/qws-consumers-streaming-logbook/crates/logbook-core/src/storage.rs` was patched. The experiment imported `ExecutionModel` and added `execution_model: ExecutionModel::Streaming` to `native_options_for`. It kept both lazy collections' `FullScanPolicy::Error`, all cache settings and all tests unchanged. The patch was never applied to the real repository or committed.

Commands ran on aka through `scripts/qws/aka-run consumers --x86-64-v2 --pull -- ...`, using the same integrated Cargo config path overrides:

```sh
cargo --config /.../logbook-patch.toml build --workspace --all-targets
timeout 1200 cargo --config /.../logbook-patch.toml test --workspace --no-fail-fast -- --test-threads=1
```

`--no-fail-fast` runs the remaining workspace targets after the first failing target. The first test failure was `storage::timeseries_tests::a_batch_syncs_once_per_partition_and_retries_do_not_sync` at the patched copy's `crates/logbook-core/src/storage.rs:2082`: loaded partitions were **0**, but the Resident test expected **1**. This is the documented Streaming behavior, not a deprecation or compilation failure. An initial experiment setup attempt stopped before Cargo because `python3` was absent from the dev shell. The copy was recreated and patched with Bun before the complete run above.

### Comparison with the adoption notes

The [Logbook adoption audit](../../../docs/design/query-while-scanning.md#logbook-adoption) identifies all five dependency classes exposed by these failures. Original call-site line numbers below refer to Logbook `5dbb015`; failure sites in the next table come from the patched copy. Lines after the inserted option are shifted by one.

| Cause | Failed tests | Observed symptom | Audited consumer dependency and replacement |
|---|---:|---|---|
| H — query hydration | 38 | `OperationError`, reason `missing-collection`, message `bounded month query did not retain its partition`; HTTP/RPC and importer tests propagate it | `storage.rs:443` fetches IDs, then borrows lazy samples through `read`. Consume full returned rows or `select` fields instead. The zero-limit warm-up cannot restore residency. |
| R — residency assertions | 4 | Loaded/resident partition count is 0, expected 1 | The notes specify zero Streaming residency and identify Resident-only test assertions. Other cache/LRU tests share that assumption. Keep those tests on Resident and add separate Streaming assertions. |
| D — duplicate and selector checks | 8 | Existing samples are reported as new, or retries/conversion resume fail with `DuplicateKeyError` | `storage.rs:280`, `957–970`, `1039–1085` and `migrate.rs:543–564` warm a sample month, then probe engine rows. Query candidate IDs, raw links and comparison fields instead. Do not bypass `FullScanPolicy::Error`. |
| L — latest rebuild | 1 | Converted sample resolution returns `[]` instead of three expected intervals | `storage/latest.rs:114–163` probes a month, then enumerates empty lazy engine rows. The rebuilt latest projection loses sample-metric presence. Fold returned sample rows instead. |
| S — raw heads and supersession | 9 | Missing superseded membership, stale latest pointers, extra visible revisions, or expected projection fault injection is not reached | `storage.rs:857–880` computes raw heads from engine residency after a shard query. Empty heads omit replacements. Query shard/key head fields and fold returned rows. The eager `supersededRaw` reads themselves remain valid, as the notes state. |

**Verified:** the exact failures and assertions are in the logs. **Inferred from source inspection:** D/L/S propagation maps to the call sites above; this task did not fix those sites and rerun to prove each repair. No unexpected dependency class was found. This is not exhaustive coverage of every audited call site: tests stop at their first assertion, and a passing eager-only test does not prove lazy adoption. In particular, the HTTP concurrency test fails on the hydration error, not its latency assertion. The result supports retaining Resident by default. A pin-only upgrade must not select Streaming.

### Complete Streaming failure list

Each row names one failed test, its first panic site and the cause key above. The target column is also the Cargo reproduction selector; run it with the same temporary Streaming option and Cargo patch config. All 60 tests are listed.

| Target | Test | First failure site | Cause |
|---|---|---|---|
| `-p logbook-core --lib` | `storage::timeseries_tests::a_batch_syncs_once_per_partition_and_retries_do_not_sync` | `crates/logbook-core/src/storage.rs:2082:9` | R |
| `-p logbook-core --lib` | `storage::timeseries_tests::bounded_multi_month_selection_keeps_global_page_and_one_resident_partition` | `crates/logbook-core/src/storage.rs:1773:9` | R |
| `-p logbook-core --lib` | `storage::timeseries_tests::cold_duplicate_and_conflict_checks_load_only_the_identity_partition` | `crates/logbook-core/src/storage.rs:1806:13` | R |
| `-p logbook-core --lib` | `storage::timeseries_tests::cold_open_reads_no_sensor_partition_and_lru_is_bounded` | `crates/logbook-core/src/storage.rs:1880:55` | H |
| `-p logbook-core --lib` | `storage::timeseries_tests::grouped_projection_order_is_validated_and_layout_four_upgrade_rebuilds_exact_membership` | `crates/logbook-core/src/storage.rs:2341:9` | S |
| `-p logbook-core --lib` | `storage::timeseries_tests::interrupted_raw_projection_commit_refuses_reopen_until_offline_rebuild` | `crates/logbook-core/src/storage.rs:2299:9` | S |
| `-p logbook-core --lib` | `storage::timeseries_tests::offline_audit_rejects_wrong_projection_membership_and_dirty_readiness` | `crates/logbook-core/src/storage.rs:2496:14` | S |
| `-p logbook-core --lib` | `storage::timeseries_tests::projection_encoding_refusal_restores_readiness_without_appending_raw` | `crates/logbook-core/src/storage.rs:2244:18` | S |
| `-p logbook-core --lib` | `storage::timeseries_tests::sample_overlap_crosses_a_month_and_sparse_overlap_crosses_a_year` | `crates/logbook-core/src/storage.rs:1831:18` | H |
| `-p logbook-core --lib` | `storage::timeseries_tests::supersession_fence_crashes_before_invalidation_raw_ids_and_publication_fail_closed` | `crates/logbook-core/src/storage.rs:2457:13` | S |
| `-p logbook-core --test acceptance` | `another_band_device_cannot_fill_workout_gaps_and_ties_are_lexical` | `crates/logbook-core/tests/acceptance.rs:779:51` | H |
| `-p logbook-core --test acceptance` | `band_workout_gaps_zero_oura_but_real_steps_still_count` | `crates/logbook-core/tests/acceptance.rs:746:10` | H |
| `-p logbook-core --test acceptance` | `calendar_weeks_start_monday_and_return_the_unfinished_week` | `crates/logbook-core/tests/acceptance.rs:605:14` | H |
| `-p logbook-core --test acceptance` | `corrections_replace_exclude_and_retract` | `crates/logbook-core/tests/acceptance.rs:199:14` | H |
| `-p logbook-core --test acceptance` | `duplicate_raw_sample_keys_are_rejected_before_any_write` | `crates/logbook-core/tests/acceptance.rs:915:5` | D |
| `-p logbook-core --test acceptance` | `goals_and_days_use_local_day_even_when_wire_timestamp_is_utc` | `crates/logbook-core/tests/acceptance.rs:371:14` | H |
| `-p logbook-core --test acceptance` | `monthly_samples_range_reads_cross_offset_month_boundaries` | `crates/logbook-core/tests/acceptance.rs:439:10` | H |
| `-p logbook-core --test acceptance` | `new_goal_version_does_not_change_past_periods` | `crates/logbook-core/tests/acceptance.rs:305:14` | H |
| `-p logbook-core --test acceptance` | `raw_resends_are_noops_and_revisions_supersede_without_deletion` | `crates/logbook-core/tests/acceptance.rs:162:5` | S |
| `-p logbook-core --test acceptance` | `raw_sample_series_has_stable_ids_and_revisions_replace_the_whole_series` | `crates/logbook-core/tests/acceptance.rs:830:14` | D |
| `-p logbook-core --test acceptance` | `raw_workout_revisions_hide_the_old_workout_without_deleting_it` | `crates/logbook-core/tests/acceptance.rs:946:5` | S |
| `-p logbook-core --test import_duplicates` | `a_resent_page_is_a_duplicate_without_raw_shard_reads` | `crates/logbook-core/tests/import_duplicates.rs:83:5` | D |
| `-p logbook-core --test inferred_offsets` | `mixed_offset_reimport_keeps_first_reading_in_sparse_and_minute_storage_after_reopen` | `crates/logbook-core/tests/inferred_offsets.rs:43:48` | D |
| `-p logbook-core --test latest_readings` | `superseding_latest_recomputes_only_its_newest_month_and_can_move_backwards` | `crates/logbook-core/tests/latest_readings.rs:162:5` | S |
| `-p logbook-core --test migration` | `converter_preserves_resolution_offsets_hashes_and_yaml_and_replays_partial_targets` | `crates/logbook-core/tests/migration.rs:97:5` | L |
| `-p logbook-core --test migration` | `slim_converter_can_resume_existing_complete_legacy_native_sample_rows` | `crates/logbook-core/tests/migration.rs:245:45` | D |
| `-p logbook-core --test migration` | `slim_converter_preserves_full_readings_and_hashes_rebuilt_contents` | `crates/logbook-core/tests/migration.rs:200:10` | H |
| `-p logbook-core --test summary_partitions` | `cold_year_summary_reads_thirteen_month_files_once_with_one_cache_slot` | `crates/logbook-core/tests/summary_partitions.rs:131:10` | H |
| `-p logbook-core --test summary_partitions` | `month_scoped_summary_equals_individual_resolution_with_offsets_and_corrections` | `crates/logbook-core/tests/summary_partitions.rs:53:10` | H |
| `-p logbook-core --test summary_partitions` | `streamed_resolve_matches_whole_snapshot_across_months_spans_offsets_and_oura_spreading` | `crates/logbook-core/tests/summary_partitions.rs:264:10` | H |
| `-p logbook-core --test supersession` | `one_month_default_and_configured_three_month_lru_never_read_raw` | `crates/logbook-core/tests/supersession.rs:102:5` | R |
| `-p logbook-core --test supersession` | `superseded_projection_handles_old_receipts_ties_duplicates_and_cold_reads_without_raw` | `crates/logbook-core/tests/supersession.rs:59:10` | H |
| `-p logbook-gadgetbridge --test import` | `cursors_are_per_device_and_device_identity_survives_renaming` | `crates/importers/gadgetbridge/tests/import.rs:87:14` | H |
| `-p logbook-gadgetbridge --test import` | `heart_rate_sentinels_and_nullable_scores_are_not_readings` | `crates/importers/gadgetbridge/tests/import.rs:87:14` | H |
| `-p logbook-gadgetbridge --test import` | `offsets_use_nearby_recorded_offset_or_dst_aware_home_zone` | `crates/importers/gadgetbridge/tests/import.rs:404:36` | H |
| `-p logbook-gadgetbridge --test import` | `partial_import_retries_duplicate_raw_with_persisted_offsets` | `crates/importers/gadgetbridge/tests/import.rs:87:14` | H |
| `-p logbook-gadgetbridge --test import` | `reexport_is_noop_append_imports_only_new_and_overlap_accepts_late_rows` | `crates/importers/gadgetbridge/tests/import.rs:234:5` | D |
| `-p logbook-gadgetbridge --test import` | `reimport_reuses_inferred_offset_after_new_explicit_offset_evidence` | `crates/importers/gadgetbridge/tests/import.rs:87:14` | H |
| `-p logbook-gadgetbridge --test import` | `resolver_uses_band_steps_but_not_desk_zeros` | `crates/importers/gadgetbridge/tests/import.rs:330:10` | H |
| `-p logbook-gadgetbridge --test import` | `resolver_workout_covers_still_minutes_without_stored_zero_readings` | `crates/importers/gadgetbridge/tests/import.rs:87:14` | H |
| `-p logbook-gadgetbridge --test import` | `revised_rows_use_content_hash_ids_and_can_remove_old_coverage` | `crates/importers/gadgetbridge/tests/import.rs:87:14` | H |
| `-p logbook-gadgetbridge --test import` | `revised_workout_supersedes_old_workout_and_its_coverage` | `crates/importers/gadgetbridge/tests/import.rs:563:14` | H |
| `-p logbook-gadgetbridge --test import` | `treadmill_with_heart_rate_off_imports_steps_only` | `crates/importers/gadgetbridge/tests/import.rs:87:14` | H |
| `-p logbook-gadgetbridge --test import` | `workout_cursor_is_independent_of_samples_and_other_kinds_are_kept` | `crates/importers/gadgetbridge/tests/import.rs:526:47` | H |
| `-p logbook-history --test import` | `coach_api_views_use_the_shared_mapping_without_changing_original_raw_records` | `crates/importers/history/tests/import.rs:921:18` | H |
| `-p logbook-history --test import` | `explicit_record_offsets_define_daily_midnight_and_sample_local_days` | `crates/importers/history/tests/import.rs:132:14` | H |
| `-p logbook-history --test import` | `history_then_live_oura_normalization_is_a_noop_for_identical_api_records` | `crates/importers/history/tests/import.rs:729:18` | H |
| `-p logbook-history --test import` | `inferred_offsets_do_not_change_when_imported_samples_become_nearest` | `crates/importers/history/tests/import.rs:135:42` | D |
| `-p logbook-history --test import` | `oura_metrics_series_and_workouts_keep_units_offsets_and_revision_precedence` | `crates/importers/history/tests/import.rs:132:14` | H |
| `-p logbook-history --test import` | `overlapping_sources_keep_originals_but_normalize_one_event` | `crates/importers/history/tests/import.rs:74:59` | H |
| `-p logbook-oura --test import` | `all_categories_pagination_retry_revisions_and_idempotence` | `crates/importers/oura/tests/import.rs:230:48` | H |
| `-p logbook-oura --test import` | `daily_offset_survives_changed_evidence_and_the_next_import_is_a_noop` | `crates/importers/oura/tests/import.rs:622:5` | D |
| `-p logbook-oura --test import` | `extra_vendor_fields_import_and_stay_untouched_in_raw_records` | `crates/importers/oura/tests/import.rs:517:49` | H |
| `-p logbook-oura --test import` | `local_tag_identity_survives_changed_evidence_and_the_next_import_is_a_noop` | `crates/importers/oura/tests/import.rs:640:36` | H |
| `-p logbook-oura --test import` | `malformed_optional_steps_keeps_score_and_raw_value_and_reports_the_field_count` | `crates/importers/oura/tests/import.rs:538:49` | H |
| `-p logbook-oura --test import` | `only_long_sleep_supplies_resting_pulse_and_span_hrv_and_embedded_series_stay_raw` | `crates/importers/oura/tests/import.rs:394:36` | H |
| `-p logbook-oura --test import` | `public_normalization_is_identical_for_history_and_live_raw_payloads` | `crates/importers/oura/tests/import.rs:424:36` | H |
| `-p logbook-server --test http` | `every_read_rpc_leaves_raw_shards_unloaded` | `crates/logbook-server/tests/http.rs:686:13` | H |
| `-p logbook-server --test http` | `status_calls_remain_fast_while_a_real_monthly_summary_holds_the_store` | `crates/logbook-server/tests/http.rs:116:5` | H |
| `-p logbook-withings --test import` | `confirmed_scale_measures_are_metric_manual_entries_are_raw_only_and_reruns_do_nothing` | `crates/importers/withings/tests/import.rs:212:5` | S |

## Verify evidence and cleanup

Full integrated logs are on aka under `/home/simonwjackson/work/qws-logs/consumers-267427c/`:

- `resident/`: both builds, tests, Cargo overrides, resolved dependency trees and commands.
- `streaming/`: Logbook build/test logs, commands and exit statuses. The source patch is not committed.
- `integrated-summary.json`, `integrated-failures.md`, `source-checks.txt`, `provenance.txt`, `cleanup.txt`.

**Verified:** before cleanup, recursive comparisons matched both Resident consumer copies to their committed snapshots, except the expected Cargo lock updates in the copies. Integrated crate sources matched this checkout. The original consumer repositories were used only for Git revision/archive reads; neither was edited. No engine code was changed. All consumer builds/tests and result parsing ran on aka with synthetic fixtures. No real health data, rakku or yari was accessed.

Cleanup removed and checked the absence of all 15 owned directories used for this verification: `qws-harness-{coach,logbook,proseql}`, both consumer target/temp directories, the harness tooling/target, the temporary Streaming Logbook source/temp directories, and both consumers tooling/target pairs (`qws-consumers` and `qws-consumers-monitor`). Only the verification logs above remain from these runs on aka. The earlier unused pinned Git mirror was not touched.

This change updates only this report. `git diff --check` passed. Typecheck and code lint do not apply to the Markdown-only change; the configured Biome inputs exclude Markdown. No project-wide suite was rerun by this worker. Remaining adoption work and allocation costs are listed in the design notes; this experiment does not prove those proposed consumer repairs or real-data performance.

## Round 2 (bd22cf4)

**Verified on aka, 2026-10-25:** unedited Coach and the Logbook adoption branch match the expected passing counts against `bd22cf4d230fd67c3ca02e60096417506929549f`. Unedited Logbook compiles but reproduces all 60 historical Streaming failures. Lazy collections now always stream; the Resident-default conclusions above apply only to round 1. Neither deprecated `ExecutionModel` variant restores lazy residency.

| Consumer source | Consumer commit | Original ProseQL pin | Build, all targets | Full workspace tests |
|---|---|---|---|---|
| Coach, unedited | `06719890e27212cf61fa77987dc4432cd68f1dd4` | `0e3666a` | pass, exit 0 | 27 passed, 0 failed, 0 ignored; exit 0 |
| Logbook, `streaming-adoption` | `ad70bd9464f72b4a53a42f83feb1118f34fd0ad5` | `9a11d36` | pass, exit 0 | 221 passed, 0 failed, 2 ignored; exit 0 |
| Logbook, unedited | `5dbb01551ecc9ff9530e9e193e60a48daedd025c` | `9a11d36` | pass, exit 0 | 159 passed, 60 failed, 2 ignored; exit 101 |

Coach matches round 1's 27 passes. The adoption branch matches the cutover's 221 passes and 2 ignores. Unedited Logbook matches round 1's informational Streaming experiment, not its Resident-default pass. The two existing Logbook measurements remain ignored; none was enabled or newly ignored here.

### Commands and source verification

The documented runner archived committed code and synthetic fixtures only. The originals and the read-only scratch clone were not edited:

```sh
# zao: Git/archive/transport only; builds and tests execute on aka.
QWS_WORKER=consumers2 \
  QWS_LOGBOOK_REPO=/tmp/forgerie-scratch/f-ad87c1da/logbook-r2 \
  bash scripts/consumers/run.sh "$PWD"
QWS_WORKER=consumers2 bash scripts/consumers/run.sh "$PWD"
```

Both runs supplied the exact integrated SHA above. Builds used `cargo --config <patch> build --workspace --all-targets`; passing tests used `timeout 1200 cargo --config <patch> test --workspace -- --test-threads=1`. The final unedited Logbook run used `--no-fail-fast` to execute every workspace target after failures. All runs used the Nix dev shell, disabled remote builders, nice 10, `CARGO_BUILD_JOBS=2`, `RUSTFLAGS='-C target-cpu=x86-64-v2'`, separate consumer targets and synthetic filesystem temporary data. No consumer server was launched.

**Setup correction:** switching from the adoption archive to the older unedited archive exposed a runner cache bug. Git archive preserves old mtimes, while the runner reuses the same Cargo target. The initial unedited build finished in 0.09 seconds and replayed adoption-only deprecation warnings even though the copied source had no `ExecutionModel`. Its tests were stopped and excluded. On aka, `find . -type f -exec touch {} +` in the owned unedited Logbook copy invalidated inputs without changing contents. The corrected build recompiled all Logbook packages in 22.93 seconds, then ran the complete `--no-fail-fast` suite above. No source repair was needed. Follow-up: key harness targets by consumer/source revision or invalidate archive mtimes when switching revisions; otherwise repeated compatibility runs can report stale results.

`cargo tree` confirmed all four `proseql-*` crates resolved to the supplied path overrides. Before and after the runs, Git content hashes matched all 199 checked runtime, harness and flake files against `bd22cf4`. Recursive consumer-source comparisons matched the committed snapshots, excluding only expected copy-local `Cargo.lock` resolution changes. Touching unedited-copy mtimes did not change file contents.

### ProseQL build warnings

| Build | ProseQL crate warnings | ProseQL API warnings in consumer code |
|---|---:|---|
| Coach, unedited | 0 | 0 |
| Logbook, adoption branch | 0 | 6 distinct deprecation sites: 4 library sites plus 2 test sites |
| Logbook, unedited, forced rebuild | 0 | 0 |

All six adoption warnings are in `crates/logbook-core/src/storage.rs`:

| Site | Deprecated item |
|---|---|
| `10:5` | import of `proseql_native::ExecutionModel` |
| `33:32` | `ExecutionModel` type on `STORAGE_EXECUTION_MODEL` |
| `33:65` | `ExecutionModel::Streaming` constant value |
| `1412:9` | `NativeSourceRuntimeOptions::execution_model` field |
| `1767:55` | `ExecutionModel::Streaming` in a test |
| `2118:55` | `ExecutionModel::Streaming` in a test |

The enum/variant message is `Lazy collections always stream; remove the execution_model setting`. The field message is `Lazy collections always stream; omit this setting`. Cargo reports 4 library warnings and 6 library-test warnings (4 duplicates); this is six distinct source sites, not ten distinct warnings. Removing the redundant selector clears these warnings but does not replace residency-dependent reads.

### Unedited Logbook migration impact

**Verified:** the 60 failed test names exactly match the complete round-1 Streaming failure list above, across the same 13 targets. Every first panic site matches too, accounting for round 1's one-line temporary option insertion in `storage.rs`. Of the panic messages, 59 are byte-identical; the remaining message differs only in the print order of the same two expected set members. There are no additional failed tests or unexpected dependency classes.

| Adoption-notes class | Failed tests | Observed failure / required migration |
|---|---:|---|
| H — query hydration | 38 | `missing-collection`: `bounded month query did not retain its partition`. Hydrate returned query rows, not engine residency. |
| R — residency assertions | 4 | Zero loaded/resident partitions instead of one. Assert durable query results and zero lazy residency. |
| D — duplicate and selector checks | 8 | Existing samples appear new or retries hit `DuplicateKeyError`. Query candidate IDs, raw links and comparison fields. |
| L — latest rebuild | 1 | Converted sample intervals resolve to an empty list. Fold returned sample rows. |
| S — raw heads and supersession | 9 | Missing superseded membership, stale projections or extra revisions. Fold returned raw head fields; preserve eager membership reads. |

These are the five historical [adoption-note classes](../../../docs/design/query-while-scanning.md#historical-adoption-audit-at-logbook-5dbb01551ecc9ff9530e9e193e60a48daedd025c), not new engine failures. A pin-only upgrade is unsafe for unported Logbook: compilation succeeds with no warning, but its residency-dependent reads and writes fail. The adoption branch passes against this same engine without relaxing `FullScanPolicy::Error`. This verifies synthetic consumer contracts, not real-data performance or deployment.

### Evidence, cleanup and checks

Full logs and analysis remain on aka at `/home/simonwjackson/work/qws-logs/consumers-bd22cf4/`:

- `adoption/`: both passing builds/tests, commands, path patches and resolved dependency trees.
- `unedited/`: forced rebuild, full failing suite, commands, dependency tree and exit statuses.
- `summary.json`, `unedited-failures.md`, `unedited-failure-blocks.txt`, `panic-message-comparison.json`, `panic-site-comparison.json` and the analysis script.
- `warnings.txt`, `source-checks.txt`, both consumer-source comparisons, source manifest, provenance and `cleanup.txt`.
- `stale-cache-attempt/`: excluded setup-attempt logs and explanation.

**Verified cleanup:** all nine used aka copy/target/temp directories are absent: `qws-harness-{coach,logbook,proseql}`, `qws-harness-{coach,logbook}-{target,tmp}`, and `qws-consumers2{,-target}`. Only the verification logs remain from this worker. Prior workers' unrelated workspaces were not removed. No real health data, rakku or yari was accessed. Neither original consumer, the adoption scratch clone nor engine code was changed. No push or deployment occurred.

Only this Markdown report changed. `git diff --check` passed. Typecheck and code lint do not apply; Biome excludes Markdown. All consumer builds, tests and result analysis ran on aka. No project-wide suite was run by this worker. The harness timestamp invalidation is a tooling follow-up; the required Logbook migration is demonstrated above.
