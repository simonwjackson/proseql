/**
 * Tool dispatch: routes tool calls to the appropriate database operations.
 */

import type { DatabaseConfig } from "@proseql/core";
import { describeConfig } from "./introspect.js";

type AnyDb = Record<
	string,
	{
		query: (options?: Record<string, unknown>) => {
			runPromise: Promise<ReadonlyArray<unknown>>;
		};
		findById: (id: string) => { runPromise: Promise<unknown> };
		create: (data: Record<string, unknown>) => { runPromise: Promise<unknown> };
		update: (
			id: string,
			data: Record<string, unknown>,
		) => { runPromise: Promise<unknown> };
		delete: (id: string) => { runPromise: Promise<unknown> };
	}
>;

function getCollection(db: AnyDb, collection: string) {
	const col = db[collection];
	if (!col) {
		throw new Error(`Unknown collection: ${collection}`);
	}
	return col;
}

export type ToolExecutor = (
	toolName: string,
	args: Record<string, unknown>,
) => Promise<string>;

export function makeExecutor(
	db: AnyDb,
	config: DatabaseConfig,
	opts: { readOnly: boolean },
): ToolExecutor {
	return async (toolName: string, args: Record<string, unknown>) => {
		try {
			switch (toolName) {
				case "proseql_describe": {
					const description = describeConfig(config);
					return JSON.stringify(description);
				}

				case "proseql_query": {
					const collection = args.collection as string;
					const col = getCollection(db, collection);
					const queryOpts: Record<string, unknown> = {};
					if (args.where) queryOpts.where = args.where;
					if (args.sort) queryOpts.sort = args.sort;
					if (args.select) queryOpts.select = args.select;
					if (args.limit !== undefined) queryOpts.limit = args.limit;
					if (args.offset !== undefined) queryOpts.offset = args.offset;

					// Default limit to 50 to prevent unbounded queries
					if (queryOpts.limit === undefined) queryOpts.limit = 50;

					const results = await col.query(queryOpts).runPromise;
					return JSON.stringify(results);
				}

				case "proseql_find_by_id": {
					const collection = args.collection as string;
					const id = args.id as string;
					const col = getCollection(db, collection);
					const result = await col.findById(id).runPromise;
					return JSON.stringify(result);
				}

				case "proseql_create": {
					if (opts.readOnly) {
						return JSON.stringify({
							error: "Write operations are not available in read-only mode",
						});
					}
					const collection = args.collection as string;
					const data = args.data as Record<string, unknown>;
					const col = getCollection(db, collection);
					const result = await col.create(data).runPromise;
					return JSON.stringify(result);
				}

				case "proseql_update": {
					if (opts.readOnly) {
						return JSON.stringify({
							error: "Write operations are not available in read-only mode",
						});
					}
					const collection = args.collection as string;
					const id = args.id as string;
					const data = args.data as Record<string, unknown>;
					const col = getCollection(db, collection);
					const result = await col.update(id, data).runPromise;
					return JSON.stringify(result);
				}

				case "proseql_delete": {
					if (opts.readOnly) {
						return JSON.stringify({
							error: "Write operations are not available in read-only mode",
						});
					}
					const collection = args.collection as string;
					const id = args.id as string;
					const col = getCollection(db, collection);
					const result = await col.delete(id).runPromise;
					return JSON.stringify(result);
				}

				default:
					return JSON.stringify({ error: `Unknown tool: ${toolName}` });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return JSON.stringify({ error: message });
		}
	};
}
