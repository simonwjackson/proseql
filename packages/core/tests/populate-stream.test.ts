import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk, Ref } from "effect";
import { applyPopulate } from "../src/operations/relationships/populate-stream.js";
import { applySelect } from "../src/operations/query/select-stream.js";
import type { CollectionConfig } from "../src/types/database-config-types.js";
import { DanglingReferenceError } from "../src/errors/query-errors.js";

// ============================================================================
// Helpers
// ============================================================================

/** Build a Ref<ReadonlyMap<string, Record<string, unknown>>> from an array of entities with `id` field. */
const makeRef = (
  items: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>> =>
  Ref.make(
    new Map(items.map((item) => [item.id as string, item])) as ReadonlyMap<
      string,
      Record<string, unknown>
    >,
  );

/** Collect a populated stream into a plain array. */
const collectPopulated = <T extends Record<string, unknown>>(
  items: ReadonlyArray<T>,
  populateConfig: Record<string, unknown> | undefined,
  stateRefs: Record<
    string,
    Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>
  >,
  dbConfig: Record<string, CollectionConfig>,
  collectionName: string,
): Promise<readonly Record<string, unknown>[]> =>
  Effect.runPromise(
    Stream.fromIterable(items).pipe(
      applyPopulate(populateConfig, stateRefs, dbConfig, collectionName),
      Stream.runCollect,
      Effect.map(Chunk.toReadonlyArray),
    ),
  );

// ============================================================================
// Test Data
// ============================================================================

const industries = [
  { id: "ind1", name: "Technology", sector: "IT" },
  { id: "ind2", name: "Healthcare", sector: "Medical" },
];

const companies = [
  { id: "comp1", name: "TechCorp", industryId: "ind1", foundedYear: 2010 },
  { id: "comp2", name: "HealthPlus", industryId: "ind2", foundedYear: 2015 },
];

const users = [
  { id: "u1", name: "Alice", email: "alice@tech.com", companyId: "comp1", age: 30 },
  { id: "u2", name: "Bob", email: "bob@tech.com", companyId: "comp1", age: 28 },
  { id: "u3", name: "Charlie", email: "charlie@health.com", companyId: "comp2", age: 35 },
];

const orders = [
  { id: "ord1", orderNumber: "ORD-001", userId: "u1", total: 299.99, status: "completed" },
  { id: "ord2", orderNumber: "ORD-002", userId: "u1", total: 599.99, status: "pending" },
  { id: "ord3", orderNumber: "ORD-003", userId: "u2", total: 149.99, status: "completed" },
];

const products = [
  { id: "prod1", name: "Laptop", price: 999, categoryId: "cat1" },
  { id: "prod2", name: "Monitor", price: 499, categoryId: "cat1" },
];

const orderItems = [
  { id: "item1", orderId: "ord1", productId: "prod1", quantity: 1, price: 999 },
  { id: "item2", orderId: "ord2", productId: "prod2", quantity: 2, price: 499 },
];

const categories = [
  { id: "cat1", name: "Electronics", description: "Electronic devices" },
  { id: "cat2", name: "Office", description: "Office supplies" },
];

// Database configuration with relationships
const dbConfig: Record<string, CollectionConfig> = {
  industries: {
    schema: {} as CollectionConfig["schema"],
    relationships: {
      companies: { type: "inverse", target: "companies" },
    },
  },
  companies: {
    schema: {} as CollectionConfig["schema"],
    relationships: {
      industry: { type: "ref", target: "industries" },
      users: { type: "inverse", target: "users" },
    },
  },
  users: {
    schema: {} as CollectionConfig["schema"],
    relationships: {
      company: { type: "ref", target: "companies" },
      orders: { type: "inverse", target: "orders" },
    },
  },
  orders: {
    schema: {} as CollectionConfig["schema"],
    relationships: {
      user: { type: "ref", target: "users" },
      items: { type: "inverse", target: "orderItems" },
    },
  },
  orderItems: {
    schema: {} as CollectionConfig["schema"],
    relationships: {
      order: { type: "ref", target: "orders" },
      product: { type: "ref", target: "products" },
    },
  },
  products: {
    schema: {} as CollectionConfig["schema"],
    relationships: {
      category: { type: "ref", target: "categories" },
      orderItems: { type: "inverse", target: "orderItems" },
    },
  },
  categories: {
    schema: {} as CollectionConfig["schema"],
    relationships: {
      products: { type: "inverse", target: "products" },
    },
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("applyPopulate Stream combinator", () => {
  // Build state refs before each test — we use Effect.runSync since Ref.make is sync-safe
  const buildRefs = () =>
    Effect.runSync(
      Effect.all({
        industries: makeRef(industries),
        companies: makeRef(companies),
        users: makeRef(users),
        orders: makeRef(orders),
        orderItems: makeRef(orderItems),
        products: makeRef(products),
        categories: makeRef(categories),
      }),
    );

  // ============================================================================
  // Pass-through
  // ============================================================================

  describe("pass-through", () => {
    it("should return stream unchanged when populateConfig is undefined", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(users, undefined, refs, dbConfig, "users");
      expect(result).toEqual(users);
    });

    it("should return stream unchanged when populateConfig is empty object", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(users, {}, refs, dbConfig, "users");
      expect(result).toEqual(users);
    });

    it("should return stream unchanged when collection has no matching relationships", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        users,
        { nonExistent: true },
        refs,
        dbConfig,
        "users",
      );
      expect(result).toEqual(users);
    });
  });

  // ============================================================================
  // Ref relationships (belongsTo / many-to-one)
  // ============================================================================

  describe("ref relationships", () => {
    it("should populate a single ref relationship", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [users[0]],
        { company: true },
        refs,
        dbConfig,
        "users",
      );

      expect(result).toHaveLength(1);
      expect(result[0].company).toEqual(companies[0]);
    });

    it("should populate ref for all items in stream", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        users,
        { company: true },
        refs,
        dbConfig,
        "users",
      );

      expect(result).toHaveLength(3);
      expect(result[0].company).toEqual(companies[0]);
      expect(result[1].company).toEqual(companies[0]);
      expect(result[2].company).toEqual(companies[1]);
    });

    it("should set undefined when foreign key value is not a string", async () => {
      const refs = buildRefs();
      const itemsWithNullFK = [{ id: "x1", name: "X", companyId: undefined }];
      const result = await collectPopulated(
        itemsWithNullFK,
        { company: true },
        refs,
        dbConfig,
        "users",
      );

      expect(result).toHaveLength(1);
      expect(result[0].company).toBeUndefined();
    });

    it("should use custom foreignKey from relationship config", async () => {
      const customConfig: Record<string, CollectionConfig> = {
        employees: {
          schema: {} as CollectionConfig["schema"],
          relationships: {
            org: { type: "ref", target: "orgs", foreignKey: "orgKey" },
          },
        },
        orgs: {
          schema: {} as CollectionConfig["schema"],
          relationships: {},
        },
      };

      const orgRef = Effect.runSync(makeRef([{ id: "o1", name: "Acme" }]));
      const empRef = Effect.runSync(makeRef([{ id: "e1", name: "Alice", orgKey: "o1" }]));

      const result = await collectPopulated(
        [{ id: "e1", name: "Alice", orgKey: "o1" }],
        { org: true },
        { employees: empRef, orgs: orgRef },
        customConfig,
        "employees",
      );

      expect(result[0].org).toEqual({ id: "o1", name: "Acme" });
    });
  });

  // ============================================================================
  // Inverse relationships (hasMany / one-to-many)
  // ============================================================================

  describe("inverse relationships", () => {
    it("should populate inverse relationship as array", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [companies[0]],
        { users: true },
        refs,
        dbConfig,
        "companies",
      );

      expect(result).toHaveLength(1);
      const populatedUsers = result[0].users as Record<string, unknown>[];
      expect(populatedUsers).toHaveLength(2);
      expect(populatedUsers.map((u) => u.name)).toEqual(["Alice", "Bob"]);
    });

    it("should return empty array for inverse with no matches", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [categories[1]], // cat2 has no products
        { products: true },
        refs,
        dbConfig,
        "categories",
      );

      expect(result).toHaveLength(1);
      expect(result[0].products).toEqual([]);
    });

    it("should resolve inverse foreign key from target ref relationship", async () => {
      const refs = buildRefs();
      // industries -> companies is inverse; the target "companies" has a ref
      // relationship back to "industries" with default foreignKey "industryId"
      const result = await collectPopulated(
        [industries[0]],
        { companies: true },
        refs,
        dbConfig,
        "industries",
      );

      expect(result).toHaveLength(1);
      const populatedCompanies = result[0].companies as Record<string, unknown>[];
      expect(populatedCompanies).toHaveLength(1);
      expect(populatedCompanies[0].name).toBe("TechCorp");
    });

    it("should use explicit foreignKey on inverse relationship", async () => {
      const customConfig: Record<string, CollectionConfig> = {
        managers: {
          schema: {} as CollectionConfig["schema"],
          relationships: {
            projects: {
              type: "inverse",
              target: "projects",
              foreignKey: "leadId",
            },
          },
        },
        projects: {
          schema: {} as CollectionConfig["schema"],
          relationships: {},
        },
      };

      const managerRef = Effect.runSync(makeRef([{ id: "m1", name: "Alice" }]));
      const projectRef = Effect.runSync(
        makeRef([
          { id: "p1", name: "Alpha", leadId: "m1" },
          { id: "p2", name: "Beta", leadId: "m1" },
          { id: "p3", name: "Gamma", leadId: "m2" },
        ]),
      );

      const result = await collectPopulated(
        [{ id: "m1", name: "Alice" }],
        { projects: true },
        { managers: managerRef, projects: projectRef },
        customConfig,
        "managers",
      );

      const populatedProjects = result[0].projects as Record<string, unknown>[];
      expect(populatedProjects).toHaveLength(2);
      expect(populatedProjects.map((p) => p.name)).toEqual(["Alpha", "Beta"]);
    });
  });

  // ============================================================================
  // Nested population
  // ============================================================================

  describe("nested population", () => {
    it("should populate two levels deep (ref -> ref)", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [users[0]],
        { company: { industry: true } },
        refs,
        dbConfig,
        "users",
      );

      expect(result).toHaveLength(1);
      const company = result[0].company as Record<string, unknown>;
      expect(company).toBeDefined();
      expect(company.industry).toEqual(industries[0]);
    });

    it("should populate three levels deep (ref -> ref -> inverse)", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [orders[0]],
        { user: { company: { industry: true } } },
        refs,
        dbConfig,
        "orders",
      );

      expect(result).toHaveLength(1);
      const user = result[0].user as Record<string, unknown>;
      const company = user.company as Record<string, unknown>;
      expect(company.industry).toEqual(industries[0]);
    });

    it("should populate mixed nested: ref with nested + flat inverse", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [orders[0]],
        { user: { company: true }, items: true },
        refs,
        dbConfig,
        "orders",
      );

      expect(result).toHaveLength(1);
      const user = result[0].user as Record<string, unknown>;
      expect(user.company).toEqual(companies[0]);

      const items = result[0].items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0].productId).toBe("prod1");
    });

    it("should populate nested inverse relationships", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [companies[0]],
        { users: { orders: true } },
        refs,
        dbConfig,
        "companies",
      );

      expect(result).toHaveLength(1);
      const populatedUsers = result[0].users as Record<string, unknown>[];
      expect(populatedUsers).toHaveLength(2);

      // Alice has 2 orders
      const aliceOrders = populatedUsers[0].orders as Record<string, unknown>[];
      expect(aliceOrders).toHaveLength(2);

      // Bob has 1 order
      const bobOrders = populatedUsers[1].orders as Record<string, unknown>[];
      expect(bobOrders).toHaveLength(1);
    });

    it("should respect depth limit of 5 (stop recursing beyond)", async () => {
      // Build a chain of collections that reference each other, 7 levels deep
      const chainConfig: Record<string, CollectionConfig> = {};
      const chainRefs: Record<
        string,
        Ref.Ref<ReadonlyMap<string, Record<string, unknown>>>
      > = {};

      for (let i = 0; i < 7; i++) {
        const name = `level${i}`;
        const nextName = `level${i + 1}`;
        chainConfig[name] = {
          schema: {} as CollectionConfig["schema"],
          relationships:
            i < 6
              ? { next: { type: "ref", target: nextName, foreignKey: "nextId" } }
              : {},
        };
        chainRefs[name] = Effect.runSync(
          makeRef([{ id: `id${i}`, name: `Entity${i}`, nextId: `id${i + 1}` }]),
        );
      }

      // Build nested populate config going 7 levels deep
      let populateConfig: Record<string, unknown> = { next: true };
      for (let i = 0; i < 6; i++) {
        populateConfig = { next: populateConfig };
      }

      // Should not throw — depth limit silently stops recursion
      const result = await collectPopulated(
        [{ id: "id0", name: "Entity0", nextId: "id1" }],
        populateConfig,
        chainRefs,
        chainConfig,
        "level0",
      );

      expect(result).toHaveLength(1);

      // Walk the chain — population starts at depth 0, recurses up to depth 5
      // (stops at depth >= MAX_POPULATE_DEPTH=5), so we get 6 populated hops total
      let current = result[0] as Record<string, unknown>;
      let hops = 0;
      while (current.next && typeof current.next === "object" && !Array.isArray(current.next)) {
        current = current.next as Record<string, unknown>;
        hops++;
      }
      // 6 hops of population, then recursion stops
      expect(hops).toBeLessThanOrEqual(6);
    });
  });

  // ============================================================================
  // Population with select
  // ============================================================================

  describe("population with select", () => {
    it("should compose populate then select in a pipeline", async () => {
      const refs = buildRefs();
      const result = await Effect.runPromise(
        Stream.fromIterable([users[0]]).pipe(
          applyPopulate(
            { company: true, orders: true },
            refs,
            dbConfig,
            "users",
          ),
          applySelect({ name: true, company: { name: true } }),
          Stream.runCollect,
          Effect.map(Chunk.toReadonlyArray),
        ),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "Alice",
        company: { name: "TechCorp" },
      });
    });

    it("should select nested populated fields", async () => {
      const refs = buildRefs();
      const result = await Effect.runPromise(
        Stream.fromIterable([users[0]]).pipe(
          applyPopulate(
            { company: { industry: true } },
            refs,
            dbConfig,
            "users",
          ),
          applySelect({
            name: true,
            company: { name: true, industry: { sector: true } },
          }),
          Stream.runCollect,
          Effect.map(Chunk.toReadonlyArray),
        ),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "Alice",
        company: {
          name: "TechCorp",
          industry: { sector: "IT" },
        },
      });
    });

    it("should select fields from populated inverse arrays", async () => {
      const refs = buildRefs();
      const result = await Effect.runPromise(
        Stream.fromIterable([companies[0]]).pipe(
          applyPopulate({ users: true }, refs, dbConfig, "companies"),
          applySelect({ name: true, users: { name: true } }),
          Stream.runCollect,
          Effect.map(Chunk.toReadonlyArray),
        ),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "TechCorp",
        users: [{ name: "Alice" }, { name: "Bob" }],
      });
    });
  });

  // ============================================================================
  // Dangling reference handling
  // ============================================================================

  describe("dangling reference handling", () => {
    it("should emit DanglingReferenceError for missing ref target", async () => {
      const refs = buildRefs();
      const userWithBadRef = [
        { id: "bad1", name: "Ghost", companyId: "nonexistent", age: 99 },
      ];

      const program = Stream.fromIterable(userWithBadRef).pipe(
        applyPopulate({ company: true }, refs, dbConfig, "users"),
        Stream.runCollect,
      );

      const result = await Effect.runPromise(Effect.either(program));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const error = result.left;
        expect(error).toBeInstanceOf(DanglingReferenceError);
        expect((error as DanglingReferenceError).collection).toBe("companies");
        expect((error as DanglingReferenceError).field).toBe("companyId");
        expect((error as DanglingReferenceError).targetId).toBe("nonexistent");
      }
    });

    it("should not error when foreign key is not a string (treated as no relationship)", async () => {
      const refs = buildRefs();
      const userWithNullFK = [
        { id: "null1", name: "NoCompany", companyId: null, age: 20 },
      ];

      const result = await collectPopulated(
        userWithNullFK,
        { company: true },
        refs,
        dbConfig,
        "users",
      );

      expect(result).toHaveLength(1);
      expect(result[0].company).toBeUndefined();
    });

    it("should emit DanglingReferenceError in nested population", async () => {
      // Build refs where a company has a bad industryId
      const badCompanies = [
        { id: "comp_bad", name: "BadCo", industryId: "nonexistent", foundedYear: 2020 },
      ];
      const badUsers = [
        { id: "u_bad", name: "BadUser", companyId: "comp_bad", age: 25 },
      ];

      const badRefs = Effect.runSync(
        Effect.all({
          industries: makeRef(industries),
          companies: makeRef(badCompanies),
          users: makeRef(badUsers),
          orders: makeRef([]),
          orderItems: makeRef([]),
          products: makeRef([]),
          categories: makeRef([]),
        }),
      );

      const program = Stream.fromIterable(badUsers).pipe(
        applyPopulate(
          { company: { industry: true } },
          badRefs,
          dbConfig,
          "users",
        ),
        Stream.runCollect,
      );

      const result = await Effect.runPromise(Effect.either(program));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(DanglingReferenceError);
        expect((result.left as DanglingReferenceError).collection).toBe("industries");
        expect((result.left as DanglingReferenceError).targetId).toBe("nonexistent");
      }
    });
  });

  // ============================================================================
  // Stream composition
  // ============================================================================

  describe("Stream composition", () => {
    it("should preserve stream error channel", async () => {
      const refs = buildRefs();
      const failingStream = Stream.concat(
        Stream.fromIterable([users[0]]),
        Stream.fail("upstream-error" as const),
      );

      const populated = failingStream.pipe(
        applyPopulate({ company: true }, refs, dbConfig, "users"),
      );

      const result = await Effect.runPromise(
        Effect.either(Stream.runCollect(populated)),
      );
      expect(result._tag).toBe("Left");
    });

    it("should work with empty stream", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [],
        { company: true },
        refs,
        dbConfig,
        "users",
      );
      expect(result).toEqual([]);
    });

    it("should not fail when collection name is unknown", async () => {
      const refs = buildRefs();
      const result = await collectPopulated(
        [{ id: "x1", name: "test" }],
        { something: true },
        refs,
        dbConfig,
        "unknownCollection",
      );
      // Should pass through unchanged since the collection doesn't exist in dbConfig
      expect(result).toEqual([{ id: "x1", name: "test" }]);
    });
  });
});
