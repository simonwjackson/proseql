# Full-Text Search -- Design

## Architecture

### New Modules

**`core/operations/query/search.ts`** -- Core search logic: `tokenize(text)` for splitting text into normalized tokens, `computeSearchScore(entity, queryTokens, fields)` for relevance scoring, `matchesSearch(fieldValue, searchTerms)` for field-level matching. All functions are pure and stateless.

**`core/types/search-types.ts`** -- `SearchConfig` (multi-field search descriptor), `SearchScore` (per-entity relevance score), `SearchIndexMap` (inverted index type alias: `Map<string, Set<string>>`), `SearchIndexConfig` (fields to index), and stop word list.

**`core/indexes/search-index.ts`** -- Search index construction and maintenance: `buildSearchIndex(fields, entities)`, `addToSearchIndex(index, entity, fields)`, `removeFromSearchIndex(index, entity, fields)`, `updateInSearchIndex(index, oldEntity, newEntity, fields)`, `lookupSearchIndex(index, queryTokens)`. Follows the same Ref-based pattern as `index-manager.ts`.

### Modified Modules

**`core/types/operators.ts`** -- `matchesFilter` gains a `$search` branch: when the operator is present on a string value, tokenize both the field value and the search string, then check that every query token matches at least one field token (exact or prefix). Returns boolean.

**`core/types/types.ts`** -- `FilterOperators<string>` extended with optional `$search: string`. `WhereClause` extended with optional top-level `$search: SearchConfig`. `CollectionConfig` extended with optional `searchIndex: ReadonlyArray<string>`.

**`core/operations/query/filter.ts`** -- `filterData` extended to handle top-level `$search` key: tokenize the query, iterate specified (or all string) fields, compute match. Entities that match zero query tokens are excluded. When a search index is available, use it to narrow candidates before field-level filtering.

**`core/operations/query/sort.ts`** -- When `$search` is active and no explicit `sort` is provided, inject relevance-based sorting. The relevance scores are computed during filtering and attached as metadata, then consumed by the sort stage.

**`core/factories/database-effect.ts`** -- `buildCollection` initializes the search index Ref (if configured), wires search index maintenance into create/update/delete paths, and passes the search index to the query pipeline.

## Key Decisions

### Tokenization: whitespace + punctuation strip + lowercase

Tokenization splits on whitespace, strips leading/trailing punctuation characters, and lowercases all tokens. No stemming, no lemmatization, no linguistic analysis. This is deliberately simple:

```typescript
function tokenize(text: string): ReadonlyArray<string> {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter(t => t.length > 0)
}
```

"Gibson, William" becomes `["gibson", "william"]`. "The Left Hand of Darkness" becomes `["the", "left", "hand", "of", "darkness"]` (stop words optionally filtered in a second pass). This handles the target use case (searching through plain text file data) without introducing NLP dependencies.

### Relevance scoring: TF-based

Scoring uses three factors combined multiplicatively:

1. **Term frequency (TF)**: How many times query tokens appear in the field value. More occurrences = higher score.
2. **Field length normalization**: Shorter fields score higher for the same match (matching "Dune" in a title is more relevant than matching "Dune" buried in a 500-word description).
3. **Term coverage**: Fraction of query tokens that matched. All terms matching scores higher than partial matches.

No IDF (inverse document frequency) -- computing IDF requires a collection-wide pass, which adds complexity for marginal benefit at this scale. TF + coverage + field length is sufficient for ranking hundreds to tens of thousands of records.

```typescript
// Pseudocode
score = matchedTermCount / queryTermCount           // coverage: 0..1
     * (1 + termFrequencySum / fieldTokenCount)     // TF boost
     * (1 / Math.log(1 + fieldTokenCount))          // length normalization
```

### Inverted index: Map<token, Set<id>>

The search index is a simple inverted index stored as `Map<string, Set<string>>` wrapped in a `Ref`, following the exact same pattern as the existing equality indexes in `index-manager.ts`:

```typescript
// "dune" -> Set(["book-1", "book-7"])
// "gibson" -> Set(["book-3"])
// "left" -> Set(["book-2"])
```

Index lookup for a multi-token query intersects the ID sets across tokens (AND semantics), then falls back to union for prefix matches. This narrows the candidate set before full scoring.

### $search composes with existing filter operators

`$search` is just another operator in the `where` clause. At the field level, it sits alongside `$eq`, `$contains`, `$startsWith`, etc. on `FilterOperators<string>`. At the top level, it sits alongside `$and`, `$or`, `$not`. The filter pipeline evaluates all operators with AND semantics -- an entity must satisfy both the `$search` and any other conditions:

```typescript
// Field-level: $search alongside other operators
where: { title: { $search: "dark" }, year: { $gt: 1960 } }

// Top-level multi-field: $search alongside field filters
where: { $search: { query: "herbert dune", fields: ["title", "author"] }, year: { $gt: 1960 } }

// Inside logical operators
where: { $or: [{ title: { $search: "dark" } }, { author: { $search: "gibson" } }] }
```

No special composition logic is needed. The existing `filterData` recursion through `$and`, `$or`, `$not` handles `$search` transparently because it delegates to `matchesFilter` for field-level checks.

### Prefix matching via token startsWith

Prefix matching allows "neuro" to match "neuromancer". Implementation: for each query token, check if any field token starts with the query token. This is a simple `fieldToken.startsWith(queryToken)` check during matching:

```typescript
const matches = queryTokens.every(qt =>
  fieldTokens.some(ft => ft === qt || ft.startsWith(qt))
)
```

Prefix matches score slightly lower than exact matches to preserve ranking quality. This approach is O(q * f) per field where q is query tokens and f is field tokens -- acceptable for the target scale.

## File Layout

```
core/
  types/
    search-types.ts          (new -- SearchConfig, SearchScore, SearchIndexMap, stop words)
    operators.ts             (modified -- $search branch in matchesFilter)
    types.ts                 (modified -- FilterOperators gains $search, WhereClause gains top-level $search, CollectionConfig gains searchIndex)
  operations/
    query/
      search.ts              (new -- tokenize, computeSearchScore, matchesSearch)
      filter.ts              (modified -- top-level $search handling in filterData)
      sort.ts                (modified -- relevance-based default sort when search active)
  indexes/
    search-index.ts          (new -- build, add, remove, update, lookup for search index)
  factories/
    database-effect.ts       (modified -- search index init, CRUD maintenance, query wiring)
tests/
  full-text-search.test.ts   (new -- full test suite)
```
