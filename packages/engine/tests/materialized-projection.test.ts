import { describe, expect, it } from "vitest";
import {
	MaterializedProjection,
	StaleMaterializedHandleError,
} from "../src/materialized-projection.js";

describe("materialized projection", () => {
	it("bootstraps metadata sparsely and materializes first-inline then handle-only", () => {
		const alice = {
			id: "u1",
			missingMarker: undefined,
			nullable: null,
			negativeZero: -0,
			unicode: "雪🚀",
			sentinel: { __proseql_boundary_value__: "undefined" },
		};
		const projection = new MaterializedProjection({
			collections: { users: [{ id: "u1", handle: "0:1:1" }] },
		});
		expect(projection.stats.materializedRows).toBe(0);
		expect(projection.stats.trackedProxies).toBe(0);

		const first = projection.materialize<typeof alice>(
			"users",
			{
				kind: "materializedOne",
				row: { id: "u1", handle: "0:1:1", value: alice },
			},
			100,
		);
		const second = projection.materialize<ReadonlyArray<typeof alice>>(
			"users",
			{ kind: "materializedMany", rows: [{ id: "u1", handle: "0:1:1" }] },
			24,
		)[0];
		expect(second).toBe(first);
		expect(first).toEqual(alice);
		expect(Object.is(first.negativeZero, -0)).toBe(true);
		expect(projection.stats.cacheHits).toBe(1);
		expect(projection.stats.cacheMisses).toBe(1);
		expect(projection.stats.materializedRows).toBe(1);
		expect(projection.stats.fullValueBytesAvoided).toBeGreaterThan(0);
	});

	it("keeps a 10K bootstrap free of values and proxies", () => {
		const projection = new MaterializedProjection({
			collections: {
				users: Array.from({ length: 10_000 }, (_, index) => ({
					id: `u${index}`,
					handle: `${index}:1:1`,
				})),
			},
		});
		expect(projection.stats.materializedRows).toBe(0);
		expect(projection.stats.trackedProxies).toBe(0);
		expect(projection.dirtyRows).toEqual([]);
	});

	it("keeps live large-result identities through weak projection slots", () => {
		const rows = Array.from({ length: 1_000 }, (_, index) => ({
			id: `u${index}`,
			handle: `${index}:1:1`,
		}));
		const projection = new MaterializedProjection({
			collections: { users: rows },
		});
		const result = projection.materialize<ReadonlyArray<{ id: string }>>(
			"users",
			{
				kind: "materializedMany",
				rows: rows.map((row) => ({ ...row, value: { id: row.id } })),
			},
			1,
		);
		expect(result).toHaveLength(1_000);
		expect(projection.stats.materializedRows).toBe(1_000);
		expect(projection.stats.peakMaterializedRows).toBe(1_000);
		expect(
			projection.materialize(
				"users",
				{ kind: "materializedOne", row: { id: "u0", handle: "0:1:1" } },
				1,
			),
		).toBe(result[0]);
	});

	it("tracks deep sets, deletes, definitions, and array holes without replacing identity", () => {
		const value = { id: "u1", nested: { name: "Alice" }, values: [1, 2, 3] };
		const projection = new MaterializedProjection({
			collections: { users: [{ id: "u1", handle: "0:1:1" }] },
		});
		const row = projection.materialize<{
			id: string;
			nested: { name: string };
			values: number[];
			extra?: null;
		}>(
			"users",
			{
				kind: "materializedOne",
				row: { id: "u1", handle: "0:1:1", value },
			},
			1,
		);
		row.nested.name = "Changed";
		delete row.values[1];
		Object.defineProperty(row, "extra", { value: null, enumerable: true });
		const dirty = projection.dirtyRows;
		expect(dirty).toHaveLength(1);
		expect(dirty[0]?.value).toBe(row);
		expect(1 in row.values).toBe(false);
		projection.markSynchronized(dirty);
		expect(projection.dirtyRows).toHaveLength(0);
		expect(
			projection.materialize(
				"users",
				{ kind: "materializedOne", row: { id: "u1", handle: "0:1:1" } },
				1,
			),
		).toBe(row);
	});

	it("detaches replaced caller objects from later dirty synchronization", () => {
		const projection = new MaterializedProjection({
			collections: { users: [{ id: "u1", handle: "0:1:1" }] },
		});
		const old = projection.materialize<{ name: string }>(
			"users",
			{
				kind: "materializedOne",
				row: {
					id: "u1",
					handle: "0:1:1",
					value: { id: "u1", name: "Alice" },
				},
			},
			1,
		);
		projection.apply({
			changes: [
				{
					collection: "users",
					id: "u1",
					handle: "0:1:2",
					value: { id: "u1", name: "Updated" },
				},
			],
		});
		old.name = "Detached";
		expect(projection.dirtyRows).toEqual([]);
	});

	it("keeps unobserved mutation deltas metadata-only", () => {
		const projection = new MaterializedProjection({
			collections: { users: [{ id: "u1", handle: "0:1:1" }] },
		});
		projection.apply({
			changes: [{ collection: "users", id: "u1", handle: "0:1:2" }],
		});
		expect(projection.stats.materializedRows).toBe(0);
		expect(() =>
			projection.materialize(
				"users",
				{ kind: "materializedOne", row: { id: "u1", handle: "0:1:2" } },
				1,
			),
		).toThrow(StaleMaterializedHandleError);
	});

	it("invalidates atomically on stale generation reuse and accepts sparse resync", () => {
		const projection = new MaterializedProjection({
			collections: { users: [{ id: "u1", handle: "0:1:1" }] },
		});
		projection.apply({
			changes: [
				{ collection: "users", id: "u1", handle: "0:1:1", deleted: true },
			],
		});
		expect(() =>
			projection.materialize(
				"users",
				{ kind: "materializedOne", row: { id: "u1", handle: "0:1:1" } },
				10,
			),
		).toThrow(StaleMaterializedHandleError);
		expect(projection.needsResynchronization).toBe(true);

		projection.resynchronize({
			collections: { users: [{ id: "u1", handle: "0:2:1" }] },
		});
		expect(
			projection.materialize<{ readonly name: string }>(
				"users",
				{
					kind: "materializedOne",
					row: {
						id: "u1",
						handle: "0:2:1",
						value: { id: "u1", name: "Recreated" },
					},
				},
				10,
			).name,
		).toBe("Recreated");
		expect(projection.stats.resynchronizations).toBe(1);
	});
});
