import { describe, expect, it } from "vitest";
import { detectProseqlRuntime } from "../src/loader.js";

describe("service-worker runtime selection", () => {
	it("classifies ServiceWorkerGlobalScope before generic workers and Node", () => {
		expect(
			detectProseqlRuntime({
				registration: {},
				clients: {},
				skipWaiting: () => undefined,
				importScripts: () => undefined,
			}),
		).toBe("service-worker");
	});

	it("classifies dedicated workers without attempting the Node loader", () => {
		expect(detectProseqlRuntime({ importScripts: () => undefined })).toBe(
			"worker",
		);
	});

	it("keeps window and Node detection explicit", () => {
		expect(detectProseqlRuntime({ window: {}, document: {} })).toBe("window");
		expect(detectProseqlRuntime({ process: {} })).toBe("node");
	});
});
