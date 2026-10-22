// YAML written by the engine reads back to the same records.
//
// Production shape: a meal log with a list of items and a long free-text
// `food` field as the first key of each item. The Rust native YAML encoder
// once folded that field onto its key's column. This test pins the WASM
// engine's YAML persistence (the TypeScript `yaml` package through
// @proseql/core, not the Rust codec) to an exact round trip. All data is
// synthetic.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
	YAML_HAZARDS as HAZARDS,
	LONG_TEXT as LONG,
} from "../../core/tests/fixtures/yaml-hazards.js";
import { createPersistentEngineDatabase } from "../src/index.js";

const ItemSchema = Schema.Struct({
	food: Schema.String,
	quantity: Schema.Number,
});

const MealSchema = Schema.Struct({
	id: Schema.String,
	note: Schema.String,
	items: Schema.Array(ItemSchema),
});

const WORKTREE_ROOT = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);

beforeAll(() => {
	execFileSync("bun", ["packages/engine/scripts/build-wasm.mjs"], {
		cwd: WORKTREE_ROOT,
		stdio: "inherit",
	});
}, 60_000);

const config = (file: string) =>
	({
		meals: { schema: MealSchema, file, relationships: {} },
	}) as const;

describe("@proseql/engine YAML persistence", () => {
	it("reopens long first-item fields and YAML hazards unchanged", async () => {
		const dir = await mkdtemp(join(tmpdir(), "proseql-engine-yaml-"));
		const file = join(dir, "meals.yaml");
		try {
			const meals = HAZARDS.map((text, index) => ({
				id: `meal-${String(index).padStart(3, "0")}`,
				note: text,
				items: [
					{ food: text, quantity: 1 },
					{ food: LONG, quantity: 1.5 },
					{ food: text, quantity: index },
				],
			}));
			const db = await createPersistentEngineDatabase(config(file), undefined, {
				writeDebounce: 5,
			});
			for (const meal of meals) {
				await db.meals.create(meal);
			}
			await db.flush();
			await db.close();

			const text = await readFile(file, "utf8");
			expect(text).toContain("  items:\n    - food: aaaa");

			const reopened = await createPersistentEngineDatabase(
				config(file),
				undefined,
				{ writeDebounce: 5 },
			);
			for (const meal of meals) {
				expect(await reopened.meals.findById(meal.id)).toEqual(meal);
			}
			await reopened.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
