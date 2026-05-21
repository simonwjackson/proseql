/**
 * Path utilities for file operations.
 */

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

export function normalizePath(path: string): string {
	const isAbsolute = path.startsWith("/");
	const parts: string[] = [];
	for (const part of path.replace(/\\/g, "/").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			const previous = parts.at(-1);
			if (previous !== undefined && previous !== "..") {
				parts.pop();
			} else if (!isAbsolute) {
				parts.push(part);
			}
			continue;
		}
		parts.push(part);
	}
	const normalized = parts.join("/");
	if (isAbsolute) return normalized.length === 0 ? "/" : `/${normalized}`;
	return normalized.length === 0 ? "." : normalized;
}

export function joinPath(root: string, path: string): string {
	if (path.startsWith("/")) return normalizePath(path);
	return normalizePath(`${root.replace(/\/$/, "")}/${path}`);
}
