import { Data } from "effect";

export type SourceRecordOrigin = {
	readonly sourceId: string;
	readonly path: string;
	readonly collection: string;
	readonly id: string;
};

export class SourceConfigError extends Data.TaggedError("SourceConfigError")<{
	readonly message: string;
	readonly sourceId?: string;
	readonly collection?: string;
	readonly path?: string;
}> {}

export class UnknownCollectionError extends Data.TaggedError(
	"UnknownCollectionError",
)<{
	readonly sourceId: string;
	readonly path: string;
	readonly collection: string;
	readonly message: string;
}> {}

export class DuplicateRecordError extends Data.TaggedError(
	"DuplicateRecordError",
)<{
	readonly collection: string;
	readonly id: string;
	readonly first: SourceRecordOrigin;
	readonly duplicate: SourceRecordOrigin;
	readonly message: string;
}> {}

export class DuplicatePhysicalFileError extends Data.TaggedError(
	"DuplicatePhysicalFileError",
)<{
	readonly sourceId: string;
	readonly path: string;
	readonly message: string;
}> {}

export class InvalidDocumentSourceError extends Data.TaggedError(
	"InvalidDocumentSourceError",
)<{
	readonly sourceId: string;
	readonly path: string;
	readonly message: string;
	readonly collection?: string;
	readonly id?: string;
}> {}

/**
 * Failure loading or building a `documentGraph` source. `kind` distinguishes a
 * transform that returned a `Result` failure (`transform-failure`) from a
 * transform that threw unexpectedly (`transform-defect`) and from structural
 * load/validation failures.
 */
export class DocumentGraphSourceError extends Data.TaggedError(
	"DocumentGraphSourceError",
)<{
	readonly sourceId: string;
	readonly path: string;
	readonly message: string;
	readonly kind:
		| "missing-root"
		| "unsupported-extension"
		| "transform-failure"
		| "transform-defect"
		| "non-object"
		| "unknown-collection"
		| "validation"
		| "migration";
	readonly collection?: string;
	readonly recordId?: string;
	readonly contributingPaths?: ReadonlyArray<string>;
	readonly cause?: unknown;
}> {}

export type SourceError =
	| SourceConfigError
	| UnknownCollectionError
	| DuplicateRecordError
	| DuplicatePhysicalFileError
	| InvalidDocumentSourceError
	| DocumentGraphSourceError;
