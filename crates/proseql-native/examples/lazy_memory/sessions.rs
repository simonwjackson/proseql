//! The same synthetic workloads with an explicit source lifetime per operation.
//! Idle requested bytes do not stand in for loaded-record bytes per row.
use super::*;
use proseql_native::{IdleMemoryReclaim, NativeSourceSessions};

pub(super) fn run(args: &Args, profile: Profile) -> Result<(), Error> {
    if fs::read_to_string(args.root.join("complete.json"))? != marker(args) {
        return Err("dataset parameters differ; prepare a fresh fixture".into());
    }
    #[cfg(feature = "bench-observe")]
    assert!(proseql_storage::diagnostics::set_observer(checkpoint));
    let (config, options) = config(args);
    checkpoint("session_owner_open", true);
    let start = Instant::now();
    let owner = NativeSourceSessions::new(config, options).map_err(tag)?;
    let owner = if args.reclaim_idle {
        owner
            .reclaim_idle_memory(IdleMemoryReclaim::GlibcTrim)
            .map_err(tag)?
    } else {
        owner
    };
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    checkpoint("session_owner_open", false);
    let opened = heap();
    let open_rss = proc_bytes("VmRSS:");
    let mut query_ms = 0.0;
    if args.mode != "empty" {
        let count = if args.mode == "scan" || args.mode == "eager-id" || args.mode == "cold" {
            1
        } else {
            MONTHS
        };
        for ordinal in 1..=count {
            let month = if args.mode == "cold" { MONTHS } else { ordinal };
            let width = match args.mode.as_str() {
                "ascending" => 1 + (month - 1) % 3,
                "scan" => MONTHS,
                _ => 1,
            };
            let end = (month + width).min(MONTHS + 1);
            let field = if args.consumer { "atUtc" } else { "timestamp" };
            let input = if args.mode == "eager-id" {
                QueryInput {
                    r#where: Some(json!({"id":{"$eq":"synthetic-absent-id"}})),
                    ..Default::default()
                }
            } else {
                let mut filter = json!({field:{"$gte":format!("2025-{month:02}-01T00:00:00.000Z"),"$lt":format!("2025-{end:02}-01T00:00:00.000Z")}});
                if args.mode != "ascending" {
                    filter["value"] = json!({"$lt":-1});
                }
                QueryInput {
                    r#where: Some(filter),
                    sort: vec![(field.into(), SortOrder::Asc)],
                    ..Default::default()
                }
            };
            checkpoint("query_total", true);
            let start = Instant::now();
            let (rows, stats) = owner
                .with_session(|runtime| {
                    if args.bounded {
                        runtime
                            .query_bounded_with_stats(COLLECTION, input)
                            .map(|(rows, stats)| (rows, Some(stats)))
                    } else {
                        runtime
                            .query(COLLECTION, input, None)
                            .map(|rows| (rows, None))
                    }
                })
                .map_err(tag)?;
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            query_ms += elapsed_ms;
            checkpoint("query_total", false);
            assert_eq!(
                rows.len(),
                if args.mode == "ascending" {
                    (end - month) * args.rows
                } else {
                    0
                }
            );
            println!(
                "LM_QUERY {}",
                json!({"month":month,"width":end-month,"sessions":true,"elapsed_ms":elapsed_ms,"returned":rows.len(),"partitions_read":stats.as_ref().map(|s|s.partitions_read),"heap_with_results":heap(),"rss":proc_bytes("VmRSS:"),"rss_hwm":proc_bytes("VmHWM:")})
            );
            let returned = rows.len();
            drop(rows);
            if args.reclaim_idle && returned > 0 {
                // This is an explicit caller hook, not automatic reclamation
                // of results after they escape the session owner.
                let before = proc_bytes("VmRSS:");
                let start = Instant::now();
                let released = owner.release_unused_memory();
                println!(
                    "LM_CALLER_RECLAIM {}",
                    json!({"returned_rows_dropped":returned,"released":released,"elapsed_ms":start.elapsed().as_secs_f64()*1000.0,"before_rss":before,"after_rss":proc_bytes("VmRSS:")})
                );
            }
            checkpoint("session_without_caller_results", false);
        }
    }
    if args.append_one {
        let row = if args.mode == "eager-id" || args.mode == "empty" {
            json!({"id":"synthetic-appended-id"})
        } else {
            let mut row = if args.consumer {
                consumer_row(10, args.rows + 1, args.rows + 2)
            } else {
                synthetic_row(10, args.rows + 1, args.rows + 2)
            };
            row["id"] = json!("synthetic-appended-row");
            if args.source_kind == "sharded" {
                row["shard"] = json!("ff");
            }
            row
        };
        checkpoint("append_total", true);
        drop(
            owner
                .with_session(|runtime| runtime.mutate(|tx| tx.create(COLLECTION, row)))
                .map_err(tag)?,
        );
        checkpoint("append_total", false);
    }
    checkpoint("idle_now", false);
    let idle_rss = proc_bytes("VmRSS:");
    let idle_allocator = allocator_os::stats();
    if args.idle_seconds > 0 {
        std::thread::sleep(std::time::Duration::from_secs(args.idle_seconds));
        checkpoint("idle_after_wait", false);
    }
    let final_heap = heap();
    let delta = final_heap["live"]
        .as_u64()
        .zip(opened["live"].as_u64())
        .map(|(end, start)| end.saturating_sub(start));
    let failed = args.idle_check && delta.is_none_or(|bytes| bytes > 64 * 1024);
    println!(
        "LM_SUMMARY {}",
        json!({
            "mode":args.mode,"sessions":true,"reclaim_idle":args.reclaim_idle,"bounded":args.bounded,
            "fixture":if args.consumer {"consumer"} else {"legacy"},"source_kind":args.source_kind,
            "rows_per_month":args.rows,"id_rows":args.ids,"history_copies":args.history_copies,
            "cache_partitions":args.cache_partitions,"appended":args.append_one,
            "open_ms":open_ms,"query_ms":query_ms,"open_rss":open_rss,"opened_heap":opened,
            "idle_live_delta":delta,"idle_budget_bytes":64*1024,"idle_rss":idle_rss,"idle_seconds":args.idle_seconds,
            "idle_allocator":idle_allocator,"final_heap":final_heap,
            "rss":proc_bytes("VmRSS:"),"rss_hwm":proc_bytes("VmHWM:"),"allocator":allocator_os::stats(),
            "resident_bytes_per_row":null,"idle_rows":null,"check_failed":failed,
            "loaded_row_density_measured":false,"caller_output_reclaim_enabled":args.reclaim_idle,"instrumented":cfg!(feature="bench-observe"),"profiled":PROFILING.load(Ordering::Relaxed)
        })
    );
    if args.trim_end {
        let before_rss = proc_bytes("VmRSS:");
        let released = allocator_os::trim();
        println!(
            "LM_ALLOCATOR_TRIM {}",
            json!({"released":released,"before_rss":before_rss,"after_rss":proc_bytes("VmRSS:")})
        );
    }
    PROFILING.store(false, Ordering::Relaxed);
    #[cfg(feature = "heap-profile")]
    drop(profile);
    #[cfg(not(feature = "heap-profile"))]
    let _ = profile;
    if failed {
        return Err("source-session idle live heap exceeded owner-open heap plus 64 KiB, or heap was unmeasured".into());
    }
    Ok(())
}
