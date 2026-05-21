import type { SourceRecordOrigin } from "../errors/source-errors.js";

export type RecordOrigin = SourceRecordOrigin;

export type OriginIndex = ReadonlyMap<string, RecordOrigin>;

const originKey = (collection: string, id: string): string =>
	`${collection}\u0000${id}`;

export const emptyOriginIndex = (): OriginIndex =>
	new Map<string, RecordOrigin>();

export const getOrigin = (
	index: OriginIndex,
	collection: string,
	id: string,
): RecordOrigin | undefined => index.get(originKey(collection, id));

export const setOrigin = (
	index: Map<string, RecordOrigin>,
	origin: RecordOrigin,
): void => {
	index.set(originKey(origin.collection, origin.id), origin);
};
