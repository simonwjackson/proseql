import { describe, expect, it } from "vitest";
import { createTaskInstrumentation } from "./utils.js";

describe("projection instrumentation", () => {
	it("serializes live materialization metrics into benchmark reports", () => {
		const metrics = {
			descriptors: 2,
			descriptorBytes: 40,
			cacheHits: 1,
			cacheMisses: 1,
			resynchronizations: 0,
			fullValueBytesAvoided: 128,
			materializationMilliseconds: 0.25,
			materializedRows: 1,
			trackedProxies: 1,
			peakMaterializedRows: 1,
			peakTrackedProxies: 1,
		};
		const instrumentation = createTaskInstrumentation({
			initializationMs: 1,
			projectionMaterialization: () => metrics,
		});
		expect(
			JSON.parse(JSON.stringify(instrumentation)).projectionMaterialization,
		).toEqual(metrics);
	});
});
