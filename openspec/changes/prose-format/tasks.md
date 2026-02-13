## 1. Template Compiler

- [x] 1.1 Create `packages/core/src/serializers/codecs/prose.ts` with types: `ProseSegment` (field | literal), `CompiledTemplate`, `ProseCodecOptions`
- [x] 1.2 Implement `compileTemplate(template: string): CompiledTemplate` — parse `{fieldName}` placeholders and literal text into an ordered segment list
- [x] 1.3 Validate template at compile time: reject adjacent fields with no literal separator, reject empty field names, reject unclosed `{`
- [x] 1.4 Implement overflow template compilation — compile each overflow template string into its own `CompiledTemplate`
- [x] 1.5 Write tests for template compilation: simple template, leading literal, trailing literal, adjacent fields error, unclosed brace error

## 2. Value Serialization

- [x] 2.1 Implement `serializeValue(value: unknown): string` — numbers as digits, booleans as `true`/`false`, null as `~`, arrays as `[a, b, c]`, strings as bare text
- [x] 2.2 Implement array element quoting — elements containing `,` or `]` are double-quoted with `\"` escaping
- [x] 2.3 Implement `deserializeValue(text: string): unknown` — heuristic type detection: number regex, boolean exact match, `~` as null, `[...]` as array, default to string
- [x] 2.4 Implement array element parsing — split on `,` respecting quoted elements
- [ ] 2.5 Write tests for value round-trips: numbers, booleans, null, strings, arrays, arrays with commas, edge cases (empty string, empty array, negative numbers, floats)

## 3. Headline Encoder

- [ ] 3.1 Implement `encodeHeadline(record: Record<string, unknown>, template: CompiledTemplate): string` — substitute field values into template, emit literals verbatim
- [ ] 3.2 Implement quoting logic — for each non-last field, check if serialized value contains the next literal delimiter; if so, wrap in `"..."` with `\"` escaping
- [ ] 3.3 Write tests for headline encoding: flat record, null field, value needing quoting, last field not quoted

## 4. Headline Decoder

- [ ] 4.1 Implement `decodeHeadline(line: string, template: CompiledTemplate): Record<string, unknown> | null` — left-to-right scanner matching literals, capturing field text between them, returning null on non-match
- [ ] 4.2 Implement quoted value detection in scanner — if field text starts with `"`, scan for closing `"` respecting `\"` escapes
- [ ] 4.3 Implement greedy last field — capture to end of line
- [ ] 4.4 Write tests for headline decoding: matching line, non-matching line returns null, quoted fields, escaped quotes, greedy last field

## 5. Overflow Encoder

- [ ] 5.1 Implement overflow encoding — for each overflow template, if the record has a non-null value for the field, emit the indented overflow line using the template
- [ ] 5.2 Implement multi-line value encoding — if a field value contains newlines, emit the first line on the template line and subsequent lines as deeper-indented continuation lines
- [ ] 5.3 Write tests for overflow encoding: single overflow field, multiple overflow fields, null overflow omitted, multi-line value continuation

## 6. Overflow Decoder

- [ ] 6.1 Implement overflow decoding — collect indented lines for a record, try each overflow template in order, skip on non-match, capture on match
- [ ] 6.2 Implement multi-line continuation — lines indented deeper than overflow template level are concatenated to the previous field with newline separator
- [ ] 6.3 Write tests for overflow decoding: fields in order, skipped field is null, no overflow lines, multi-line continuation, continuation line that looks like a template but is deeper-indented

## 7. Directive Scanner and Document Parser

- [ ] 7.1 Implement `scanDirective(lines: string[]): { preambleEnd: number, directiveStart: number }` — scan for `@prose ` line, error if not found or if multiple found
- [ ] 7.2 Implement directive block parsing — extract headline template and overflow templates (indented lines immediately after `@prose`)
- [ ] 7.3 Implement body parsing — iterate lines after directive block, classify each as record headline (matches template), indented overflow/continuation (part of current record), or pass-through text
- [ ] 7.4 Write tests for directive scanning: first line, mid-file, missing directive error, multiple directives error, preamble preservation

## 8. Full Codec (encode + decode)

- [ ] 8.1 Implement `proseCodec(options: ProseCodecOptions): FormatCodec` factory — compile templates at construction, return `{ name, extensions, encode, decode }`
- [ ] 8.2 Implement `encode(data: unknown): string` — write `@prose` directive, overflow declarations, blank line, then encode each record (headline + overflow lines)
- [ ] 8.3 Implement `decode(raw: string): unknown` — scan directive, parse body into records, return array of record objects
- [ ] 8.4 Write round-trip tests: flat records, records with overflow, records with quoting, empty collection, mixed pass-through text

## 9. Integration and Export

- [ ] 9.1 Export `proseCodec` from `packages/core/src/serializers/codecs/prose.ts`
- [ ] 9.2 Add `proseCodec` export to `packages/core/src/index.ts`
- [ ] 9.3 Write integration test: create a `makeSerializerLayer` with `proseCodec`, serialize and deserialize through the registry
- [ ] 9.4 Write integration test: prose codec alongside other codecs in the same registry (no extension conflicts)
