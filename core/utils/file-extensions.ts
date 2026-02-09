/**
 * File extension utilities for the persistence system.
 * Provides functions to extract and validate file extensions.
 */

import type { SerializerRegistry } from "../serializers/types.js";
import { UnsupportedFormatError } from "../serializers/types.js";

/**
 * Extract the file extension from a file path without the leading dot.
 *
 * @param filePath - The file path to extract extension from
 * @returns The file extension without the dot, or empty string if no extension
 *
 * @example
 * getFileExtension('/path/to/file.json') // returns 'json'
 * getFileExtension('/path/to/file.data.yaml') // returns 'yaml'
 * getFileExtension('/path/to/file') // returns ''
 */
export function getFileExtension(filePath: string): string {
	const lastDotIndex = filePath.lastIndexOf(".");
	const lastSlashIndex = Math.max(
		filePath.lastIndexOf("/"),
		filePath.lastIndexOf("\\"),
	);

	// If there's no dot, or the dot is before the last slash/backslash (part of directory name)
	if (lastDotIndex === -1 || lastDotIndex <= lastSlashIndex) {
		return "";
	}

	return filePath.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Find a serializer for the given file path from the registry.
 *
 * @param filePath - The file path to find a serializer for
 * @param registry - The serializer registry to search
 * @returns The matching serializer
 * @throws {UnsupportedFormatError} If no serializer is found for the file extension
 */
export function findSerializerForFile(
	filePath: string,
	registry: SerializerRegistry,
): SerializerRegistry[string] {
	const extension = getFileExtension(filePath);

	if (!extension) {
		throw new UnsupportedFormatError("", Object.keys(registry));
	}

	const serializer = registry[extension];
	if (!serializer) {
		throw new UnsupportedFormatError(extension, Object.keys(registry));
	}

	return serializer;
}

/**
 * Check if a file extension is valid against a list of allowed extensions.
 *
 * @param extension - The file extension to validate (without dot)
 * @param validExtensions - Array of valid extensions to check against
 * @returns True if the extension is in the valid list, false otherwise
 *
 * @example
 * isValidExtension('json', ['json', 'yaml']) // returns true
 * isValidExtension('txt', ['json', 'yaml']) // returns false
 * isValidExtension('', ['json', 'yaml']) // returns false
 */
export function isValidExtension(
	extension: string,
	validExtensions: readonly string[],
): boolean {
	return extension !== "" && validExtensions.includes(extension);
}

/**
 * Check if a file extension is supported by the given registry.
 *
 * @param filePath - The file path to check
 * @param registry - The serializer registry to check against
 * @returns True if the extension is supported, false otherwise
 */
export function isSupportedExtension(
	filePath: string,
	registry: SerializerRegistry,
): boolean {
	const extension = getFileExtension(filePath);
	return extension !== "" && extension in registry;
}

/**
 * Get all supported file extensions from a serializer registry.
 *
 * @param registry - The serializer registry
 * @returns Array of supported file extensions (without dots)
 */
export function getSupportedExtensions(
	registry: SerializerRegistry,
): readonly string[] {
	return Object.keys(registry);
}

/**
 * Create a serializer registry from an array of serializers.
 * Each serializer's supported extensions are mapped to the serializer instance.
 *
 * @param serializers - Array of serializer instances
 * @returns A registry mapping extensions to serializers
 */
export function createSerializerRegistry(
	serializers: readonly SerializerRegistry[string][],
): SerializerRegistry {
	const registry: Record<string, SerializerRegistry[string]> = {};

	for (const serializer of serializers) {
		for (const extension of serializer.fileExtensions) {
			if (registry[extension]) {
				// If multiple serializers support the same extension, the last one wins
				// This allows for serializer precedence by order of registration
				console.warn(
					`Extension '${extension}' is supported by multiple serializers. Using the last registered one.`,
				);
			}
			registry[extension] = serializer;
		}
	}

	return registry;
}

/**
 * Validate that all provided file paths have supported extensions.
 *
 * @param filePaths - Array of file paths to validate
 * @param registry - The serializer registry to validate against
 * @throws {UnsupportedFormatError} If any file path has an unsupported extension
 */
export function validateFileExtensions(
	filePaths: readonly string[],
	registry: SerializerRegistry,
): void {
	const supportedExtensions = getSupportedExtensions(registry);

	for (const filePath of filePaths) {
		const extension = getFileExtension(filePath);

		if (!extension) {
			throw new UnsupportedFormatError("", supportedExtensions);
		}

		if (!registry[extension]) {
			throw new UnsupportedFormatError(extension, supportedExtensions);
		}
	}
}
