# Prose Format (.prose)

## Status: Placeholder

## Overview

A template-driven text format where each record is a single line of human-readable prose. The file header declares a template string that maps field names to positions within a natural-language sentence structure.

## Concept

```
@prose "{title}" by {author} ({year}) — {genre}

"Dune" by Frank Herbert (1965) — sci-fi
"Neuromancer" by William Gibson (1984) — sci-fi
"The Left Hand of Darkness" by Ursula K. Le Guin (1969) — sci-fi
```

- The `@prose` directive defines the record template
- Each subsequent non-blank line is one record
- Fields are interpolated by name using `{fieldName}` syntax
- The template IS the documentation — reading it tells you the shape
- One record per line produces clean, meaningful git diffs

## Key Design Questions

- How are strings with special characters (parentheses, em-dashes) escaped?
- How are multi-value fields (arrays, nested objects) represented?
- Can templates reference nested fields?
- Should the format support comments?
- How does the parser disambiguate field boundaries in edge cases?

## Relationship to FormatCodec

Implements `FormatCodec` with extensions `["prose"]`. The template is encoded as the first line of the file, making the format self-describing — no external schema required for parsing.
