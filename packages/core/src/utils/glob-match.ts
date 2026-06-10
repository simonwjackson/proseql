/**
 * Real glob matching for `documentGraph` discovery, backed by `picomatch`.
 *
 * This wrapper is intentionally separate from the hand-rolled `matchesPattern`
 * used by the writable `documents` source: the graph source needs full glob
 * semantics (recursive `**`, brace groups) while `documents` keeps its existing
 * narrow behavior unchanged.
 *
 * Pure JS only — no Node imports — so it stays runtime-agnostic for `@proseql/core`.
 */

import picomatch from "picomatch";
import { normalizePath } from "./path.js";

// Dot policy is pinned explicitly so dotfile matching is intentional rather than
// inheriting picomatch's default of excluding paths whose segments start with a
// dot. Config fragments are commonly dotfiles (e.g. `.app.config.yaml`), so the
// graph source matches them.
const MATCH_OPTIONS: picomatch.PicomatchOptions = { dot: true };

const matcherCache = new Map<string, picomatch.Matcher>();

function getMatcher(pattern: string): picomatch.Matcher {
	const cached = matcherCache.get(pattern);
	if (cached !== undefined) return cached;
	const matcher = picomatch(normalizePath(pattern), MATCH_OPTIONS);
	matcherCache.set(pattern, matcher);
	return matcher;
}

/**
 * Match a single normalized, root-relative path against one glob pattern. Paths
 * that escape the root (`../…`) never match.
 */
export function isMatch(relativePath: string, pattern: string): boolean {
	const normalized = normalizePath(relativePath);
	if (normalized === ".." || normalized.startsWith("../")) return false;
	return getMatcher(pattern)(normalized);
}

/**
 * Match a path against an ordered list of patterns; true if any pattern matches.
 * An empty list matches nothing.
 */
export function matchesAny(
	relativePath: string,
	patterns: ReadonlyArray<string>,
): boolean {
	return patterns.some((pattern) => isMatch(relativePath, pattern));
}
