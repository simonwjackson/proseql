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

export const reconstructBoundaryError = (value: unknown): Error => {
	if (
		typeof value !== "object" ||
		value === null ||
		!("_tag" in value) ||
		typeof value._tag !== "string"
	) {
		return new Error(`Unknown engine error payload: ${JSON.stringify(value)}`);
	}
	const tag = value._tag as KnownTag;
	const Ctor = constructors[tag];
	if (Ctor) {
		return new Ctor(value as never);
	}
	return new Error(`Unknown engine error tag: ${tag}`);
};
