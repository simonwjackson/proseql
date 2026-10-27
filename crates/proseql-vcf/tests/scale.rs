//! Explicit warm-filesystem measurement. No personal contacts or network I/O.
mod support;
use std::{fmt::Write, time::Instant};
#[test]
#[ignore = "explicit 2,000-file PHOTO scale measurement; run alone in release mode"]
fn two_thousand_photo_cards_open_and_full_reload() {
    let dir = tempfile::tempdir().unwrap();
    let mut photo = String::new();
    for _ in 0..2666 {
        photo.push_str("\r\n ");
        photo.push_str(&"A".repeat(72));
    }
    let mut total = 0_u64;
    let mut max = 0;
    for n in 0..2000 {
        let mut raw=format!("BEGIN:VCARD\r\nVERSION:3.0\r\nX-PROSEQL-FIXTURE:Synthetic scale card\r\nUID:urn:uuid:scale-{n}\r\nFN:Synthetic {n}\r\nEMAIL:synthetic-{n}@example.invalid\r\nADR:;;10 Example Street;Sampletown;;;\r\nPHOTO;ENCODING=b;TYPE=JPEG:");
        raw.push_str(&photo);
        write!(raw, "\r\nEND:VCARD\r\n").unwrap();
        assert!((190_000..=205_000).contains(&raw.len()));
        total += raw.len() as u64;
        max = max.max(raw.len());
        std::fs::write(dir.path().join(format!("contact-{n:04}.vcf")), raw).unwrap();
    }
    let start = Instant::now();
    let runtime = support::open(dir.path());
    let open = start.elapsed();
    let path = dir.path().join("contact-1000.vcf");
    let raw = std::fs::read_to_string(&path).unwrap();
    std::fs::write(path, raw.replace("FN:Synthetic 1000", "FN:External 1000")).unwrap();
    let start = Instant::now();
    runtime.reload().unwrap();
    let reload = start.elapsed();
    assert_eq!(
        runtime
            .find_by_id("contacts", "contact-1000")
            .unwrap()
            .unwrap()["fn"],
        "External 1000"
    );
    eprintln!("record_files_vcf_scale files=2000 total_bytes={total} max_file_bytes={max} open_ms={:.3} full_reload_ms={:.3} profile={} os={} arch={} logical_cpus={} cache=warm-generated-files parser=calcard-0.3.13",open.as_secs_f64()*1000.0,reload.as_secs_f64()*1000.0,if cfg!(debug_assertions) {"debug"}else{"release"},std::env::consts::OS,std::env::consts::ARCH,std::thread::available_parallelism().unwrap());
    runtime.close().unwrap();
}
