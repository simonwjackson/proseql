## ADDED Requirements

### Requirement: Codec factory

The `proseCodec()` factory SHALL accept a configuration object with a required `template` string and an optional `overflow` array of template strings, and SHALL return a `FormatCodec` with `name: "prose"` and `extensions: ["prose"]`.

#### Scenario: Create codec with headline template only
- **WHEN** `proseCodec({ template: '#{id} "{title}" by {author} ({year})' })` is called
- **THEN** a `FormatCodec` is returned with `name` equal to `"prose"` and `extensions` equal to `["prose"]`

#### Scenario: Create codec with overflow templates
- **WHEN** `proseCodec({ template: '#{id} "{title}" ({year})', overflow: ['tagged {tags}', '~ {description}'] })` is called
- **THEN** a `FormatCodec` is returned that encodes/decodes records with headline fields and overflow fields

### Requirement: Directive scanning

The decoder SHALL scan the input string top-to-bottom for a line starting with `@prose `. All lines before the directive are preamble. All lines after the directive block are the body. The `@prose` directive need not be on line 1.

#### Scenario: Directive on first line
- **WHEN** decoding a string where line 1 is `@prose #{id} {name}`
- **THEN** the directive is found with no preamble and parsing proceeds

#### Scenario: Directive preceded by preamble
- **WHEN** decoding a string where lines 1-3 are markdown text and line 5 is `@prose #{id} {name}`
- **THEN** lines 1-3 are preamble and parsing begins from line 5

#### Scenario: No directive found
- **WHEN** decoding a string with no line starting with `@prose `
- **THEN** the decoder throws an error

#### Scenario: Multiple directives
- **WHEN** decoding a string containing two lines starting with `@prose `
- **THEN** the decoder throws an error (only one directive per file)

### Requirement: Template compilation

The template string SHALL be compiled into an ordered list of alternating literal and field segments. Field placeholders use `{fieldName}` syntax. Everything outside `{...}` is a literal delimiter.

#### Scenario: Compile simple template
- **WHEN** template is `#{id} "{title}" by {author}`
- **THEN** segments are: field(`id`), literal(`" "`), field(`title`), literal(`" by `), field(`author`)

#### Scenario: Template with no literals between fields
- **WHEN** template is `{first}{last}`
- **THEN** segments are: field(`first`), field(`last`) with no literal between them, and the decoder throws an error because adjacent fields without a literal separator are ambiguous

#### Scenario: Template with leading literal
- **WHEN** template is `Book: {title}`
- **THEN** segments are: literal(`Book: `), field(`title`)

### Requirement: Headline encoding

The encoder SHALL produce one headline per record by substituting field values into the template. Literal segments are emitted verbatim. Field values are serialized according to value type rules.

#### Scenario: Encode flat record
- **WHEN** encoding `{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 }` with template `#{id} "{title}" by {author} ({year})`
- **THEN** the output line is `#1 "Dune" by Frank Herbert (1965)`

#### Scenario: Encode record with null field
- **WHEN** encoding `{ id: "1", title: "Dune", author: null }` with template `#{id} "{title}" by {author}`
- **THEN** the null field is encoded as `~`, producing `#1 "Dune" by ~`

### Requirement: Headline decoding

The decoder SHALL parse each non-indented line in the body by matching it against the compiled template. A line matches if all literal segments appear in the expected order. Text between literals is captured into the corresponding field.

#### Scenario: Decode matching line
- **WHEN** decoding line `#1 "Dune" by Frank Herbert (1965)` with template `#{id} "{title}" by {author} ({year})`
- **THEN** the record `{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 }` is produced

#### Scenario: Non-matching line is pass-through
- **WHEN** decoding line `## The Golden Age` which does not match the template
- **THEN** the line is treated as pass-through text and not parsed as a record

#### Scenario: Greedy last field
- **WHEN** decoding line `#1 "Dune" by Frank Herbert` with template `#{id} "{title}" by {author}`
- **THEN** the `author` field captures `Frank Herbert` (greedy to end of line)

### Requirement: Quoting

When a field value contains characters that match a subsequent literal delimiter in the template, the encoder SHALL wrap the value in double quotes. The decoder SHALL recognize quoted values and extract them by scanning for the closing `"`.

#### Scenario: Encode value containing delimiter
- **WHEN** encoding `{ id: "1", title: "Dune", author: "Author (Jr.)", year: 1999 }` with template `#{id} "{title}" by {author} ({year})`
- **THEN** `author` is quoted because it contains `(`, producing `#1 "Dune" by "Author (Jr.)" (1999)`

#### Scenario: Decode quoted value
- **WHEN** decoding line `#1 "Dune" by "Author (Jr.)" (1999)` with template `#{id} "{title}" by {author} ({year})`
- **THEN** `author` is `Author (Jr.)` (quotes stripped)

#### Scenario: Escaped quotes within quoted value
- **WHEN** decoding line `#1 "Dune" by "She said \"hello\"" (1999)` with template `#{id} "{title}" by {author} ({year})`
- **THEN** `author` is `She said "hello"`

#### Scenario: Last field never quoted
- **WHEN** encoding `{ id: "1", genre: "sci-fi (classic)" }` with template `#{id} {genre}`
- **THEN** `genre` is not quoted (last field is greedy): `#1 sci-fi (classic)`

### Requirement: Value type serialization

The encoder SHALL serialize values by type: strings as bare or quoted text, numbers as digit characters, booleans as `true`/`false`, null as `~`, and arrays as `[element, element, ...]`.

#### Scenario: Encode number
- **WHEN** encoding field value `1965`
- **THEN** output is `1965`

#### Scenario: Encode boolean
- **WHEN** encoding field value `true`
- **THEN** output is `true`

#### Scenario: Encode null
- **WHEN** encoding field value `null`
- **THEN** output is `~`

#### Scenario: Encode array
- **WHEN** encoding field value `["sci-fi", "classic"]`
- **THEN** output is `[sci-fi, classic]`

#### Scenario: Encode array element containing comma
- **WHEN** encoding field value `["one, two", "three"]`
- **THEN** output is `["one, two", three]` (element containing `,` is quoted)

### Requirement: Value type decoding

The decoder SHALL apply heuristic type detection: values matching `/^-?\d+(\.\d+)?$/` decode as numbers, `true`/`false` as booleans, `~` as null, values enclosed in `[...]` as arrays, and all others as strings.

#### Scenario: Decode number
- **WHEN** field value text is `1965`
- **THEN** decoded value is number `1965`

#### Scenario: Decode boolean
- **WHEN** field value text is `true`
- **THEN** decoded value is boolean `true`

#### Scenario: Decode null
- **WHEN** field value text is `~`
- **THEN** decoded value is `null`

#### Scenario: Decode array
- **WHEN** field value text is `[sci-fi, classic]`
- **THEN** decoded value is array `["sci-fi", "classic"]`

#### Scenario: Decode string (default)
- **WHEN** field value text is `Frank Herbert`
- **THEN** decoded value is string `"Frank Herbert"`

### Requirement: Overflow template encoding

The encoder SHALL write overflow fields as indented lines following the headline, using the overflow template patterns. Overflow fields with null or undefined values SHALL be omitted.

#### Scenario: Encode record with overflow
- **WHEN** encoding `{ id: "1", title: "Dune", tags: ["classic"] }` with overflow template `tagged {tags}`
- **THEN** output includes headline followed by indented line `  tagged [classic]`

#### Scenario: Omit null overflow field
- **WHEN** encoding `{ id: "1", title: "Dune", tags: null }` with overflow template `tagged {tags}`
- **THEN** no overflow line for tags is emitted

### Requirement: Overflow template decoding

The decoder SHALL try each overflow template in order against indented lines within a record. If a line matches the next expected overflow template, the field is captured. If it does not match, the template is skipped (field is null) and the next template is tried.

#### Scenario: Decode overflow fields in order
- **WHEN** record has indented lines `  tagged [classic]` then `  ~ A great book`
- **AND** overflow templates are `['tagged {tags}', '~ {description}']`
- **THEN** `tags` is `["classic"]` and `description` is `"A great book"`

#### Scenario: Skip missing overflow field
- **WHEN** record has indented line `  ~ Just a description`
- **AND** overflow templates are `['tagged {tags}', '~ {description}']`
- **THEN** `tags` is `null` and `description` is `"Just a description"`

#### Scenario: No overflow lines
- **WHEN** record has no indented lines
- **THEN** all overflow fields are `null`

### Requirement: Multi-line continuation

When an indented line within a record does not match any remaining overflow template, it SHALL be treated as a continuation of the last captured field's value. Continuation lines are concatenated with newline separators. Continuation lines MUST be indented deeper than the overflow template level.

#### Scenario: Multi-line description
- **WHEN** record has indented lines `  ~ A great book about` then `    sandworms and spice.`
- **AND** overflow template is `['~ {description}']`
- **THEN** `description` is `"A great book about\nsandworms and spice."`

#### Scenario: Continuation does not match next overflow
- **WHEN** record has lines `  ~ A book about` then `    tags: some call them labels` then `  tagged [classic]`
- **AND** overflow templates are `['~ {description}', 'tagged {tags}']`
- **THEN** `description` is `"A book about\ntags: some call them labels"` and `tags` is `["classic"]`

### Requirement: Pass-through text handling

Any non-indented line in the body that does not match the headline template SHALL be treated as pass-through text. The decoder SHALL preserve pass-through text in the decoded document structure. The encoder (v1) MAY omit pass-through text when encoding from a plain record array.

#### Scenario: Markdown headings as pass-through
- **WHEN** the body contains `## Science Fiction` between record lines
- **THEN** the line is preserved as pass-through and does not produce a record

#### Scenario: Narrative text as pass-through
- **WHEN** the body contains `These are my favorite books:` which does not match the template
- **THEN** the line is preserved as pass-through

### Requirement: File output structure

The encoder SHALL produce files with the `@prose` directive as the first non-blank line (when no preamble), followed by overflow template declarations (indented), a blank line, then records. Records with overflow fields are followed by their indented overflow lines.

#### Scenario: Encode empty collection
- **WHEN** encoding an empty array
- **THEN** output is the `@prose` directive line, overflow declarations, and a trailing newline

#### Scenario: Encode multiple records
- **WHEN** encoding three records
- **THEN** output contains the directive, a blank line, then three headline lines (with any overflow lines indented beneath each)

### Requirement: Round-trip fidelity

For any array of flat record objects, `decode(encode(data))` SHALL produce an array of records with structurally equal field values (same keys, same values by type and content).

#### Scenario: Round-trip flat records
- **WHEN** encoding then decoding `[{ id: "1", title: "Dune", year: 1965 }]`
- **THEN** the decoded array contains one record with `id` = `"1"`, `title` = `"Dune"`, `year` = `1965`

#### Scenario: Round-trip with overflow fields
- **WHEN** encoding then decoding `[{ id: "1", title: "Dune", tags: ["classic"], description: "A great book" }]` with overflow templates
- **THEN** the decoded record has `tags` = `["classic"]` and `description` = `"A great book"`

#### Scenario: Round-trip with quoting
- **WHEN** encoding then decoding a record where a field value contains a template delimiter
- **THEN** the decoded value equals the original (quoting is transparent)
