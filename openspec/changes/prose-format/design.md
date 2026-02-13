## Context

ProseQL serializes collection data through the `FormatCodec` interface: synchronous `encode(data: unknown) => string` and `decode(raw: string) => unknown`. Codecs are registered by file extension via `makeSerializerLayer`, which builds an O(1) extension-to-codec dispatch map. Existing codecs (JSON, YAML, TOML, etc.) are schema-agnostic — they serialize arbitrary data structures without knowledge of field names or types.

The `.prose` format is fundamentally different: it's **template-driven**. A `@prose` directive defines a sentence-like pattern mapping field names to positions within literal delimiter text. Records follow this pattern, producing human-readable lines. This creates a tension with the current architecture: the codec needs a template to encode, but the `FormatCodec` contract is stateless and generic.

Crucially, the `@prose` directive is a **protocol, not a file format**. The parser scans for `@prose` anywhere in the file — everything before it is preamble, everything after is the record/comment body. This means `.prose` can be embedded inside any text file: a markdown document, a plain text README, or a standalone `.prose` file. The `.prose` extension is just the pure form; the protocol itself is host-format-agnostic.

## Goals / Non-Goals

**Goals:**

- Implement `proseCodec()` factory returning a standard `FormatCodec`
- Hand-written parser/encoder with zero external dependencies
- Round-trip fidelity: `decode(encode(data))` produces structurally equal records
- Preserve comments and inter-record text through encode/decode cycles
- Self-describing files (template embedded via `@prose` directive)
- Host-format-agnostic: the `@prose` directive can appear inside any text file (`.prose`, `.md`, `.txt`, etc.) — the parser scans for it rather than assuming a fixed file structure

**Non-Goals:**

- Nested object support (`.prose` is flat records only)
- Streaming/incremental parsing
- Schema-aware type coercion during parsing (the codec returns raw parsed values; ProseQL's schema layer handles validation)
- Per-collection codec dispatch (if needed later, that's a persistence layer enhancement, not a codec concern)

## Decisions

### 1. Template as constructor argument

The template is a **codec configuration concern**, not a data concern. The factory requires it:

```typescript
proseCodec({
  template: '#{id} "{title}" by {authorId} ({year}) — {genre}',
  overflow: [
    'tagged {tags}',
    '~ {description}',
  ],
})
```

**Why not derive it from data?** Auto-generating a template from field names (`@prose {id} {title} {author} {year}`) produces ugly, delimiter-free output. The whole point of `.prose` is human-authored templates with meaningful literal text. This is a creative choice that belongs in configuration.

**Why not read it from the file?** The encoder receives `(data: unknown) => string` — it has no access to the existing file. The template must be available at codec construction time.

**The file still contains the template** as the `@prose` header line. This makes files self-documenting for humans. The decoder reads it for parsing. The encoder writes the constructor template as the header.

**Alternative considered:** Embedding template as a Symbol property on the decoded array. Rejected because ProseQL's internal state management (`Ref<ReadonlyMap>`) reconstructs arrays from individual records, losing any array-level metadata.

### 2. Directive scanning — `@prose` as protocol

The parser does not assume the `@prose` directive is on line 1. It scans the file top-to-bottom for a line starting with `@prose `. The file is divided into three zones:

```
PREAMBLE         — all lines before @prose (preserved verbatim)
DIRECTIVE BLOCK  — @prose headline + indented overflow templates
BODY             — everything after: records, overflow, and pass-through text
```

This makes the prose protocol embeddable in any host file. A `.md` file can be both a rendered markdown document and a parseable database:

```markdown
# My Book Collection

A curated list of science fiction classics.

@prose #{id} "{title}" by {authorId} ({year}) — {genre}

## The Golden Age

#1 "Dune" by frank-herbert (1965) — sci-fi
#2 "The Left Hand of Darkness" by ursula-k-le-guin (1969) — sci-fi

## The Cyberpunk Wave

#3 "Neuromancer" by william-gibson (1984) — sci-fi
```

The markdown headings, paragraphs, and horizontal rules are non-matching lines — preserved as pass-through text. The three `#N "..."` lines match the template and parse as records.

The `.prose` extension is the default registration, but users can register the codec for any extension via the plugin system or `makeSerializerLayer`.

**Constraint:** Only one `@prose` directive per file. If multiple are found, the codec errors. One template, one collection, one file.

### 3. Template compilation strategy

At construction time, the template string is compiled into a **segment list** — alternating literal and field segments:

```
Template: #{id} "{title}" by {authorId} ({year})

Segments: [
  { type: "field", name: "id" },
  { type: "literal", text: " \"" },
  { type: "field", name: "title" },
  { type: "literal", text: "\" by " },
  { type: "field", name: "authorId" },
  { type: "literal", text: " (" },
  { type: "field", name: "year" },
  { type: "literal", text: ")" },
]
```

For **encoding**, field values replace their segments, literals are emitted verbatim.

For **decoding**, the segment list drives a left-to-right scanner: match the next literal, capture everything between the current position and that literal into the current field. The last field on a line is greedy (captures to end of line).

**Why not compile to regex?** Regex is fragile with user-provided literal text that may contain regex metacharacters, and produces obscure errors. A hand-written scanner gives precise error messages with position info.

### 4. Quoting rules

A field value must be double-quoted when it contains any character sequence matching a subsequent literal delimiter in the template. The quoting logic:

- **Encode:** For each non-last field, check if the raw value contains the next literal delimiter. If yes, wrap in `"..."` and escape inner `"` as `\"`.
- **Decode:** If a field value starts with `"`, scan for the closing `"` (respecting `\"` escapes) instead of scanning for the next literal.
- **Last field on a line** never needs quoting (it's greedy to EOL).

### 5. Preamble and pass-through text preservation

The file has three regions of non-record text:

- **Preamble**: everything before `@prose` (e.g., markdown frontmatter, headings, prose paragraphs)
- **Directive block**: the `@prose` line and its indented overflow templates
- **Pass-through lines**: non-indented lines in the body that don't match the headline template (e.g., markdown headings, horizontal rules, narrative text between record groups)

The codec tracks all three as a document structure:

```typescript
interface ProseDocument {
  preamble: string[]        // lines before @prose directive
  entries: ProseEntry[]     // interleaved records and pass-through blocks
}

interface ProseEntry {
  type: "record" | "passthrough"
  // record: parsed field values + overflow
  // passthrough: raw text lines (preserved verbatim)
}
```

**For ProseQL integration:** The persistence layer passes raw record arrays to `encode`. Preamble and pass-through text from a previous `decode` would need to be carried through. Two approaches:
- **v1 (simple):** Pass-through text is lost on re-encode. The encoder writes clean output: preamble (if configured), directive, records. Acceptable because ProseQL re-encodes on every mutation.
- **v2 (future):** The codec maintains an internal decode cache keyed by record IDs, preserving pass-through text positions across round-trips.

Decision: **v1 for initial implementation.** Pass-through text survives `decode` but not ProseQL mutation cycles. This matches JSONC/JSON5 behavior (comments aren't preserved through programmatic edits). Files used as embeddable documents (e.g., markdown with `@prose`) should be treated as read-mostly when managed by ProseQL.

### 6. Overflow field parsing

Overflow template lines use the same segment-based parsing as the headline. The decoder tries each overflow template in order against indented lines:

```
For each indented line in a record:
  1. Try matching against next expected overflow template
  2. Match → capture fields, advance to next template
  3. No match → try next template (skip = null)
  4. No template matches → continuation of last captured field
```

Continuation lines (deeper indentation than overflow template level) are concatenated to the previous field's value with a newline separator.

### 7. Value serialization

The encoder/decoder handles value types without schema awareness:

| Type | Encode | Decode heuristic |
|------|--------|-----------------|
| string | bare or `"quoted"` | default (anything not matching below) |
| number | digit characters | matches `/^-?\d+(\.\d+)?$/` |
| boolean | `true` / `false` | exact match |
| null | `~` | exact match |
| array | `[a, b, c]` | starts with `[`, ends with `]` |

Array elements follow the same quoting rules: elements containing `,` or `]` are double-quoted.

**Important:** This heuristic-based decoding means a string value `"true"` decodes as boolean `true`. This is acceptable because ProseQL's schema validation layer will coerce/reject values based on the declared schema. The codec's job is best-effort parsing, not type enforcement.

### 8. Data contract with ProseQL

`encode(data: unknown)` expects `data` to be an array of flat record objects. `decode(raw: string)` returns an array of flat record objects. This matches all existing codecs.

The template header is written/read by the codec internally — it's a file-format concern, invisible to the ProseQL persistence layer.

## Risks / Trade-offs

**[Ambiguous field boundaries]** → The quoting rule handles delimiter collisions. Edge case: a literal delimiter that is a single common character (e.g., space). Mitigation: template design is the user's responsibility; documentation should recommend distinctive delimiters.

**[Extension-based dispatch limits one template per project]** → If books.prose and users.prose need different templates, the registry can only bind one prose codec to the `.prose` extension. Mitigation: v1 targets single-template use cases. Per-collection codec config could be added to the persistence layer later as a separate change.

**[Pass-through text loss on mutation]** → ProseQL re-serializes the full collection on every write. Preamble and pass-through text (markdown headings, narrative prose between records) won't survive ProseQL mutation cycles. Mitigation: documented limitation. Embedded-in-markdown use cases should be treated as read-mostly when managed by ProseQL.

**[Host format collision]** → When embedded in `.md` files, the `@prose` directive and record lines become part of the markdown source. A record starting with `#` could render as a markdown heading. Mitigation: this is a feature, not a bug — the records deliberately look like content in the host format. Users choose templates that read naturally in their host context.

**[Heuristic type decoding]** → `"42"` decodes as number `42`, not string `"42"`. Mitigation: ProseQL's schema layer validates and coerces. Document that the codec returns best-guess types.

## Open Questions

- Should `proseCodec()` accept an `id` option to name the ID field (default `"id"`) so the `#` prefix in templates has semantic meaning, or is `#` purely a visual convention with no codec-level significance?
- Should the codec validate that the constructor template matches the file's `@prose` header on decode, or silently use the file's template?
