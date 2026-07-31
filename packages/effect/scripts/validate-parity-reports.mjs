#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRootFromImportMetaUrl } from "./_parity-helpers.mjs";

const repoRoot = repoRootFromImportMetaUrl(import.meta.url);
const reportDir = join(repoRoot, "packages/effect/reports");
const corpus = JSON.parse(readFileSync(join(reportDir, "corpus-report.json"), "utf8"));
const examples = JSON.parse(readFileSync(join(reportDir, "examples-report.json"), "utf8"));

validateCorpusReport(corpus);
validateExamplesReport(examples);

console.log("Parity reports validated.");

function validateCorpusReport(report) {
	requireObject(report, "corpus report");
	requireString(report.phase, "corpus.phase");
	requireObject(report.summary, "corpus.summary");
	requireNumber(report.summary.totalFiles, "corpus.summary.totalFiles");
	requireNumber(report.summary.executedFiles, "corpus.summary.executedFiles");
	requireNumber(report.summary.coverageRate, "corpus.summary.coverageRate");
	requireNumber(report.summary.slicePassRate, "corpus.summary.slicePassRate");
	requireArray(report.results, "corpus.results");
	const failing = report.results.filter((result) =>
		result.expectation === "pass" && result.status !== "passed"
	);
	const unexpectedXpass = report.results.filter((result) =>
		result.expectation === "xfail" && result.status === "xpassed"
	);
	const sliceSkips = report.results.filter((result) => result.category === "slice-not-yet-adapted");
	if (failing.length > 0) {
		throw new Error(`Corpus report contains runnable failures: ${failing.map((result) => result.test).join(", ")}`);
	}
	if (unexpectedXpass.length > 0) {
		throw new Error(`Corpus report contains unexpected xpasses: ${unexpectedXpass.map((result) => result.test).join(", ")}`);
	}
	if (sliceSkips.length > 0) {
		throw new Error(`Corpus report still contains slice-not-yet-adapted entries: ${sliceSkips.map((result) => result.test).join(", ")}`);
	}
}

function validateExamplesReport(report) {
	requireObject(report, "examples report");
	requireString(report.phase, "examples.phase");
	requireObject(report.summary, "examples.summary");
	requireNumber(report.summary.totalExamples, "examples.summary.totalExamples");
	requireNumber(report.summary.runnableExamples, "examples.summary.runnableExamples");
	requireNumber(report.summary.slicePassRate, "examples.summary.slicePassRate");
	requireArray(report.results, "examples.results");
	const failing = report.results.filter((result) =>
		result.expectation === "pass" && result.status !== "passed"
	);
	const unexpectedXpass = report.results.filter((result) =>
		result.expectation === "xfail" && result.status === "xpassed"
	);
	if (failing.length > 0) {
		throw new Error(`Examples report contains runnable failures: ${failing.map((result) => result.test).join(", ")}`);
	}
	if (unexpectedXpass.length > 0) {
		throw new Error(`Examples report contains unexpected xpasses: ${unexpectedXpass.map((result) => result.test).join(", ")}`);
	}
}

function requireObject(value, label) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
}

function requireArray(value, label) {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
}

function requireNumber(value, label) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(`${label} must be a number`);
	}
}

function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
}
