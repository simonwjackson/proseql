## 1. Core README (parallel with Track B, C, D, E)

- [x] 1.1 Create `packages/core/README.md` with the full API documentation currently in root README. Cover: install, schema definition, CRUD (create/createMany/findById/update/upsert/updateMany/upsertMany/deleteMany/delete), update operators table, query filtering (all operators + logical), nested data (shape-mirroring + dot-notation), sorting, field selection, pagination (offset + cursor), aggregation (scalar + groupBy), full-text search ($search + searchIndex), computed fields, relationships (ref/inverse + populate), indexing (single/compound/nested), lifecycle hooks (before/after/onChange + rejection), schema migrations (chained transforms), transactions, unique constraints (single + compound), plugin system (operators + ID generators + codecs), error types table, ID generation utilities. All examples use `createEffectDatabase` (in-memory, no Node imports). Follow structure: name + description, install, quick start, API sections, license.

## 2. Node README (parallel with Track A, C, D, E)

- [x] 2.1 Create `packages/node/README.md` covering Node.js file persistence. Document three approaches: zero-config `createNodeDatabase`, explicit `makeNodePersistenceLayer`, manual `Layer.merge` with `NodeStorageLayer` + `makeSerializerLayer`. Include file format table (JSON/JSONL/YAML/JSON5/JSONC/TOML/TOON/Hjson/Prose with extensions), prose format (@prose directive, template-less codec, explicit template, format override), append-only JSONL (appendOnly config, OperationError on update/delete), debounced writes and `flush()`. Link to `@proseql/core` for query/mutation API. Follow consistent structure.

## 3. REST README (parallel with Track A, B, D, E)

- [x] 3.1 Create `packages/rest/README.md` documenting framework-agnostic REST handler generation. Cover `createRestHandlers(config, db)`, route table (GET/POST/PUT/DELETE per collection + batch + aggregate), `RestHandler`/`RestRequest`/`RestResponse` types, query parameter parsing (`parseQueryParams`/`parseAggregateParams` for filters, sort, pagination, select), error mapping (`mapErrorToResponse` with HTTP status codes), relationship routes (`createRelationshipRoutes`). Show Express/Hono integration example. Follow consistent structure.

## 4. RPC README (parallel with Track A, B, C, E)

- [x] 4.1 Create `packages/rpc/README.md` documenting Effect RPC integration. Cover `makeRpcGroup(config)` to derive typed RPC group from database config, `makeRpcHandlers`/`makeRpcHandlersFromDatabase` for handler layers, `RpcRouter` for routing, error schemas (all CRUD + query errors as RPC-safe schemas), payload schemas (FindById/Query/Create/Update/Delete/Upsert/Aggregate + Many variants + cursor pagination). Show end-to-end example: derive group → create handlers → type-safe client call. Follow consistent structure.

## 5. CLI README (parallel with Track A, B, C, D)

- [ ] 5.1 Create `packages/cli/README.md` documenting the command-line interface. Cover installation (`npx @proseql/cli` or global install), all commands: `init` (scaffold config), `query` (filter/sort/select), `create` (insert records), `update` (modify by ID), `delete` (remove by ID), `describe` (show collection schema), `collections` (list collections), `stats` (collection statistics), `convert` (format conversion between JSON/YAML/TOML/etc.), `migrate` (run schema migrations). Document output format flag (`--format json|table|yaml`), config discovery. Follow consistent structure.

## 6. Root README refactor (blocked by Track A + B)

- [ ] 6.1 Slim root `README.md` to a landing page. Keep: badges, project description ("A type-safe relational database that persists to plain text files"), the directory-tree ASCII art, a minimal quick-start example (createNodeDatabase, basic query, file mutation). Replace the full API docs with a packages table linking to each package README (core, node, browser, cli, rest, rpc). Keep the examples listing (updated to numbered prefixes). Remove all detailed API sections (CRUD, querying, aggregation, pagination, search, computed fields, relationships, indexing, hooks, migrations, transactions, unique constraints, plugins, errors, ID generation, persistence setup, format table, prose format, append-only). Keep license.

## 7. Verification (blocked by Track A + B + C + D + E + F)

- [ ] 7.1 Verify all READMEs exist and are well-formed: confirm `packages/{core,node,rest,rpc,cli}/README.md` all exist, `packages/browser/README.md` is unchanged, root README links resolve to real files, no broken internal references, all code examples use correct import paths. Run `just typecheck` and `just test` to confirm no regressions.
