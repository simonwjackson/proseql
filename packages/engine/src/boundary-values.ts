const UNDEFINED_SENTINEL_KEY = "__proseqlUndefined__";
const INTERNAL_UNDEFINED_SENTINEL_KEY = "__proseqlInternalUndefined__";
const ESCAPED_SENTINEL_KEY = "__proseqlEscaped__";

type BoundaryObject = Record<string, unknown>;

type EncodedEscapedEntries = {
	[ESCAPED_SENTINEL_KEY]: ReadonlyArray<readonly [string, unknown]>;
};

const isObject = (value: unknown): value is BoundaryObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasReservedBoundaryKey = (value: BoundaryObject) =>
	Object.prototype.hasOwnProperty.call(value, UNDEFINED_SENTINEL_KEY) ||
	Object.prototype.hasOwnProperty.call(value, ESCAPED_SENTINEL_KEY);

const encodeObjectEntries = (value: BoundaryObject) =>
	Object.entries(value).map(([key, item]) => [key, encodeBoundaryValueForWire(item)] as const);

const isEncodedUndefinedSentinel = (value: BoundaryObject) => {
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === UNDEFINED_SENTINEL_KEY && value[UNDEFINED_SENTINEL_KEY] === 1;
};

const isEncodedEscapedEntries = (value: BoundaryObject): value is EncodedEscapedEntries => {
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== ESCAPED_SENTINEL_KEY) return false;
	const entries = value[ESCAPED_SENTINEL_KEY];
	return (
		Array.isArray(entries) &&
		entries.every(
			(entry) =>
				Array.isArray(entry) &&
				entry.length === 2 &&
				typeof entry[0] === "string",
		)
	);
};

export const encodeBoundaryValueForWire = (value: unknown): unknown => {
	if (value === undefined) {
		return { [UNDEFINED_SENTINEL_KEY]: 1 };
	}
	if (Array.isArray(value)) {
		return value.map((item) => encodeBoundaryValueForWire(item));
	}
	if (!isObject(value)) {
		return value;
	}
	const encodedEntries = encodeObjectEntries(value);
	const encodedObject = Object.fromEntries(encodedEntries);
	if (hasReservedBoundaryKey(value) || isEncodedUndefinedSentinel(encodedObject) || isEncodedEscapedEntries(encodedObject)) {
		return { [ESCAPED_SENTINEL_KEY]: encodedEntries };
	}
	return encodedObject;
};

const decodeBoundaryValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((item) => decodeBoundaryValue(item));
	}
	if (!isObject(value)) {
		return value;
	}
	if (isEncodedUndefinedSentinel(value)) {
		return undefined;
	}
	if (isEncodedEscapedEntries(value)) {
		return Object.fromEntries(
			value[ESCAPED_SENTINEL_KEY].map(([key, item]) => [key, decodeBoundaryValue(item)]),
		);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, decodeBoundaryValue(item)]),
	);
};

export const serializeBoundaryValue = (value: unknown): string =>
	JSON.stringify(encodeBoundaryValueForWire(value));

export const serializeComputedBoundaryValue = (value: unknown): string =>
	value === undefined
		? JSON.stringify({ [INTERNAL_UNDEFINED_SENTINEL_KEY]: 1 })
		: serializeBoundaryValue(value);

export const parseBoundaryJson = (raw: string): unknown =>
	decodeBoundaryValue(JSON.parse(raw));

export const decodeBoundaryValueForHost = <T>(value: T): T =>
	decodeBoundaryValue(value) as T;
