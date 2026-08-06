export const normalizeComparablePath = (path: string): string => {
	let normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (normalized.startsWith("/")) normalized = normalized.slice(1);
	if (normalized.endsWith("/") && normalized.length > 1) {
		normalized = normalized.slice(0, -1);
	}
	return normalized === "." ? "" : normalized;
};

export const dirnameComparable = (path: string): string => {
	const normalized = normalizeComparablePath(path);
	if (normalized.length === 0) return "";
	const index = normalized.lastIndexOf("/");
	return index === -1 ? "" : normalized.slice(0, index);
};

export const isWithinComparableDirectory = (
	filename: string | null,
	directory: string,
): boolean => {
	if (filename === null) return true;
	const eventPath = normalizeComparablePath(filename);
	const target = normalizeComparablePath(directory);
	return (
		eventPath === target ||
		eventPath.startsWith(target.length === 0 ? "" : `${target}/`)
	);
};

export const matchesComparableFile = (
	filename: string | null,
	file: string,
): boolean => {
	if (filename === null) return true;
	return normalizeComparablePath(filename) === normalizeComparablePath(file);
};
