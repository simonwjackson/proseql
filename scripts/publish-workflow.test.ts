import { spawnSync } from "node:child_process";
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

const stepScript = (name: string): string => {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = workflow.match(
		new RegExp(
			`- name: ${escapedName}\\n[\\s\\S]*?run: \\|\\n((?: {10}.*(?:\\n|$))+)`,
		),
	);
	expect(match, `missing shell for ${name}`).not.toBeNull();
	return (match?.[1] ?? "")
		.split("\n")
		.map((line) => line.replace(/^ {10}/, ""))
		.join("\n");
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

	it("rejects a workflow revision that differs from the reviewed commit before the dependent upload chain", () => {
		const reviewed = "0123456789abcdef0123456789abcdef01234567";
		const mismatch = "89abcdef0123456789abcdef0123456789abcdef";
		const script = stepScript(
			"Validate reviewed workflow source and commit input",
		);
		const accepted = spawnSync("bash", ["-c", script], {
			env: {
				...process.env,
				REVIEWED_COMMIT: reviewed,
				WORKFLOW_COMMIT: reviewed,
			},
		});
		const rejected = spawnSync("bash", ["-c", script], {
			env: {
				...process.env,
				REVIEWED_COMMIT: reviewed,
				WORKFLOW_COMMIT: mismatch,
			},
		});
		expect(accepted.status).toBe(0);
		expect(rejected.status).not.toBe(0);
		expect(rejected.stderr.toString()).toMatch(
			/workflow source.*not reviewed/i,
		);
		expect(jobBody("oidc-publish")).toContain("needs: preflight");
	});

	it("keeps preflight credential-free and binds narrowly scoped artifacts to exact clean HEAD", () => {
		const preflight = jobBody("preflight");
		expect(preflight).toContain(`WORKFLOW_COMMIT: \${{ github.sha }}`);
		expect(preflight).toContain(`ref: \${{ inputs.commit_sha }}`);
		expect(preflight).toContain("git rev-parse HEAD");
		expect(preflight).toContain("git status --porcelain");
		expect(preflight).toContain("just release-finalize");
		expect(preflight).toContain("prepare-publisher-bundle.ts");
		expect(preflight).toContain(".artifacts/release/prepared-release.json");
		expect(preflight).toContain("SHA256SUMS");
		expect(preflight).toContain("path: .artifacts/release/");
		expect(preflight).toContain("include-hidden-files: true");
		expect(preflight).not.toMatch(/^\s*path: \.artifacts\/$/m);
		expect(preflight).not.toMatch(
			/npm-production|NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./,
		);
	});

	it("uses OIDC trusted publishing without secrets, whoami, or dist-tag mutations", () => {
		const body = jobBody("oidc-publish");
		expect(body).toContain("environment: npm-production");
		expect(body).toContain("id-token: write");
		expect(body).toContain("contents: read");
		expect(body).toContain("actions/setup-node@");
		expect(body).toContain("node-version: '24'");
		expect(body).toContain("registry-url: 'https://registry.npmjs.org'");
		expect(body).toContain("sha256sum --check SHA256SUMS");
		expect(body).toContain("--approve-publish");
		expect(body).toContain("actions/download-artifact@");
		// No secrets or tokens
		expect(body).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
		// No source checkout, build, or install
		expect(body).not.toContain("actions/checkout@");
		expect(body).not.toMatch(
			/\b(?:bun|npm|pnpm|yarn)\s+(?:install|run|build|pack)\b/,
		);
		expect(body).not.toMatch(/prepublish|postinstall|lifecycle/);
		// No dist-tag mutations or whoami
		expect(body).not.toMatch(/whoami|dist-tag/);
	});

	it("verifies the registry without secrets after publish", () => {
		const publish = jobBody("oidc-publish");
		const consumer = jobBody("registry-consumer");
		const release = jobBody("github-release");
		expect(publish).toContain("needs: preflight");
		expect(consumer).toMatch(/needs:.*oidc-publish/);
		expect(consumer).toMatch(/needs:.*preflight/);
		expect(release).toMatch(/needs:.*registry-consumer/);
		expect(consumer).toContain("verify-registry-packages.ts");
		expect(consumer).toContain("consumer-verification.json");
		expect(consumer).not.toMatch(
			/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|npm-production/,
		);
	});

	it("creates or resumes the tag and GitHub release only after registry consumer at the exact commit", () => {
		const release = jobBody("github-release");
		expect(release).toMatch(/needs:.*registry-consumer/);
		expect(release).toContain("contents: write");
		expect(release).toContain("consumer-verification-");
		expect(release).toContain("consumer-verification.json");
		expect(release).toContain("$verification[0].releaseId");
		expect(release).toContain("$verification[0].artifacts");
		expect(release).not.toMatch(
			/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|npm-production/,
		);
		expect(release).toContain('--target "$COMMIT_SHA"');
		expect(release).toContain('gh api "repos/$GH_REPO/commits/$tag"');
		expect(release).toContain('test "$resolved_commit" = "$COMMIT_SHA"');
		expect(release).toContain("gh release view");
		expect(release).toContain("gh release create");
		expect(release).toContain("gh release upload");
		expect(release).toContain("--clobber");
	});

	it("has no candidate-upload or promote-latest jobs", () => {
		expect(workflow).not.toContain("candidate-upload:");
		expect(workflow).not.toContain("promote-latest:");
		expect(workflow).not.toMatch(/candidateTag|candidate-tag/);
		expect(workflow).not.toMatch(
			/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|npm whoami|npm dist-tag/,
		);
	});
});
