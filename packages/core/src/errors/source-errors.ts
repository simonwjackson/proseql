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

export type SourceError =
	| SourceConfigError
	| UnknownCollectionError
	| DuplicateRecordError
	| DuplicatePhysicalFileError
	| InvalidDocumentSourceError;
