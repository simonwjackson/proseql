import {
	CollectionNotFoundError,
	ConcurrencyError,
	DanglingReferenceError,
	DocumentGraphSourceError,
	DuplicateKeyError,
	DuplicatePhysicalFileError,
	DuplicateRecordError,
	ForeignKeyError,
	HookError,
	InvalidDocumentSourceError,
	MigrationError,
	NotFoundError,
	OperationError,
	PluginError,
	PopulationError,
	SerializationError,
	SourceConfigError,
	StorageError,
	TransactionError,
	UniqueConstraintError,
	UnknownCollectionError,
	UnsupportedFormatError,
	ValidationError,
} from "@proseql/core";

export class WasmEngineDefectError extends Error {
	readonly name = "WasmEngineDefectError";
}

const constructors = {
	NotFoundError,
	DuplicateKeyError,
	ForeignKeyError,
	ValidationError,
	UniqueConstraintError,
	ConcurrencyError,
	OperationError,
	TransactionError,
	HookError,
	DanglingReferenceError,
	CollectionNotFoundError,
	PopulationError,
	StorageError,
	SerializationError,
	UnsupportedFormatError,
	SourceConfigError,
	UnknownCollectionError,
	DuplicateRecordError,
	DuplicatePhysicalFileError,
	InvalidDocumentSourceError,
	DocumentGraphSourceError,
	MigrationError,
	PluginError,
} as const;

type KnownTag = keyof typeof constructors;

type CallbackDefectPayload = {
	readonly _tag: "OperationError" | "HookError";
	readonly reason?: string;
	readonly message?: string;
};

const hasCallbackDefectReason = (reason: unknown): boolean =>
	typeof reason === "string" &&
	(reason === "callback-defect" ||
		reason === "js-exception" ||
		reason.includes('reason: "callback-defect"') ||
		reason.includes('reason: "js-exception"'));

const isCallbackDefectPayload = (
	value: unknown,
): value is CallbackDefectPayload =>
	typeof value === "object" &&
	value !== null &&
	("_tag" in value
		? (value as { readonly _tag?: unknown })._tag === "OperationError" ||
			(value as { readonly _tag?: unknown })._tag === "HookError"
		: false) &&
	("reason" in value
		? hasCallbackDefectReason((value as { readonly reason?: unknown }).reason)
		: false);

export const reconstructBoundaryError = (value: unknown): Error => {
	if (
		typeof value !== "object" ||
		value === null ||
		!("_tag" in value) ||
		typeof value._tag !== "string"
	) {
		return new Error(`Unknown engine error payload: ${JSON.stringify(value)}`);
	}
	if (isCallbackDefectPayload(value)) {
		return new WasmEngineDefectError(
			value.message ?? `Unexpected callback defect: ${JSON.stringify(value)}`,
		);
	}
	const tag = value._tag as KnownTag;
	const Ctor = constructors[tag];
	if (Ctor) {
		return new Ctor(value as never);
	}
	return new Error(`Unknown engine error tag: ${tag}`);
};
