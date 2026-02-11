import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createEffectDatabase } from "../src/index.js";

const BookSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	author: Schema.String,
	year: Schema.Number,
	description: Schema.String,
});

describe("Multi-field search", () => {
	it("5.1: terms can span across fields", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					books: { schema: BookSchema, relationships: {} },
				},
				{
					books: [
						{
							id: "1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							description: "A desert planet story",
						},
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							description: "Cyberpunk classic",
						},
						{
							id: "3",
							title: "The Left Hand of Darkness",
							author: "Ursula K. Le Guin",
							year: 1969,
							description: "Gender and society",
						},
					],
				},
			),
		);

		// "herbert" is in author, "dune" is in title - both should match the same entity
		const result = await db.books.query({
			where: {
				$search: { query: "herbert dune", fields: ["title", "author"] },
			},
		}).runPromise;
		expect(result.length).toBe(1);
		expect(result[0].title).toBe("Dune");
	});

	it("5.2: searches all string fields when fields omitted", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					books: { schema: BookSchema, relationships: {} },
				},
				{
					books: [
						{
							id: "1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							description: "A desert planet story",
						},
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							description: "Cyberpunk classic",
						},
					],
				},
			),
		);

		// Search for "gibson" without specifying fields - should search all string fields
		const result = await db.books.query({
			where: { $search: { query: "gibson" } },
		}).runPromise;
		expect(result.length).toBe(1);
		expect(result[0].title).toBe("Neuromancer");
	});

	it("5.2b: searches description field when fields omitted", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					books: { schema: BookSchema, relationships: {} },
				},
				{
					books: [
						{
							id: "1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							description: "A desert planet story",
						},
						{
							id: "2",
							title: "Neuromancer",
							author: "William Gibson",
							year: 1984,
							description: "Cyberpunk classic",
						},
					],
				},
			),
		);

		// Search for "desert" which is only in description
		const result = await db.books.query({
			where: { $search: { query: "desert" } },
		}).runPromise;
		expect(result.length).toBe(1);
		expect(result[0].title).toBe("Dune");
	});

	it("5.3: query tokens can match in different fields", async () => {
		const db = await Effect.runPromise(
			createEffectDatabase(
				{
					books: { schema: BookSchema, relationships: {} },
				},
				{
					books: [
						{
							id: "1",
							title: "Dune",
							author: "Frank Herbert",
							year: 1965,
							description: "A desert planet story",
						},
						{
							id: "3",
							title: "The Left Hand of Darkness",
							author: "Ursula K. Le Guin",
							year: 1969,
							description: "Gender and society",
						},
					],
				},
			),
		);

		// "le" and "guin" are in author, "darkness" is in title
		const result = await db.books.query({
			where: {
				$search: { query: "le guin darkness", fields: ["title", "author"] },
			},
		}).runPromise;
		expect(result.length).toBe(1);
		expect(result[0].title).toBe("The Left Hand of Darkness");
	});
});
