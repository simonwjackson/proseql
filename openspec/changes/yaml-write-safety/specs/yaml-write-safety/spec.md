## ADDED Requirements

### Requirement: YAML output reads back

The native YAML codec SHALL encode every JSON value so that decoding the output gives the same value, with JS number semantics and key order ignored, at any indent of 2 or more and any line width.

#### Scenario: Long first key of a list item
- **WHEN** the first key of a list-item mapping holds a plain string with spaces that is longer than the line width
- **THEN** its folded lines continue one indent level deeper than the key, and the file decodes to the same value

#### Scenario: Generated values
- **WHEN** the seeded property test encodes nested objects, arrays, lists of objects, empty containers and hazard strings at indents 2 and 4 and widths 20, 80 and 120
- **THEN** every encoding decodes to its input

#### Scenario: Unchanged output
- **WHEN** a value already read back with the previous encoder at indent 2
- **THEN** its encoding keeps the same bytes, except keys starting with `---` or `...` and strings containing a BOM, which are quoted

### Requirement: Refuse writes that do not read back

`FormatRegistry::serialize` SHALL decode the output of every codec whose `round_trips_exactly` is true, while the registry's write check is on, and SHALL return `SerializationError` with `cause.reason = "round-trip-mismatch"` when the decoded value differs from the input. The write check SHALL be on by default.

#### Scenario: Unparseable output
- **WHEN** a codec that declares an exact round trip returns text that does not parse
- **THEN** `serialize` returns `SerializationError` whose message starts with `Refused to write` and whose cause has no `pointer`

#### Scenario: Output that reads back differently
- **WHEN** the text parses to another value
- **THEN** the cause's `pointer` names the first differing location, and the message contains no values

#### Scenario: Native mutation with a refused write
- **WHEN** a mutation's planned YAML write is refused
- **THEN** the mutation returns the error, no file changes, memory rolls back, the runtime is not quarantined, and a later valid mutation succeeds

#### Scenario: Several partitions
- **WHEN** one of several changed partitions is refused
- **THEN** no partition file is written

#### Scenario: Check turned off
- **WHEN** a caller calls `set_write_check(false)` on the registry
- **THEN** `serialize` returns the codec output without decoding it

### Requirement: Splices keep block-scalar content with its record

The YAML splicer SHALL treat a record's body as the shortest span of its entry that decodes to its loaded value.

#### Scenario: Block scalar ending in a comment-like line
- **WHEN** a record's last field is a block scalar whose last line starts with `#`, and that record changes
- **THEN** the save succeeds, the file decodes to the saved collections, and a real comment after the record stays in place

#### Scenario: Splice property
- **WHEN** the seeded property test creates a document and then updates, inserts and deletes records over several saves at indents 2 and 4 and widths 20, 80 and 120
- **THEN** every save succeeds and the file loads back to exactly the saved collections

### Requirement: Legacy TypeScript YAML codec reads back

The `@proseql/core` YAML codec SHALL return output that decodes to its input for the same hazard strings and shapes, at indents 2 and 4 and widths 20, 80 and 120. When the `yaml` package's output contains a block scalar that does not read back, the codec SHALL return quoted, unfolded output instead.

#### Scenario: Indent 4 with a leading-space line
- **WHEN** the codec encodes `"  indented\nnext"` at indent 4
- **THEN** the output decodes to `"  indented\nnext"`

#### Scenario: WASM engine persistence
- **WHEN** the WASM engine persists the production meal shape and the hazard strings to a YAML file and reopens it
- **THEN** every record reads back unchanged
