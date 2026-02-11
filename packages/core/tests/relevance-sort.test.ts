import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { createEffectDatabase } from "../src/index.js"

const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
})

describe("Relevance sort for $search", () => {
  it("6.1: sorts by relevance when $search is active and no explicit sort", async () => {
    const db = await Effect.runPromise(createEffectDatabase({
      books: { schema: BookSchema, relationships: {} },
    }, {
      books: [
        { id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
        { id: "2", title: "Dark Matters", author: "John Smith", year: 2000 }, // "dark" only in title
        { id: "3", title: "The Left Hand of Darkness", author: "Dark Author", year: 1969 }, // "dark" in both
      ],
    }))

    // Search for "dark" - entity 3 should rank higher (matches in both title and author)
    const result = await db.books.query({
      where: { $search: { query: "dark" } }
    }).runPromise

    // Should return both matching books
    expect(result.length).toBe(2)

    // Entity 3 should be first (matches in both title and author = higher score)
    expect(result[0].id).toBe("3")
    expect(result[1].id).toBe("2")
  })

  it("6.3: explicit sort overrides relevance sort", async () => {
    const db = await Effect.runPromise(createEffectDatabase({
      books: { schema: BookSchema, relationships: {} },
    }, {
      books: [
        { id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
        { id: "2", title: "Dark Matters", author: "John Smith", year: 2000 },
        { id: "3", title: "The Left Hand of Darkness", author: "Dark Author", year: 1969 },
      ],
    }))

    // Search for "dark" with explicit sort by year
    const result = await db.books.query({
      where: { $search: { query: "dark" } },
      sort: { year: "asc" }
    }).runPromise

    // Should return both matching books
    expect(result.length).toBe(2)

    // When explicit sort provided, results should be sorted by year, not relevance
    expect(result[0].year).toBe(1969) // Left Hand of Darkness
    expect(result[1].year).toBe(2000) // Dark Matters
  })

  it("6.1: handles empty query gracefully", async () => {
    const db = await Effect.runPromise(createEffectDatabase({
      books: { schema: BookSchema, relationships: {} },
    }, {
      books: [
        { id: "1", title: "Dune", author: "Frank Herbert", year: 1965 },
        { id: "2", title: "Dark Matters", author: "John Smith", year: 2000 },
      ],
    }))

    // Empty query should match all
    const result = await db.books.query({
      where: { $search: { query: "" } }
    }).runPromise

    expect(result.length).toBe(2)
  })
})
