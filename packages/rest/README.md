# @proseql/rest

Framework-agnostic REST API handlers for ProseQL databases. Generate HTTP endpoints for CRUD, queries, and aggregations from your database config.

## Install

```sh
npm install @proseql/rest
```

## Quick Start

```ts
import { Effect, Schema } from "effect"
import { createEffectDatabase } from "@proseql/core"
import { createRestHandlers } from "@proseql/rest"

const BookSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  author: Schema.String,
  year: Schema.Number,
})

const config = {
  books: {
    schema: BookSchema,
    relationships: {},
  },
} as const

const program = Effect.gen(function* () {
  const db = yield* createEffectDatabase(config, {
    books: [{ id: "1", title: "Dune", author: "Frank Herbert", year: 1965 }],
  })

  const routes = createRestHandlers(config, db)

  // routes is an array of { method, path, handler }
  // Adapt to your framework of choice
})

await Effect.runPromise(program)
```

For the full query and mutation API, see [`@proseql/core`](https://www.npmjs.com/package/@proseql/core).

## Handler Generation

`createRestHandlers` generates framework-agnostic route descriptors for all collections in your database config.

```ts
import { createRestHandlers } from "@proseql/rest"

const routes = createRestHandlers(config, db)
// routes: ReadonlyArray<RouteDescriptor>
```

Each route descriptor contains:

```ts
interface RouteDescriptor {
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
  readonly path: string
  readonly handler: RestHandler
}
```

### Generated Routes

For each collection, the following routes are generated:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:collection` | Query with filters, sort, pagination |
| `GET` | `/:collection/:id` | Find entity by ID |
| `POST` | `/:collection` | Create entity |
| `PUT` | `/:collection/:id` | Update entity |
| `DELETE` | `/:collection/:id` | Delete entity |
| `POST` | `/:collection/batch` | Create multiple entities |
| `GET` | `/:collection/aggregate` | Aggregation queries |

For a database with `books` and `authors` collections, this generates:

```
GET    /books
GET    /books/:id
POST   /books
PUT    /books/:id
DELETE /books/:id
POST   /books/batch
GET    /books/aggregate

GET    /authors
GET    /authors/:id
POST   /authors
PUT    /authors/:id
DELETE /authors/:id
POST   /authors/batch
GET    /authors/aggregate
```

## Request and Response Types

Handlers use framework-agnostic request/response types.

```ts
interface RestRequest {
  readonly params: Record<string, string>          // URL path params
  readonly query: Record<string, string | string[]> // Query string params
  readonly body: unknown                            // Parsed JSON body
}

interface RestResponse {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
}

type RestHandler = (req: RestRequest) => Promise<RestResponse>
```

## Query Parameter Parsing

Use `parseQueryParams` to convert URL query strings into ProseQL query configurations.

```ts
import { parseQueryParams } from "@proseql/rest"

// Simple equality
parseQueryParams({ genre: "sci-fi" })
// → { where: { genre: "sci-fi" } }

// Operator syntax
parseQueryParams({ "year[$gte]": "1970", "year[$lt]": "2000" })
// → { where: { year: { $gte: 1970, $lt: 2000 } } }

// Sorting
parseQueryParams({ sort: "year:desc,title:asc" })
// → { sort: { year: "desc", title: "asc" } }

// Pagination
parseQueryParams({ limit: "10", offset: "20" })
// → { limit: 10, offset: 20 }

// Field selection
parseQueryParams({ select: "title,year" })
// → { select: ["title", "year"] }

// Combined
parseQueryParams({
  genre: "sci-fi",
  "year[$gte]": "1970",
  sort: "year:desc",
  limit: "10",
  select: "title,year"
})
// → {
//     where: { genre: "sci-fi", year: { $gte: 1970 } },
//     sort: { year: "desc" },
//     limit: 10,
//     select: ["title", "year"]
//   }
```

### Supported Filter Operators

| URL Syntax | ProseQL Operator |
|------------|------------------|
| `field=value` | `{ field: value }` (equality) |
| `field[$eq]=value` | `{ field: { $eq: value } }` |
| `field[$ne]=value` | `{ field: { $ne: value } }` |
| `field[$gt]=value` | `{ field: { $gt: value } }` |
| `field[$gte]=value` | `{ field: { $gte: value } }` |
| `field[$lt]=value` | `{ field: { $lt: value } }` |
| `field[$lte]=value` | `{ field: { $lte: value } }` |
| `field[$in]=a,b,c` | `{ field: { $in: ["a", "b", "c"] } }` |
| `field[$nin]=a,b` | `{ field: { $nin: ["a", "b"] } }` |
| `field[$startsWith]=val` | `{ field: { $startsWith: "val" } }` |
| `field[$endsWith]=val` | `{ field: { $endsWith: "val" } }` |
| `field[$contains]=val` | `{ field: { $contains: "val" } }` |
| `field[$search]=term` | `{ field: { $search: "term" } }` |
| `field[$all]=a,b` | `{ field: { $all: ["a", "b"] } }` |
| `field[$size]=3` | `{ field: { $size: 3 } }` |

Type coercion is applied automatically:
- Numeric strings become numbers for numeric operators
- `"true"` and `"false"` become booleans
- Comma-separated values in `$in`/`$nin`/`$all` become arrays

## Aggregate Parameter Parsing

Use `parseAggregateParams` for aggregation endpoint query strings.

```ts
import { parseAggregateParams } from "@proseql/rest"

// Simple count
parseAggregateParams({ count: "true" })
// → { count: true }

// Count with filter
parseAggregateParams({ count: "true", genre: "sci-fi" })
// → { count: true, where: { genre: "sci-fi" } }

// Grouped aggregate
parseAggregateParams({ count: "true", groupBy: "genre" })
// → { count: true, groupBy: "genre" }

// Multiple aggregations
parseAggregateParams({
  count: "true",
  sum: "pages",
  avg: "rating",
  groupBy: "genre"
})
// → { count: true, sum: "pages", avg: "rating", groupBy: "genre" }
```

### Aggregate Query Parameters

| Parameter | Description |
|-----------|-------------|
| `count=true` | Count entities |
| `sum=field` | Sum a numeric field |
| `avg=field` | Average a numeric field |
| `min=field` | Find minimum value |
| `max=field` | Find maximum value |
| `groupBy=field` | Group results by field |
| `sum=a,b` | Sum multiple fields |
| `groupBy=a,b` | Group by multiple fields |

Filter parameters (same syntax as query endpoint) are also supported for filtered aggregation.

## Error Mapping

Use `mapErrorToResponse` to convert ProseQL errors to HTTP responses.

```ts
import { mapErrorToResponse } from "@proseql/rest"

try {
  await db.books.findById("nonexistent").runPromise
} catch (error) {
  const response = mapErrorToResponse(error)
  // response = {
  //   status: 404,
  //   body: {
  //     _tag: "NotFoundError",
  //     error: "Not found",
  //     details: { collection: "books", id: "nonexistent" }
  //   }
  // }
}
```

### Error Status Codes

| Error | Status | Description |
|-------|--------|-------------|
| `NotFoundError` | 404 | Entity doesn't exist |
| `ValidationError` | 400 | Invalid input data |
| `DuplicateKeyError` | 409 | ID already taken |
| `UniqueConstraintError` | 409 | Unique field collision |
| `ForeignKeyError` | 422 | Referenced entity doesn't exist |
| `HookError` | 422 | Lifecycle hook rejected |
| `OperationError` | 400 | Invalid operation (e.g., update on append-only) |
| `ConcurrencyError` | 409 | Concurrent modification conflict |
| `CollectionNotFoundError` | 404 | Collection doesn't exist |
| `PopulationError` | 422 | Relationship population failed |
| `DanglingReferenceError` | 422 | Dangling reference |
| `StorageError` | 500 | Storage adapter error |
| `SerializationError` | 500 | Codec error |
| `UnsupportedFormatError` | 400 | Unsupported file format |
| `TransactionError` | 500 | Transaction error |
| `MigrationError` | 500 | Migration error |
| `PluginError` | 500 | Plugin error |

## Relationship Routes

Use `createRelationshipRoutes` to generate sub-routes for relationship navigation.

```ts
import { createRelationshipRoutes } from "@proseql/rest"

const config = {
  books: {
    schema: BookSchema,
    relationships: {
      author: { type: "ref" as const, target: "authors" as const, foreignKey: "authorId" },
    },
  },
  authors: {
    schema: AuthorSchema,
    relationships: {
      books: { type: "inverse" as const, target: "books" as const, foreignKey: "authorId" },
    },
  },
} as const

const relationshipRoutes = createRelationshipRoutes(config, db)
// Generates:
//   GET /books/:id/author  — returns the author of a book
//   GET /authors/:id/books — returns all books by an author
```

### Route Patterns

| Relationship Type | Pattern | Behavior |
|-------------------|---------|----------|
| `ref` | `GET /:collection/:id/:relationship` | Returns single related entity |
| `inverse` | `GET /:collection/:id/:relationship` | Returns array of related entities |

Use `extractRelationships` to inspect relationships in your config:

```ts
import { extractRelationships } from "@proseql/rest"

const relationships = extractRelationships(config)
// [
//   { sourceCollection: "books", relationshipName: "author", relationship: { type: "ref", ... } },
//   { sourceCollection: "authors", relationshipName: "books", relationship: { type: "inverse", ... } }
// ]
```

## Framework Integration

### Express

```ts
import express from "express"
import { createRestHandlers, createRelationshipRoutes } from "@proseql/rest"

const app = express()
app.use(express.json())

const routes = [
  ...createRestHandlers(config, db),
  ...createRelationshipRoutes(config, db),
]

for (const { method, path, handler } of routes) {
  app[method.toLowerCase() as "get" | "post" | "put" | "delete"](
    path,
    async (req, res) => {
      const response = await handler({
        params: req.params,
        query: req.query as Record<string, string | string[]>,
        body: req.body,
      })
      res.status(response.status).json(response.body)
    }
  )
}

app.listen(3000)
```

### Hono

```ts
import { Hono } from "hono"
import { createRestHandlers, createRelationshipRoutes } from "@proseql/rest"

const app = new Hono()

const routes = [
  ...createRestHandlers(config, db),
  ...createRelationshipRoutes(config, db),
]

for (const { method, path, handler } of routes) {
  // Convert :param to Hono's :param syntax (same format)
  app[method.toLowerCase() as "get" | "post" | "put" | "delete"](
    path,
    async (c) => {
      const response = await handler({
        params: c.req.param(),
        query: c.req.query() as Record<string, string | string[]>,
        body: method === "GET" ? undefined : await c.req.json(),
      })
      return c.json(response.body, response.status as 200)
    }
  )
}

export default app
```

## API Reference

### Exports

| Export | Description |
|--------|-------------|
| `createRestHandlers` | Generate REST handlers for all collections |
| `createRelationshipRoutes` | Generate relationship sub-routes |
| `extractRelationships` | Inspect relationships in config |
| `parseQueryParams` | Parse URL query params for queries |
| `parseAggregateParams` | Parse URL query params for aggregation |
| `mapErrorToResponse` | Map ProseQL errors to HTTP responses |

### Types

| Type | Description |
|------|-------------|
| `RestHandler` | Handler function signature |
| `RestRequest` | Framework-agnostic request |
| `RestResponse` | Framework-agnostic response |
| `RouteDescriptor` | Route definition (method, path, handler) |
| `HttpMethod` | `"GET" \| "POST" \| "PUT" \| "DELETE" \| "PATCH"` |
| `ParsedQueryConfig` | Parsed query configuration |
| `ParsedAggregateConfig` | Parsed aggregate configuration |
| `QueryParams` | Input query parameter map |
| `ErrorResponse` | Error response structure |

## License

MIT
