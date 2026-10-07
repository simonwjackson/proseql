//! A Prose file used as a database must not lose a line without an error.
//! The default codec keeps ignoring unmatched lines, so Prose can still sit
//! inside Markdown. The strict policy rejects them.
use proseql_formats::prose::{ProseCodec, ProseCodecOptions, UnmatchedLines};
use proseql_formats::FormatCodec;
use serde_json::json;

const TEMPLATE: &str = "[{id}] {t} {speaker}: {text}";

fn strict() -> ProseCodec {
    ProseCodec::with_options(ProseCodecOptions {
        template: Some(TEMPLATE.to_owned()),
        overflow: vec![],
        unmatched_lines: UnmatchedLines::Error,
    })
}

#[test]
fn a_hand_edit_that_breaks_the_template_fails_with_its_line_number() {
    // Turns 12-14 of the second 2026-06-10 call, turn 13 edited so ": " became " - ".
    let file = "@prose [{id}] {t} {speaker}: {text}\n\n\
[0012] 2:24 D: Okay.\n\
[0013] 2:25 SJ - On the left-hand side, you'll see a bunch of icons.\n\
[0014] 2:34 D: This, the database projects.";
    let error = strict().decode(file).unwrap_err();
    assert!(error.contains("line 4"), "{error}");
    assert!(error.contains("[0013] 2:25 SJ - On the left"), "{error}");
}

#[test]
fn a_note_above_the_directive_fails() {
    let file = "# reviewed 2026-10-06\n@prose [{id}] {t} {speaker}: {text}\n\n[1] 0:04 D: Hi";
    let error = strict().decode(file).unwrap_err();
    assert!(error.contains("line 1"), "{error}");
}

#[test]
fn an_indented_line_without_an_overflow_template_fails() {
    let file = "@prose [{id}] {t} {speaker}: {text}\n\n[1] 0:04 D: Hi\n  stray note";
    let error = strict().decode(file).unwrap_err();
    assert!(error.contains("line 4"), "{error}");
}

#[test]
fn blank_lines_and_overflow_lines_are_accepted() {
    let codec = ProseCodec::with_options(ProseCodecOptions {
        template: Some("[{id}] {title}".to_owned()),
        overflow: vec!["~ {description}".to_owned()],
        unmatched_lines: UnmatchedLines::Error,
    });
    let file = "@prose [{id}] {title}\n  ~ {description}\n\n[1] Dune\n  ~ Spice\n    and sand\n\n[2] Emma\n  ~ Matchmaking\n";
    assert_eq!(
        codec.decode(file).unwrap(),
        json!([
            {"id": 1, "title": "Dune", "description": "Spice\nand sand"},
            {"id": 2, "title": "Emma", "description": "Matchmaking"}
        ])
    );
}

#[test]
fn the_default_codec_still_ignores_markdown_around_records() {
    let codec = ProseCodec::new(None, vec![]);
    let file = "# Books\n@prose [{id}] {title}\n\nSome prose.\n[1] Dune";
    assert_eq!(
        codec.decode(file).unwrap(),
        json!([{"id": 1, "title": "Dune"}])
    );
}
