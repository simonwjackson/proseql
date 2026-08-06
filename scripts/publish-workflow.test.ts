import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(
	resolve(root, ".github/workflows/publish.yml"),
	"utf8",
);

const jobBody = (name: string): string => {
	const start = workflow.indexOf(`  ${name}:\n`);
	expect(start, `missing ${name} job`).toBeGreaterThanOrEqual(0);
	const next = /\n {2}[a-z][a-z0-9-]*:\n/g;
	next.lastIndex = start + name.length + 4;
	const end = next.exec(workflow)?.index ?? workflow.length;
	return workflow.slice(start, end);
};

describe("approved npm publication workflow", () => {
	it("is manual-only and requires an explicit full reviewed commit SHA", () => {
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).not.toMatch(/\n\s+(push|pull_request|schedule|release):/);
		expect(workflow).toMatch(/commit_sha:\n\s+description:.*reviewed/i);
		expect(workflow).toMatch(/commit_sha:[\s\S]*required: true/);
		expect(workflow).toContain("^[0-9a-f]{40}$");
	});

	it("pins every action to an immutable commit", () => {
		const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(
			(match) => match[1] ?? "",
		);
		expect(actions.length).toBeGreaterThan(0);
		for (const action of actions) expect(action).toMatch(/@[0-9a-f]{40}$/);
	});

	it("keeps preflight credential-free and binds artifacts to exact clean HEAD", () => {
		const preflight = jobBody("preflight");
		expect(preflight).toContain(`ref: \${{ inputs.commit_sha }}`);
		expect(preflight).toContain("git rev-parse HEAD");
		expect(preflight).toContain("git status --porcelain");
		expect(preflight).toContain("just release-finalize");
		expect(preflight).toContain("prepare-publisher-bundle.ts");
		expect(preflight).toContain(".artifacts/release/prepared-release.json");
		expect(preflight).toContain("SHA256SUMS");
		expect(preflight).toContain("path: .artifacts/release/");
		expect(preflight).not.toMatch(
			/npm-production|NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./,
		);
	});

	it("isolates credentials in protected upload and promotion jobs without builds", () => {
		for (const name of ["candidate-upload", "promote-latest"]) {
			const body = jobBody(name);
			expect(body).toContain("environment: npm-production");
			expect(body).toContain("permissions: {}");
			expect(body).toContain(`NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`);
			expect(body).toContain('test -n "$NODE_AUTH_TOKEN"');
			expect(body).toContain("actions/download-artifact@");
			expect(body).toContain("sha256sum --check SHA256SUMS");
			expect(body).not.toContain("actions/checkout@");
			expect(body).not.toMatch(
				/\b(?:bun|npm|pnpm|yarn)\s+(?:install|run|build|pack)\b/,
			);
			expect(body).not.toMatch(/prepublish|postinstall|lifecycle/);
		}
		expect(jobBody("candidate-upload")).toContain("--approve-candidate-upload");
		expect(jobBody("promote-latest")).toContain("--approve-latest-promotion");
	});

	it("verifies the registry without secrets before promotion", () => {
		const candidate = jobBody("candidate-upload");
		const consumer = jobBody("registry-consumer");
		const promotion = jobBody("promote-latest");
		expect(candidate).toContain("needs: preflight");
		expect(consumer).toContain("needs: candidate-upload");
		expect(promotion).toMatch(/needs:.*registry-consumer/);
		expect(consumer).toContain("verify-registry-packages.ts");
		expect(consumer).toContain("consumer-verification.json");
		expect(consumer).not.toMatch(
			/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|npm-production/,
		);
		expect(promotion).toContain("consumer-verification.json");
	});

	it("creates the tag and GitHub release only after promotion at the exact commit", () => {
		const release = jobBody("github-release");
		expect(release).toMatch(/needs:.*promote-latest/);
		expect(release).toContain("contents: write");
		expect(release).not.toMatch(
			/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|npm-production/,
		);
		expect(release).toContain('--target "$COMMIT_SHA"');
		expect(release).toContain("gh release create");
	});
});
