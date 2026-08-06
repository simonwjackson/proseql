import { describe, expect, it } from "vitest";
import {
	nixNpmPackDryRunArguments,
	npmPackDryRunArguments,
} from "./verify-package-artifacts.js";

describe("package artifact dry-run packing", () => {
	it("disables lifecycle scripts for direct npm packing", () => {
		expect(npmPackDryRunArguments).toContain("--ignore-scripts");
		expect(npmPackDryRunArguments).toEqual([
			"pack",
			"--dry-run",
			"--json",
			"--ignore-scripts",
		]);
	});

	it("disables lifecycle scripts for the Nix fallback", () => {
		const args = nixNpmPackDryRunArguments("/repo");
		expect(args).toContain("--ignore-scripts");
		expect(args.slice(-5)).toEqual([
			"npm",
			"pack",
			"--dry-run",
			"--json",
			"--ignore-scripts",
		]);
	});
});
