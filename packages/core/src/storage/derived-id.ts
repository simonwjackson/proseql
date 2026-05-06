import { ValidationError } from "../errors/crud-errors.js";
import type { DerivedIdConfig } from "../types/database-config-types.js";

export type HasId = { readonly id: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const isDerivedIdConfig = (
	config: DerivedIdConfig | undefined,
): config is DerivedIdConfig =>
	config?.kind === "derivedFromKey" && config.field === "id";

export const assertNoPhysicalDerivedId = (
	key: string,
	value: unknown,
	config: DerivedIdConfig | undefined,
	path: string,
): ValidationError | undefined => {
	if (!isDerivedIdConfig(config) || !isRecord(value)) return undefined;

	if (config.field in value) {
		return new ValidationError({
			message: `Derived id field '${config.field}' must not be present in persisted payload '${key}' at '${path}'`,
			issues: [
				{
					field: `${path}.${key}.${config.field}`,
					message:
						"Derived id fields are read from the storage key and must not be duplicated in the payload",
					value: value[config.field],
				},
			],
		});
	}

	return undefined;
};

export const stripDerivedIdField = <T>(
	value: T,
	config: DerivedIdConfig | undefined,
): unknown => {
	if (!isDerivedIdConfig(config) || !isRecord(value)) return value;

	const result: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value)) {
		if (key !== config.field) {
			result[key] = fieldValue;
		}
	}
	return result;
};

export const hydrateDerivedId = <T extends HasId>(
	key: string,
	value: unknown,
	config: DerivedIdConfig | undefined,
): T => {
	if (!isDerivedIdConfig(config)) return value as T;
	if (!isRecord(value)) {
		return { [config.field]: key } as T;
	}
	return { ...value, [config.field]: key } as T;
};

export const requireHydratablePayload = (
	key: string,
	value: unknown,
	config: DerivedIdConfig | undefined,
	path: string,
): ValidationError | undefined => {
	if (!isDerivedIdConfig(config) || isRecord(value)) return undefined;

	return new ValidationError({
		message: `Derived id payload '${key}' at '${path}' must decode to an object`,
		issues: [
			{
				field: `${path}.${key}`,
				message: "Derived id payloads must be object records",
				value,
			},
		],
	});
};
