export type IdGeneratorConfig = {
	readonly strategy:
		| "timestamp"
		| "nano"
		| "uuid"
		| "ulid"
		| "prefixed"
		| "typed";
	readonly prefix?: string; // For prefixed strategy
	readonly type?: string; // For typed strategy
	readonly length?: number; // For nano strategy
};
