import type { DocumentGraphSourceError } from "../errors/source-errors.js";
export type DocumentGraphDiagnosticAction =
	| "skipped-fragment"
	| "skipped-root"
	| "ignored-collection";

export interface DocumentGraphDiagnostic {
	readonly sourceId: string;
	readonly rootId: string;
	readonly path?: string;
	readonly action: DocumentGraphDiagnosticAction;
	readonly collection?: string;
	readonly recordId?: string;
	readonly message: string;
	readonly error?: DocumentGraphSourceError;
}

export interface DocumentGraphRecordContribution {
	readonly sourceId: string;
	readonly rootId: string;
	readonly path: string;
	readonly collection: string;
	readonly id: string;
}

export interface DocumentGraphRecordProvenance {
	readonly sourceId: string;
	readonly collection: string;
	readonly id: string;
	readonly contributors: ReadonlyArray<DocumentGraphRecordContribution>;
	readonly effectiveContributor: DocumentGraphRecordContribution;
}
