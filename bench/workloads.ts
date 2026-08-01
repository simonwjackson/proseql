import type { BenchmarkCaseType, BenchmarkCategory } from "./comparison.js";

export interface WorkloadManifestEntry {
	readonly suite: string;
	readonly name: string;
	readonly category: BenchmarkCategory;
	readonly caseType: BenchmarkCaseType;
	readonly normalInteraction: boolean;
}

const createManifestEntry = (
	suite: string,
	name: string,
	category: BenchmarkCategory,
	caseType: BenchmarkCaseType,
	normalInteraction: boolean,
): WorkloadManifestEntry => ({
	suite,
	name,
	category,
	caseType,
	normalInteraction,
});

export const BROWSER_WORKLOAD_NAMES = {
	findById10K: "findById @ 10K",
	paginateLimit100Offset500: "paginate: limit 100, offset 500",
	createSingle: "create (single)",
	updateSingle: "update (single)",
	deleteSingle: "delete (single)",
	updateManyDeclarative: "updateMany (declarative batch ~100)",
	updateManyPredicate: "updateMany (predicate batch ~100)",
	transactionalCreateUpdateDelete: "transactional (create + update + delete)",
} as const;

export type BrowserWorkloadName =
	(typeof BROWSER_WORKLOAD_NAMES)[keyof typeof BROWSER_WORKLOAD_NAMES];

export const BROWSER_WORKLOAD_INTERACTION_NAMES = Object.values(
	BROWSER_WORKLOAD_NAMES,
) as ReadonlyArray<BrowserWorkloadName>;

export const BROWSER_WORKLOAD_BASELINE_COUNT = 10_000;

export interface BrowserWorkloadExpectation {
	readonly resultCount: number;
	readonly baselineCount: number;
	readonly cleanupCount: number;
	readonly targetExistsAfterCleanup?: boolean;
}

export interface BrowserPerformanceWorkloadState {
	readonly workload: BrowserWorkloadName;
	readonly baselineCount: number;
	readonly resultCount: number;
	readonly restorationVerified: boolean;
	readonly targetExistsAfterCleanup?: boolean;
}

export const BROWSER_WORKLOAD_EXPECTATIONS = {
	[BROWSER_WORKLOAD_NAMES.findById10K]: {
		resultCount: 1,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		targetExistsAfterCleanup: true,
	},
	[BROWSER_WORKLOAD_NAMES.paginateLimit100Offset500]: {
		resultCount: 100,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
	},
	[BROWSER_WORKLOAD_NAMES.createSingle]: {
		resultCount: 1,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		targetExistsAfterCleanup: false,
	},
	[BROWSER_WORKLOAD_NAMES.updateSingle]: {
		resultCount: 1,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		targetExistsAfterCleanup: true,
	},
	[BROWSER_WORKLOAD_NAMES.deleteSingle]: {
		resultCount: 1,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		targetExistsAfterCleanup: true,
	},
	[BROWSER_WORKLOAD_NAMES.updateManyDeclarative]: {
		resultCount: 100,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		targetExistsAfterCleanup: true,
	},
	[BROWSER_WORKLOAD_NAMES.updateManyPredicate]: {
		resultCount: 100,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		targetExistsAfterCleanup: true,
	},
	[BROWSER_WORKLOAD_NAMES.transactionalCreateUpdateDelete]: {
		resultCount: 1,
		baselineCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		cleanupCount: BROWSER_WORKLOAD_BASELINE_COUNT,
		targetExistsAfterCleanup: false,
	},
} as const satisfies Record<BrowserWorkloadName, BrowserWorkloadExpectation>;

export const WORKLOAD_MANIFEST: ReadonlyArray<WorkloadManifestEntry> = [
	createManifestEntry(
		"crud",
		"create (single)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"crud",
		"createMany (batch of 100)",
		"write-transaction",
		"required",
		false,
	),
	createManifestEntry(
		"crud",
		"update (single)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"crud",
		"updateMany (declarative batch ~100)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"crud",
		"updateMany (predicate batch ~100)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"crud",
		"delete (single)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"crud",
		"deleteMany (declarative batch ~100)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"crud",
		"deleteMany (predicate batch ~100)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"crud",
		"upsert (create path)",
		"write-transaction",
		"required",
		false,
	),
	createManifestEntry(
		"crud",
		"upsert (update path)",
		"write-transaction",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"filter: equality (role = 'admin')",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"filter: range (age > 30 AND age < 50)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"filter: compound ($and with 3 conditions)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"sort: single-field (age asc)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"sort: single-field (age desc)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"sort: multi-field (role asc, age desc)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"sort: multi-field (role asc, age desc, name asc)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"populate: single ref (order → user)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"populate: inverse (user → orders)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"populate: nested 2-level (order → user → orders)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"populate: multiple refs (order → user, product)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"populate: nested 3-level (order → product → supplier)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"select: single field (name)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"select: two fields (id, name)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"select: three fields (id, name, email)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"select: most fields (id, name, email, age, role)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"select: no projection (all fields)",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"select: with filter (name, email WHERE role='admin')",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"query-pipeline",
		"paginate: limit 10 from beginning",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"paginate: limit 10, offset 5000 (middle)",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"paginate: limit 10, offset 9990 (end)",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"paginate: limit 100, offset 500",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"paginate: limit 10, offset 1000 with sort",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"paginate: limit 10, offset 500 with filter",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"combined: filter + sort + select + paginate (no populate)",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"combined: filter + sort + populate + select + paginate",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"combined: filter + nested populate + sort + paginate",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"query-pipeline",
		"combined: complex filter + multi-populate + sort + select + paginate",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"scaling",
		"findById @ 100",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"findById @ 1K",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"findById @ 10K",
		"read-query",
		"required",
		true,
	),
	createManifestEntry(
		"scaling",
		"unindexed filter @ 100",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"unindexed filter @ 1K",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"unindexed filter @ 10K",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"indexed filter @ 100",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"indexed filter @ 1K",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"indexed filter @ 10K",
		"read-query",
		"required",
		false,
	),
	createManifestEntry(
		"scaling",
		"findById @ 100K",
		"read-query",
		"stress",
		false,
	),
	createManifestEntry(
		"scaling",
		"unindexed filter @ 100K",
		"read-query",
		"stress",
		false,
	),
	createManifestEntry(
		"scaling",
		"indexed filter @ 100K",
		"read-query",
		"stress",
		false,
	),
	createManifestEntry(
		"scaling",
		"create (single) @ 100K",
		"write-transaction",
		"stress",
		false,
	),
	createManifestEntry(
		"scaling",
		"transactional (create + update + delete) @ 100K",
		"write-transaction",
		"stress",
		false,
	),
	createManifestEntry(
		"transactions",
		"direct (create + update + delete)",
		"write-transaction",
		"required",
		false,
	),
	createManifestEntry(
		"transactions",
		"transactional (create + update + delete)",
		"write-transaction",
		"required",
		true,
	),
	createManifestEntry(
		"serialization",
		"persistence: debounced coalescing (100 mutations)",
		"write-transaction",
		"required",
		false,
	),
	createManifestEntry(
		"serialization",
		"persistence: explicit flush",
		"write-transaction",
		"required",
		false,
	),
	createManifestEntry(
		"serialization",
		"callback: computed field",
		"read-query",
		"characterization",
		false,
	),
	createManifestEntry(
		"serialization",
		"callback: custom operator",
		"read-query",
		"characterization",
		false,
	),
	createManifestEntry(
		"serialization",
		"callback: locale collator",
		"read-query",
		"characterization",
		false,
	),
	createManifestEntry(
		"serialization",
		"callback: before/after hooks",
		"write-transaction",
		"characterization",
		false,
	),
] as const;
