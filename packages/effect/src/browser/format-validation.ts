/**
 * Format validation utilities for browser storage adapters.
 *
 * Provides helpers to extract file extensions and validate them against
 * an allowed formats list.
 */

import { getFileExtension, UnsupportedFormatError } from "@proseql/core";
import { Effect } from "effect";

/**
 * Validate that a file path has an allowed format extension.
 *
 * If allowedFormats is undefined or empty, all formats are allowed.
 * Otherwise, the file extension must be in the allowed list.
 *
 * @param path - The file path to validate
 * @param allowedFormats - Optional list of allowed extensions (without dots)
 * @returns Effect that succeeds if format is allowed, fails with UnsupportedFormatError otherwise
 *
 * @example
 * ```ts
 * // Allow only JSON and YAML
 * const result = validateAllowedFormat("./data/books.json", ["json", "yaml"]);
 * // → succeeds
 *
 * const result = validateAllowedFormat("./data/books.toml", ["json", "yaml"]);
 * // → fails with UnsupportedFormatError
 * ```
 */
export function validateAllowedFormat(
	path: string,
	allowedFormats: ReadonlyArray<string> | undefined,
): Effect.Effect<void, UnsupportedFormatError> {
	// If no restrictions, allow all formats
	if (allowedFormats === undefined || allowedFormats.length === 0) {
		return Effect.void;
	}

	const ext = getFileExtension(path);

	// If no extension, let the serializer handle the error
	if (ext === "") {
		return Effect.void;
	}

	// Check if extension is in allowed list (case-insensitive)
	const normalizedAllowed = allowedFormats.map((f) => f.toLowerCase());
	if (normalizedAllowed.includes(ext)) {
		return Effect.void;
	}

	// Format not allowed
	const formattedAllowed = allowedFormats.map((f) => `.${f}`).join(", ");
	return Effect.fail(
		new UnsupportedFormatError({
			format: ext,
			message: `Format '.${ext}' is not allowed. Allowed formats: ${formattedAllowed}`,
		}),
	);
}
