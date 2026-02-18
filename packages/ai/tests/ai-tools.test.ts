import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { createEffectDatabase } from "@proseql/core";
import type { DatabaseConfig } from "@proseql/core";
import { makeReadOnlyTools, makeTools, describeConfig } from "../src/index.js";

const ProjectSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	status: Schema.String,
	priority: Schema.Number,
});

const TaskSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	projectId: Schema.String,
	done: Schema.Boolean,
});

const config = {
	projects: {
		schema: ProjectSchema,
		relationships: {
			tasks: {
				type: "inverse" as const,
				target: "tasks",
				foreignKey: "projectId",
			},
		},
		searchIndex: ["name"],
	},
	tasks: {
		schema: TaskSchema,
		relationships: {
			project: { type: "ref" as const, target: "projects" },
		},
	},
} satisfies DatabaseConfig;

const initialData = {
	projects: [
		{ id: "p1", name: "Alpha", status: "active", priority: 1 },
		{ id: "p2", name: "Beta", status: "archived", priority: 2 },
		{ id: "p3", name: "Gamma", status: "active", priority: 3 },
	],
	tasks: [
		{ id: "t1", title: "Setup CI", projectId: "p1", done: true },
		{ id: "t2", title: "Write tests", projectId: "p1", done: false },
		{ id: "t3", title: "Deploy", projectId: "p2", done: false },
	],
};

async function createTestDb() {
	return Effect.runPromise(createEffectDatabase(config, initialData));
}

describe("@proseql/ai", () => {
	describe("describeConfig", () => {
		it("should extract collection names and fields", () => {
			const description = describeConfig(config);

			expect(Object.keys(description.collections)).toEqual([
				"projects",
				"tasks",
			]);
			expect(description.collections.projects.fields).toEqual({
				id: "string",
				name: "string",
				status: "string",
				priority: "number",
			});
			expect(description.collections.tasks.fields).toEqual({
				id: "string",
				title: "string",
				projectId: "string",
				done: "boolean",
			});
		});

		it("should include relationships", () => {
			const description = describeConfig(config);

			expect(description.collections.projects.relationships).toEqual({
				tasks: {
					type: "inverse",
					target: "tasks",
					foreignKey: "projectId",
				},
			});
			expect(description.collections.tasks.relationships).toEqual({
				project: { type: "ref", target: "projects" },
			});
		});

		it("should include searchIndex", () => {
			const description = describeConfig(config);
			expect(description.collections.projects.searchIndex).toEqual(["name"]);
			expect(description.collections.tasks.searchIndex).toEqual([]);
		});

		it("should include operators by type", () => {
			const description = describeConfig(config);
			expect(description.operators.string).toContain("$eq");
			expect(description.operators.string).toContain("$contains");
			expect(description.operators.number).toContain("$gt");
			expect(description.operators.boolean).toContain("$eq");
			expect(description.operators.array).toContain("$all");
		});
	});

	describe("makeReadOnlyTools", () => {
		it("should provide 3 tool definitions", async () => {
			const db = await createTestDb();
			const toolkit = makeReadOnlyTools(db, config);

			expect(toolkit.definitions).toHaveLength(3);
			const names = toolkit.definitions.map((d) => d.name);
			expect(names).toContain("proseql_describe");
			expect(names).toContain("proseql_query");
			expect(names).toContain("proseql_find_by_id");
		});

		it("should not include write tools", async () => {
			const db = await createTestDb();
			const toolkit = makeReadOnlyTools(db, config);

			const names = toolkit.definitions.map((d) => d.name);
			expect(names).not.toContain("proseql_create");
			expect(names).not.toContain("proseql_update");
			expect(names).not.toContain("proseql_delete");
		});
	});

	describe("makeTools", () => {
		it("should provide 6 tool definitions", async () => {
			const db = await createTestDb();
			const toolkit = makeTools(db, config);

			expect(toolkit.definitions).toHaveLength(6);
			const names = toolkit.definitions.map((d) => d.name);
			expect(names).toContain("proseql_create");
			expect(names).toContain("proseql_update");
			expect(names).toContain("proseql_delete");
		});
	});

	describe("execute: proseql_describe", () => {
		it("should return schema description as JSON", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(await execute("proseql_describe", {}));
			expect(result.collections.projects.fields.name).toBe("string");
			expect(result.operators.string).toContain("$eq");
		});
	});

	describe("execute: proseql_query", () => {
		it("should query all records in a collection", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_query", { collection: "projects" }),
			);
			expect(result).toHaveLength(3);
		});

		it("should filter with where clause", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_query", {
					collection: "projects",
					where: { status: "active" },
				}),
			);
			expect(result).toHaveLength(2);
			expect(result.every((r: Record<string, unknown>) => r.status === "active")).toBe(true);
		});

		it("should support sort", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_query", {
					collection: "projects",
					sort: { priority: "desc" },
				}),
			);
			expect(result[0].priority).toBe(3);
			expect(result[2].priority).toBe(1);
		});

		it("should support limit and offset", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_query", {
					collection: "projects",
					sort: { priority: "asc" },
					limit: 2,
					offset: 0,
				}),
			);
			expect(result).toHaveLength(2);
		});

		it("should support select", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_query", {
					collection: "projects",
					select: ["name", "status"],
				}),
			);
			expect(result[0]).toHaveProperty("name");
			expect(result[0]).toHaveProperty("status");
			expect(result[0]).not.toHaveProperty("priority");
		});

		it("should return error for unknown collection", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_query", { collection: "nonexistent" }),
			);
			expect(result.error).toBeDefined();
		});
	});

	describe("execute: proseql_find_by_id", () => {
		it("should find a record by id", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_find_by_id", {
					collection: "projects",
					id: "p1",
				}),
			);
			expect(result.name).toBe("Alpha");
		});

		it("should return error for missing id", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_find_by_id", {
					collection: "projects",
					id: "nonexistent",
				}),
			);
			expect(result.error).toBeDefined();
		});
	});

	describe("execute: CRUD tools", () => {
		it("should create a record", async () => {
			const db = await createTestDb();
			const { execute } = makeTools(db, config);

			const result = JSON.parse(
				await execute("proseql_create", {
					collection: "projects",
					data: {
						id: "p4",
						name: "Delta",
						status: "active",
						priority: 4,
					},
				}),
			);
			expect(result.name).toBe("Delta");

			// Verify it exists
			const found = JSON.parse(
				await execute("proseql_find_by_id", {
					collection: "projects",
					id: "p4",
				}),
			);
			expect(found.name).toBe("Delta");
		});

		it("should update a record", async () => {
			const db = await createTestDb();
			const { execute } = makeTools(db, config);

			const result = JSON.parse(
				await execute("proseql_update", {
					collection: "projects",
					id: "p1",
					data: { status: "completed" },
				}),
			);
			expect(result.status).toBe("completed");
		});

		it("should delete a record", async () => {
			const db = await createTestDb();
			const { execute } = makeTools(db, config);

			// p3 has no tasks referencing it, safe to delete
			const deleted = JSON.parse(
				await execute("proseql_delete", {
					collection: "projects",
					id: "p3",
				}),
			);
			expect(deleted.error).toBeUndefined();

			// Verify it's gone
			const result = JSON.parse(
				await execute("proseql_find_by_id", {
					collection: "projects",
					id: "p3",
				}),
			);
			expect(result.error).toBeDefined();
		});

		it("should reject writes in read-only mode", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("proseql_create", {
					collection: "projects",
					data: { id: "px", name: "X", status: "x", priority: 0 },
				}),
			);
			expect(result.error).toContain("read-only");
		});
	});

	describe("execute: unknown tool", () => {
		it("should return error for unknown tool name", async () => {
			const db = await createTestDb();
			const { execute } = makeReadOnlyTools(db, config);

			const result = JSON.parse(
				await execute("nonexistent_tool", {}),
			);
			expect(result.error).toContain("Unknown tool");
		});
	});
});
