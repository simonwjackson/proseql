const UNDEFINED_SENTINEL_KEY = "__proseqlUndefined__";
const INTERNAL_UNDEFINED_SENTINEL_KEY = "__proseqlInternalUndefined__";
const ESCAPED_SENTINEL_KEY = "__proseqlEscaped__";
const FLOAT64_SENTINEL_KEY = "__proseqlFloat64__";
const ARRAY_HOLE_SENTINEL_KEY = "__proseqlArrayHole__";

type BoundaryObject = Record<string, unknown>;

type EncodedEscapedEntries = {
	[ESCAPED_SENTINEL_KEY]: ReadonlyArray<readonly [string, unknown]>;
};

const isObject = (value: unknown): value is BoundaryObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasReservedBoundaryKey = (value: BoundaryObject) =>
	Object.hasOwn(value, UNDEFINED_SENTINEL_KEY) ||
	Object.hasOwn(value, ESCAPED_SENTINEL_KEY) ||
	Object.hasOwn(value, FLOAT64_SENTINEL_KEY) ||
	Object.hasOwn(value, ARRAY_HOLE_SENTINEL_KEY);

const encodeObjectEntries = (value: BoundaryObject) =>
	Object.entries(value).map(
		([key, item]) => [key, encodeBoundaryValueForWire(item)] as const,
	);

const isEncodedUndefinedSentinel = (value: BoundaryObject) => {
	const keys = Object.keys(value);
	return (
		keys.length === 1 &&
		keys[0] === UNDEFINED_SENTINEL_KEY &&
		value[UNDEFINED_SENTINEL_KEY] === 1
	);
};

const isEncodedEscapedEntries = (
	value: BoundaryObject,
): value is EncodedEscapedEntries => {
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

const isEncodedArrayHole = (value: unknown) =>
	isObject(value) &&
	Object.keys(value).length === 1 &&
	value[ARRAY_HOLE_SENTINEL_KEY] === 1;

const shouldEncodeExactFloat64 = (value: number) =>
	Number.isFinite(value) &&
	(Object.is(value, -0) || !Number.isSafeInteger(value));

const encodeFloat64 = (value: number): BoundaryObject => {
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	view.setFloat64(0, value, false);
	const bytes = new Uint8Array(buffer);
	return {
		[FLOAT64_SENTINEL_KEY]: Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	};
};

const isEncodedFloat64 = (value: BoundaryObject) => {
	const keys = Object.keys(value);
	return (
		keys.length === 1 &&
		keys[0] === FLOAT64_SENTINEL_KEY &&
		typeof value[FLOAT64_SENTINEL_KEY] === "string" &&
		/^[0-9a-f]{16}$/iu.test(value[FLOAT64_SENTINEL_KEY] as string)
	);
};

const decodeFloat64 = (value: BoundaryObject): number => {
	const buffer = new ArrayBuffer(8);
	const bytes = new Uint8Array(buffer);
	const hex = value[FLOAT64_SENTINEL_KEY] as string;
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return new DataView(buffer).getFloat64(0, false);
};

export const encodeBoundaryValueForWire = (value: unknown): unknown => {
	if (value === undefined) {
		return { [UNDEFINED_SENTINEL_KEY]: 1 };
	}
	if (typeof value === "number" && shouldEncodeExactFloat64(value)) {
		return encodeFloat64(value);
	}
	if (Array.isArray(value)) {
		let encoded: unknown[] | undefined;
		for (let index = 0; index < value.length; index += 1) {
			const item =
				index in value
					? encodeBoundaryValueForWire(value[index])
					: { [ARRAY_HOLE_SENTINEL_KEY]: 1 };
			if (encoded !== undefined) {
				encoded.push(item);
			} else if (!(index in value) || item !== value[index]) {
				encoded = value.slice(0, index);
				encoded.push(item);
			}
		}
		return encoded ?? value;
	}
	if (!isObject(value)) {
		return value;
	}
	if (hasReservedBoundaryKey(value)) {
		return { [ESCAPED_SENTINEL_KEY]: encodeObjectEntries(value) };
	}
	let encoded: BoundaryObject | undefined;
	for (const [key, original] of Object.entries(value)) {
		const item = encodeBoundaryValueForWire(original);
		if (encoded !== undefined) {
			Object.defineProperty(encoded, key, {
				value: item,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		} else if (item !== original) {
			encoded = {};
			for (const priorKey of Object.keys(value)) {
				if (priorKey === key) break;
				Object.defineProperty(encoded, priorKey, {
					value: value[priorKey],
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			Object.defineProperty(encoded, key, {
				value: item,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return encoded ?? value;
};

const decodeBoundaryValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		const decoded = new Array(value.length);
		for (let index = 0; index < value.length; index++) {
			if (!isEncodedArrayHole(value[index])) {
				decoded[index] = decodeBoundaryValue(value[index]);
			}
		}
		return decoded;
	}
	if (!isObject(value)) {
		return value;
	}
	if (isEncodedUndefinedSentinel(value)) {
		return undefined;
	}
	if (isEncodedFloat64(value)) {
		return decodeFloat64(value);
	}
	if (isEncodedEscapedEntries(value)) {
		return Object.fromEntries(
			value[ESCAPED_SENTINEL_KEY].map(([key, item]) => [
				key,
				decodeBoundaryValue(item),
			]),
		);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			decodeBoundaryValue(item),
		]),
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
