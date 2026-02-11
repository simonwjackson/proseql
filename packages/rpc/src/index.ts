/**
 * proseql-rpc — Type-safe Effect RPC layer for proseql databases.
 *
 * Derives an RpcGroup from a proseql DatabaseConfig, exposing all CRUD
 * operations and queries as typed RPC procedures. The client gets full
 * type inference including entity types, error channels, and relationship
 * population — no schema duplication required.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect"
 * import { Rpc, RpcGroup } from "@effect/rpc"
 * import { createEffectDatabase } from "proseql"
 * import { makeRpcGroup, makeRpcHandlers } from "proseql-rpc"
 *
 * // 1. Derive RPC group from your database config
 * const BooksRpc = makeRpcGroup(config)
 *
 * // 2. Create handler layer (wires RPCs to a live database)
 * const HandlerLayer = makeRpcHandlers(config, initialData)
 *
 * // 3. Client gets full type safety
 * const result = yield* client.books.query({ where: { year: { $gt: 2000 } } })
 * //    ^? ReadonlyArray<Book>
 * ```
 *
 * @module
 */

export {}
