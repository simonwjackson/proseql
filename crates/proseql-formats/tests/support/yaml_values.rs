//! Seeded generator of JSON values for YAML round-trip properties.
//!
//! Shared by the codec property test and the storage write-path property
//! tests through `#[path]`. Every string is synthetic. The value shapes
//! favour lists of objects, long folded text and YAML hazards.
#![allow(dead_code)]

use proseql_engine::validator::js_eq;
use serde_json::{Map, Number, Value};

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9e37_79b9_7f4a_7c15)
    }

    pub fn next_u64(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }

    pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &[
    "a",
    "oat",
    "milk",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "two",
    "tbsp",
    "-",
    "--",
    "---",
    "...",
    "#",
    "#tag",
    "a#b",
    ":",
    "a:",
    ":b",
    "a:b",
    "?",
    "- x",
    "&x",
    "*x",
    "!x",
    "%",
    "@",
    "`",
    "|",
    ">",
    "{",
    "}",
    "[",
    "]",
    ",",
    "'",
    "\"",
    "\\",
    "~",
    "null",
    "true",
    "False",
    "yes",
    "on",
    "1",
    "-1",
    "1.5",
    "1e5",
    "0x1A",
    "0o17",
    ".inf",
    "-.nan",
    "café",
    "日本語",
    "🍎",
    "e\u{301}",
    "\t",
    "a\tb",
    "→",
];

pub const SPECIAL: &[&str] = &[
    "",
    " ",
    "  ",
    "-",
    "?",
    ":",
    "#",
    "~",
    "---",
    "...",
    "- ",
    "? ",
    ": ",
    "a: b",
    "a #b",
    "- item",
    "# comment",
    "key:",
    "trailing colon:",
    " leading",
    "trailing ",
    " both ",
    "null",
    "Null",
    "NULL",
    "true",
    "True",
    "FALSE",
    "yes",
    "No",
    "on",
    "OFF",
    "y",
    "n",
    "0",
    "-0",
    "00",
    "01",
    "+1",
    "1.0",
    "1e5",
    "1E-5",
    ".5",
    "5.",
    "0x1A",
    "0o17",
    "0b101",
    "1_000",
    ".inf",
    "-.inf",
    "+.inf",
    ".nan",
    ".NaN",
    "inf",
    "nan",
    "infinity",
    "12:30",
    "2026-10-22",
    "2026-10-22T08:15:00Z",
    "\"quoted\"",
    "'single'",
    "back\\slash",
    "tab\tinside",
    "\ttab",
    "tab\t",
    "line\nbreak",
    "\nleading newline",
    "trailing newline\n",
    "  indented\nnext",
    "a\n\nb",
    "a\n  b",
    "a\r\nb",
    "a\rb",
    "bell\u{7}",
    "nul\u{0}",
    "del\u{7f}",
    "nel\u{85}",
    "ls\u{2028}",
    "bom\u{feff}",
    "café",
    "日本語のテキスト",
    "🍎 and 🍌",
    "<<",
    "=",
    "!!str x",
    "%YAML",
    "@at",
    "`tick`",
    "{a: 1}",
    "[1, 2]",
    "a, b",
    "|",
    ">",
    "|-",
    ">+",
    "*alias",
    "&anchor",
    "!tag",
    "a ? b",
    "x - y",
    "x -",
    "x:",
    "x: ",
    "x :y",
];

fn word(rng: &mut Rng) -> String {
    rng.pick(WORDS).to_owned()
}

pub fn string(rng: &mut Rng) -> String {
    match rng.below(4) {
        0 => rng.pick(SPECIAL).to_owned(),
        1 => {
            // Two hazards joined: covers hazards in the middle and at the end.
            format!(
                "{}{}{}",
                rng.pick(SPECIAL),
                rng.pick(&[" ", "", "  "]),
                rng.pick(SPECIAL)
            )
        }
        _ => {
            // Word runs long enough to fold at every tested width.
            let count = 1 + rng.below(40);
            let mut text = String::new();
            if rng.below(8) == 0 {
                text.push_str(rng.pick(&[" ", "- ", "# ", "? ", ": "]));
            }
            for index in 0..count {
                if index > 0 {
                    text.push_str(rng.pick(&[
                        " ", " ", " ", " ", " ", " ", "  ", "   ", "\t", " \t", "\n", "\n\n",
                        "\n  ", " \n", "\r\n",
                    ]));
                }
                text.push_str(&word(rng));
            }
            if rng.below(8) == 0 {
                text.push_str(rng.pick(&[" ", ":", " #x", "\n", "  "]));
            }
            text
        }
    }
}

fn number(rng: &mut Rng) -> Value {
    match rng.below(7) {
        0 => Value::from(rng.below(1000) as i64 - 500),
        1 => Value::from(rng.next_u64()),
        2 => Value::from(rng.next_u64() as i64),
        3 => Value::from(0.0),
        4 => Number::from_f64(rng.pick(&[1.5, -0.25, 1e21, 1e-7, 123456.789, 1.0, -0.0, 5e-324]))
            .map_or(Value::Null, Value::Number),
        _ => Number::from_f64(f64::from_bits(rng.next_u64())).map_or(Value::from(7), Value::Number),
    }
}

fn scalar(rng: &mut Rng) -> Value {
    match rng.below(10) {
        0 => Value::Null,
        1 => Value::Bool(rng.below(2) == 0),
        2 | 3 => number(rng),
        _ => Value::String(string(rng)),
    }
}

pub fn key(rng: &mut Rng) -> String {
    match rng.below(4) {
        0 => string(rng),
        1 => rng.pick(SPECIAL).to_owned(),
        _ => (rng.pick(&[
            "id", "food", "quantity", "items", "note", "meal-x", "a b", "k",
        ]))
        .to_owned(),
    }
}

pub fn value(rng: &mut Rng, depth: u32) -> Value {
    if depth == 0 {
        return scalar(rng);
    }
    match rng.below(8) {
        0 | 1 => {
            let mut map = Map::new();
            for _ in 0..rng.below(5) {
                map.insert(key(rng), value(rng, depth - 1));
            }
            Value::Object(map)
        }
        2 => Value::Array((0..rng.below(4)).map(|_| value(rng, depth - 1)).collect()),
        3 | 4 => {
            // Lists of objects: the shape that broke in production.
            Value::Array(
                (0..1 + rng.below(3))
                    .map(|_| {
                        let mut map = Map::new();
                        for _ in 0..1 + rng.below(4) {
                            map.insert(key(rng), value(rng, depth - 1));
                        }
                        Value::Object(map)
                    })
                    .collect(),
            )
        }
        _ => scalar(rng),
    }
}

/// Structural equality with JS number semantics (`1` equals `1.0`).
pub fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| same(a, b))
        }
        _ => js_eq(left, right),
    }
}
