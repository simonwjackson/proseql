export type MaterializedRowDescriptor = {
	readonly id?: string;
	readonly handle?: string;
	readonly value?: unknown;
};

export type MaterializedResultDescriptor =
	| {
			readonly kind: "materializedOne";
			readonly row: MaterializedRowDescriptor;
	  }
	| {
			readonly kind: "materializedMany";
			readonly rows: ReadonlyArray<MaterializedRowDescriptor>;
	  };

type CompactMaterializedRow =
	| number
	| readonly [number, string, unknown]
	| readonly [null, unknown];

type CompactPopulatePlan = readonly [
	name: string,
	collection: string,
	kind: 0 | 1 | 2 | 3,
	nested?: ReadonlyArray<CompactPopulatePlan>,
];

type CompactPopulatedRelation =
	| null
	| CompactMaterializedRow
	| CompactPopulatedNode
	| ReadonlyArray<CompactMaterializedRow | CompactPopulatedNode>;

type CompactPopulatedNode = readonly [
	CompactMaterializedRow,
	ReadonlyArray<CompactPopulatedRelation>,
];

export type CompactMaterializedResultDescriptor =
	| { readonly k: "f"; readonly r: CompactMaterializedRow }
	| { readonly k: "q"; readonly r: ReadonlyArray<CompactMaterializedRow> }
	| {
			readonly k: "p";
			readonly p: ReadonlyArray<CompactPopulatePlan>;
			readonly r: ReadonlyArray<CompactPopulatedNode>;
	  }
	| {
			readonly k: "c";
			readonly o: number;
			readonly l: number;
			readonly t: number;
			readonly v: number;
			readonly a?: ReadonlyArray<readonly [number, CompactMaterializedRow]>;
	  };

export type ProjectionHandles = {
	readonly collections: Readonly<
		Record<
			string,
			ReadonlyArray<{ readonly id: string; readonly handle: string }>
		>
	>;
};

export type ProjectionSnapshot = ProjectionHandles;

type ProjectionRow = {
	readonly id: string;
	readonly handle: string;
	readonly resultId?: string;
	readonly position?: number;
	readonly value?: unknown;
	readonly valueBytes?: number;
};

type ProjectionChange =
	| {
			readonly collection: string;
			readonly id: string;
			readonly handle: string;
			readonly deleted: true;
	  }
	| (ProjectionRow & {
			readonly collection: string;
			readonly deleted?: false;
	  });

export type ProjectionSync = {
	readonly changes: ReadonlyArray<ProjectionChange>;
	readonly resetCollections?: Readonly<
		Record<string, ReadonlyArray<ProjectionRow>>
	>;
	readonly invalidated?: boolean;
};

type Slot = {
	readonly collection: string;
	readonly id: string;
	readonly handle: string;
	readonly rustSlot: number;
	readonly generation: number;
	readonly revision: number;
	hasValue: boolean;
	value?: unknown;
	weakValue?: WeakRef<object>;
	readonly valueBytes: number;
	proxyCount: number;
	readonly token?: number;
};

export type DirtyProjectionRow = {
	readonly collection: string;
	readonly id: string;
	readonly handle: string;
	readonly value: unknown;
};

export type MaterializationStats = {
	readonly descriptors: number;
	readonly compactDescriptors: number;
	readonly fastFindHits: number;
	readonly fastFindFallbacks: number;
	readonly fastPinnedRows: number;
	readonly descriptorBytes: number;
	readonly cacheHits: number;
	readonly cacheMisses: number;
	readonly resynchronizations: number;
	readonly fullValueBytesAvoided: number;
	readonly materializationMilliseconds: number;
	readonly materializedRows: number;
	readonly trackedProxies: number;
	readonly retainedStrongRows: number;
	readonly retainedStrongProxies: number;
	readonly peakMaterializedRows: number;
	readonly peakTrackedProxies: number;
};

const keyOf = (collection: string, id: string) => `${collection}\u0000${id}`;
const ownsValue = (value: object) => Object.hasOwn(value, "value");
const FAST_FIND_PIN_LIMIT = 256;

type FastFindPin = {
	readonly rustSlot: number;
	readonly handle: string;
};

export type FastFindCandidate<T = unknown> = {
	readonly collection: string;
	readonly id: string;
	readonly slot: number;
	readonly rustSlot: number;
	readonly generation: number;
	readonly revision: number;
	readonly authorizationBase: number;
	readonly handle: string;
	readonly value: T;
};

export type AuthorizedBulkCandidates<T = unknown> = {
	readonly rows: ReadonlyArray<FastFindCandidate<T>>;
	readonly slots: Uint32Array;
	readonly projectionSlots: Uint32Array;
	readonly authorizationBases: Float64Array;
};

type ProjectionHandleToken = {
	readonly rustSlot: number;
	readonly generation: number;
	readonly revision: number;
};

const projectionHandleToken = (
	handle: string,
): ProjectionHandleToken | undefined => {
	const parts = handle.split(":");
	if (parts.length !== 3) return undefined;
	const [rustSlot, generation, revision] = parts.map(Number);
	if (
		![rustSlot, generation, revision].every(
			(part) => Number.isInteger(part) && part >= 0 && part <= 0xffff_ffff,
		)
	) {
		return undefined;
	}
	return { rustSlot, generation, revision };
};

const trackDeep = (
	value: unknown,
	markDirty: () => void,
	cache: WeakMap<object, unknown>,
	countProxy: () => void,
): unknown => {
	if (typeof value !== "object" || value === null) return value;
	const cached = cache.get(value);
	if (cached !== undefined) return cached;
	const proxy = new Proxy(value, {
		get(target, property, receiver) {
			const nested = Reflect.get(target, property, receiver);
			return typeof nested === "object" && nested !== null
				? trackDeep(nested, markDirty, cache, countProxy)
				: nested;
		},
		set(target, property, next, receiver) {
			const changed = !Object.is(Reflect.get(target, property, receiver), next);
			const applied = Reflect.set(target, property, next, receiver);
			if (applied && changed) markDirty();
			return applied;
		},
		deleteProperty(target, property) {
			const existed = Reflect.has(target, property);
			const applied = Reflect.deleteProperty(target, property);
			if (applied && existed) markDirty();
			return applied;
		},
		defineProperty(target, property, descriptor) {
			const applied = Reflect.defineProperty(target, property, descriptor);
			if (applied) markDirty();
			return applied;
		},
	});
	cache.set(value, proxy);
	countProxy();
	return proxy;
};

export class MaterializedProjection {
	private slots: Array<Slot | undefined> = [];
	private readonly slotById = new Map<string, number>();
	private slotByRustSlot = new Int32Array(0);
	private readonly rustSlotByCollectionPosition = new Map<string, Int32Array>();
	private readonly canonicalRowsByCollection = new Map<
		string,
		{ readonly revision: number; readonly rows: ReadonlyArray<unknown> }
	>();
	private readonly pendingCanonicalInsertions = new Map<
		string,
		{ readonly collection: string; readonly position: number }
	>();
	private readonly freeSlots: number[] = [];
	private readonly dirtyKeys = new Set<string>();
	private readonly fastFindPins: FastFindPin[] = [];
	private readonly fastFindPinnedHandles = new Set<string>();
	private readonly fastFindCandidates = new Map<
		string,
		Map<string, FastFindCandidate>
	>();
	private readonly fastFindCandidateByHandle = new Map<
		string,
		FastFindCandidate
	>();
	private invalid = false;
	private preserveValuesOnResync = false;
	private authoritativePatchDepth = 0;
	private pendingAuthorizedBulk?:
		| {
				readonly kind: "update";
				readonly collection: string;
				readonly candidates: AuthorizedBulkCandidates;
				readonly changed: ReadonlyArray<boolean>;
				readonly collectionRevision: number;
		  }
		| {
				readonly kind: "delete";
				readonly collection: string;
				readonly ids: ReadonlyArray<string>;
				readonly projectionSlots: Uint32Array;
				readonly rustSlots: Uint32Array;
				readonly collectionRevision: number;
		  };
	private readonly metadataFallback?: MaterializedProjection;
	private nextProxyToken = 1;
	private mutableStats = {
		descriptors: 0,
		compactDescriptors: 0,
		fastFindHits: 0,
		fastFindFallbacks: 0,
		fastPinnedRows: 0,
		descriptorBytes: 0,
		cacheHits: 0,
		cacheMisses: 0,
		resynchronizations: 0,
		fullValueBytesAvoided: 0,
		materializationMilliseconds: 0,
		materializedRows: 0,
		trackedProxies: 0,
		peakMaterializedRows: 0,
		peakTrackedProxies: 0,
	};

	constructor(
		snapshot: ProjectionSnapshot,
		metadataFallback?: MaterializedProjection,
	) {
		this.metadataFallback = metadataFallback;
		this.replaceAll(snapshot, false);
	}

	get needsResynchronization() {
		this.reconcileAuthorizedBulk();
		return this.invalid;
	}

	get canPreserveValuesOnResync() {
		return this.preserveValuesOnResync;
	}

	isCollectionFullyMaterialized(collection: string): boolean {
		let found = false;
		for (const slot of this.slots) {
			if (slot?.collection !== collection) continue;
			found = true;
			if (!slot.hasValue) return false;
		}
		return found;
	}

	get hasDirtyRows() {
		return this.dirtyKeys.size > 0;
	}

	get stats(): MaterializationStats {
		const retained = new Set<object>();
		for (const canonical of this.canonicalRowsByCollection.values()) {
			for (const row of canonical.rows) {
				if (typeof row === "object" && row !== null) retained.add(row);
			}
		}
		for (const slot of this.slots) {
			if (typeof slot?.value === "object" && slot.value !== null)
				retained.add(slot.value);
		}
		if (this.pendingAuthorizedBulk?.kind === "update") {
			for (const candidate of this.pendingAuthorizedBulk.candidates.rows) {
				if (typeof candidate.value === "object" && candidate.value !== null)
					retained.add(candidate.value);
			}
		}
		return {
			...this.mutableStats,
			retainedStrongRows: retained.size,
			retainedStrongProxies: retained.size,
		};
	}

	get dirtyRows(): ReadonlyArray<DirtyProjectionRow> {
		return [...this.dirtyKeys].flatMap((key) => {
			const slot = this.slotById.get(key);
			const row = slot === undefined ? undefined : this.slots[slot];
			const value = row?.value;
			return row?.hasValue && value !== undefined
				? [
						{
							collection: row.collection,
							id: row.id,
							handle: row.handle,
							value,
						},
					]
				: [];
		});
	}

	fastCanonicalRangeCandidate<T>(
		collection: string,
		offset: number,
		limit?: number,
	):
		| { readonly revision: number; readonly rows: ReadonlyArray<T> }
		| undefined {
		const cached = this.canonicalRowsByCollection.get(collection);
		if (cached === undefined) return undefined;
		const end = Math.min(
			cached.rows.length,
			offset + (limit ?? cached.rows.length),
		);
		return {
			revision: cached.revision,
			rows: cached.rows.slice(
				Math.min(offset, cached.rows.length),
				end,
			) as ReadonlyArray<T>,
		};
	}

	acceptAuthorizedFastRange<T>(rows: ReadonlyArray<T>): ReadonlyArray<T> {
		this.mutableStats.cacheHits += rows.length;
		return rows;
	}

	fastFindCandidate<T>(
		collection: string,
		id: string,
	): FastFindCandidate<T> | undefined {
		const pinned = this.fastFindCandidates.get(collection)?.get(id);
		if (pinned !== undefined) return pinned as FastFindCandidate<T>;
		const slot = this.slotById.get(keyOf(collection, id));
		if (slot === undefined) return undefined;
		const row = this.slots[slot];
		const value = this.resolveValue(slot);
		return row?.collection === collection && value !== undefined
			? {
					collection,
					id,
					slot,
					rustSlot: row.rustSlot,
					generation: row.generation,
					revision: row.revision,
					authorizationBase:
						row.generation < 2 ** 21 && row.revision < 2 ** 21
							? row.generation * 2 ** 21 + row.revision
							: -1,
					handle: row.handle,
					value: value as T,
				}
			: undefined;
	}

	canFastFind(collection: string, id: string): boolean {
		return this.fastFindCandidate(collection, id) !== undefined;
	}

	materializedValue(collection: string, id: string): unknown {
		const slot = this.slotById.get(keyOf(collection, id));
		if (slot === undefined) return undefined;
		return this.resolveValue(slot);
	}

	canonicalMaterializedRows<T>(
		collection: string,
	): ReadonlyArray<T> | undefined {
		const canonical = this.canonicalRowsByCollection.get(collection);
		if (canonical !== undefined) return canonical.rows as ReadonlyArray<T>;
		const positions = this.rustSlotByCollectionPosition.get(collection);
		if (positions === undefined) return undefined;
		const rows = new Array<T>(positions.length);
		for (let index = 0; index < positions.length; index += 1) {
			const slot = this.rustSlotIndex(positions[index]!);
			const value = slot === undefined ? undefined : this.resolveValue(slot);
			if (value === undefined) return undefined;
			rows[index] = value as T;
		}
		return rows;
	}

	authorizedBulkCandidates<T>(
		collection: string,
		ids: ReadonlyArray<string>,
		expectedRows?: ReadonlyArray<T>,
	): AuthorizedBulkCandidates<T> | undefined {
		if (
			ids.length === 0 ||
			(expectedRows && expectedRows.length !== ids.length)
		)
			return undefined;
		const rows: FastFindCandidate<T>[] = [];
		const slots = new Uint32Array(ids.length);
		const projectionSlots = new Uint32Array(ids.length);
		const authorizationBases = new Float64Array(ids.length);
		for (let index = 0; index < ids.length; index += 1) {
			const candidate = this.fastFindCandidate<T>(collection, ids[index]!);
			if (
				candidate === undefined ||
				candidate.authorizationBase < 0 ||
				(expectedRows !== undefined &&
					!Object.is(candidate.value, expectedRows[index]))
			)
				return undefined;
			rows.push(candidate);
			slots[index] = candidate.rustSlot;
			projectionSlots[index] = candidate.slot;
			authorizationBases[index] = candidate.authorizationBase;
		}
		return { rows, slots, projectionSlots, authorizationBases };
	}

	applyAuthorizedBulkUpdate<T>(
		collection: string,
		candidates: AuthorizedBulkCandidates<T>,
		count: number,
		collectionRevision: number,
		patch: Readonly<Record<string, unknown>>,
	): { readonly count: number; readonly updated: T[] } {
		if (count !== candidates.rows.length)
			throw new StaleMaterializedHandleError("authorized-bulk-update");
		const changed = candidates.rows.map((candidate) =>
			Object.entries(patch).some(
				([field, value]) =>
					!Object.is(
						(candidate.value as Record<string, unknown>)[field],
						value,
					),
			),
		);
		this.authoritativePatchDepth += 1;
		try {
			for (const candidate of candidates.rows) {
				Object.assign(candidate.value as object, patch);
				this.dirtyKeys.delete(keyOf(collection, candidate.id));
			}
		} finally {
			this.authoritativePatchDepth -= 1;
		}
		this.invalid = true;
		this.pendingAuthorizedBulk = {
			kind: "update",
			collection,
			candidates,
			changed,
			collectionRevision,
		};
		return {
			count,
			updated: candidates.rows.map((candidate) => candidate.value),
		};
	}

	applyAuthorizedBulkDelete<T>(
		collection: string,
		candidates: AuthorizedBulkCandidates<T>,
		ids: ReadonlyArray<string>,
		count: number,
		collectionRevision: number,
	): { readonly count: number; readonly deleted: T[] } {
		if (
			count !== candidates.rows.length ||
			ids.length !== candidates.rows.length
		)
			throw new StaleMaterializedHandleError("authorized-bulk-delete");
		this.invalid = true;
		this.pendingAuthorizedBulk = {
			kind: "delete",
			collection,
			ids,
			projectionSlots: candidates.projectionSlots,
			rustSlots: candidates.slots,
			collectionRevision,
		};
		return {
			count,
			deleted: candidates.rows.map((candidate) => candidate.value),
		};
	}

	/**
	 * Finalize the small authorized delta, then discard every strong structural
	 * row cache before returning control to user code. Caller-owned result rows
	 * remain alive naturally; projection slots retain only WeakRefs.
	 */
	releaseAuthorizedBulkStructure(collection: string) {
		const pending = this.pendingAuthorizedBulk;
		if (pending === undefined || pending.collection !== collection) {
			this.releaseStrongStructure(collection);
			return;
		}
		if (pending.kind === "delete") {
			// Keep only id/slot metadata until the next command. Structural position
			// repair is intentionally deferred out of the mutation's critical path.
			this.invalid = true;
			this.preserveValuesOnResync = false;
			return;
		}
		this.pendingAuthorizedBulk = undefined;
		this.clearFastFindPins();
		for (let index = 0; index < pending.candidates.rows.length; index += 1) {
			const candidate = pending.candidates.rows[index]!;
			const current = this.slots[candidate.slot];
			if (
				current?.handle !== candidate.handle ||
				current.collection !== collection
			) {
				this.preserveValuesOnResync = true;
				this.invalid = true;
				this.releaseStrongStructure(collection);
				return;
			}
			const revision = current.revision + (pending.changed[index] ? 1 : 0);
			this.slots[candidate.slot] = {
				...current,
				handle: `${current.rustSlot}:${current.generation}:${revision}`,
				revision,
			};
		}
		this.invalid = false;
	}

	releaseStrongStructure(collection: string) {
		this.canonicalRowsByCollection.delete(collection);
		for (const [key, insertion] of this.pendingCanonicalInsertions) {
			if (insertion.collection === collection)
				this.pendingCanonicalInsertions.delete(key);
		}
		this.clearFastFindPins();
	}

	releaseAllStrongStructures() {
		this.canonicalRowsByCollection.clear();
		this.pendingCanonicalInsertions.clear();
		this.clearFastFindPins();
	}

	cacheAuthoritativeValue(collection: string, id: string, value: unknown) {
		const key = keyOf(collection, id);
		const slot = this.slotById.get(key);
		const row = slot === undefined ? undefined : this.slots[slot];
		if (row === undefined) return undefined;
		const cached = this.put(collection, { id, handle: row.handle, value });
		const insertion = this.pendingCanonicalInsertions.get(key);
		if (cached !== undefined && insertion !== undefined) {
			this.pendingCanonicalInsertions.delete(key);
			const rows = this.canonicalRowsByCollection.get(collection)?.rows as
				| unknown[]
				| undefined;
			rows?.splice(Math.min(insertion.position, rows.length), 0, cached);
		}
		return cached === undefined
			? undefined
			: { value: cached, handle: row.handle };
	}

	markSynchronized(rows: ReadonlyArray<DirtyProjectionRow>) {
		for (const row of rows) {
			const key = keyOf(row.collection, row.id);
			const slot = this.slotById.get(key);
			const current = slot === undefined ? undefined : this.slots[slot];
			if (current?.handle === row.handle) {
				this.dirtyKeys.delete(key);
				if (
					!this.fastFindPinnedHandles.has(current.handle) &&
					typeof current.value === "object" &&
					current.value !== null
				) {
					current.weakValue = new WeakRef(current.value);
					current.value = undefined;
				}
			}
		}
	}

	resynchronize(snapshot: ProjectionSnapshot) {
		if (this.preserveValuesOnResync) {
			this.replaceAllPreservingValues(snapshot);
			return;
		}
		this.replaceAll(snapshot, true);
	}

	private reconcileAuthorizedBulk() {
		const pending = this.pendingAuthorizedBulk;
		if (pending === undefined) return;
		this.pendingAuthorizedBulk = undefined;
		this.clearFastFindPins();
		if (pending.kind === "update") {
			for (let index = 0; index < pending.candidates.rows.length; index += 1) {
				const candidate = pending.candidates.rows[index]!;
				const current = this.slots[candidate.slot];
				if (
					current?.handle !== candidate.handle ||
					current.collection !== pending.collection
				) {
					this.preserveValuesOnResync = true;
					return;
				}
				const revision = current.revision + (pending.changed[index] ? 1 : 0);
				this.slots[candidate.slot] = {
					...current,
					handle: `${current.rustSlot}:${current.generation}:${revision}`,
					revision,
				};
			}
			const canonical = this.canonicalRowsByCollection.get(pending.collection);
			if (canonical !== undefined)
				(canonical as { revision: number }).revision =
					pending.collectionRevision;
			this.invalid = false;
			return;
		}
		const canonical = this.canonicalRowsByCollection.get(pending.collection);
		const positions = this.rustSlotByCollectionPosition.get(pending.collection);
		const start = (positions?.length ?? 0) - pending.rustSlots.length;
		let suffix = positions !== undefined && start >= 0;
		for (let index = 0; suffix && index < pending.rustSlots.length; index += 1)
			suffix = positions![start + index] === pending.rustSlots[index];
		for (let index = 0; index < pending.ids.length; index += 1) {
			const slot = pending.projectionSlots[index]!;
			const current = this.slots[slot];
			if (
				current?.rustSlot !== pending.rustSlots[index] ||
				current.collection !== pending.collection ||
				current.id !== pending.ids[index]
			) {
				this.preserveValuesOnResync = true;
				return;
			}
			this.remove(keyOf(pending.collection, current.id), slot);
		}
		if (
			suffix &&
			canonical !== undefined &&
			positions !== undefined &&
			canonical.rows.length === positions.length
		) {
			(canonical.rows as unknown[]).splice(start, pending.rustSlots.length);
			(canonical as { revision: number }).revision = pending.collectionRevision;
		} else {
			this.canonicalRowsByCollection.delete(pending.collection);
		}
		if (positions !== undefined) {
			if (suffix) {
				this.rustSlotByCollectionPosition.set(
					pending.collection,
					positions.subarray(0, start),
				);
			} else {
				const deletedSlots = new Set(pending.rustSlots);
				const retained = new Int32Array(
					positions.length - pending.rustSlots.length,
				);
				let retainedIndex = 0;
				for (const rustSlot of positions) {
					if (!deletedSlots.has(rustSlot)) retained[retainedIndex++] = rustSlot;
				}
				if (retainedIndex !== retained.length) {
					this.preserveValuesOnResync = true;
					return;
				}
				this.rustSlotByCollectionPosition.set(pending.collection, retained);
			}
		}
		this.preserveValuesOnResync = false;
		this.invalid = false;
	}

	invalidate() {
		this.pendingAuthorizedBulk = undefined;
		this.invalid = true;
		this.preserveValuesOnResync = false;
		this.releaseAllStrongStructures();
	}

	clear() {
		this.pendingAuthorizedBulk = undefined;
		this.preserveValuesOnResync = false;
		this.slots.length = 0;
		this.slotById.clear();
		this.clearRustSlotIndexes();
		this.rustSlotByCollectionPosition.clear();
		this.canonicalRowsByCollection.clear();
		this.pendingCanonicalInsertions.clear();
		this.freeSlots.length = 0;
		this.dirtyKeys.clear();
		this.clearFastFindPins();
		this.mutableStats.materializedRows = 0;
		this.mutableStats.trackedProxies = 0;
		this.invalid = true;
	}

	apply(sync: ProjectionSync) {
		if (sync.invalidated) {
			this.invalidate();
			return;
		}
		const structurallyChanged = new Set<string>();
		const changedCollections = new Set<string>();
		const changesByCollection = new Map<string, ProjectionChange[]>();
		for (const change of sync.changes) {
			changedCollections.add(change.collection);
			const grouped = changesByCollection.get(change.collection) ?? [];
			grouped.push(change);
			changesByCollection.set(change.collection, grouped);
			if (change.deleted) {
				const existing = this.slotById.get(keyOf(change.collection, change.id));
				if (
					existing === undefined ||
					this.slots[existing]?.handle !== change.handle
				) {
					this.invalidate();
					return;
				}
			}
			if (
				change.deleted ||
				("position" in change &&
					typeof (change as { readonly position?: unknown }).position ===
						"number")
			) {
				structurallyChanged.add(change.collection);
			}
		}
		const preservedInsertions = new Set<string>();
		for (const [collection, changes] of changesByCollection) {
			const canonical = this.canonicalRowsByCollection.get(collection);
			const positions = this.rustSlotByCollectionPosition.get(collection);
			const insertions = changes.flatMap((change) => {
				const token = projectionHandleToken(change.handle);
				const position = change.deleted ? undefined : change.position;
				return !change.deleted &&
					token !== undefined &&
					typeof position === "number" &&
					this.slotById.get(keyOf(collection, change.id)) === undefined
					? [{ change, token, position }]
					: [];
			});
			if (positions !== undefined && insertions.length === changes.length) {
				preservedInsertions.add(collection);
				if (canonical !== undefined)
					(canonical as { revision: number }).revision += insertions.length;
				const next = Array.from(positions);
				for (const { change, token, position } of insertions.sort(
					(left, right) => left.position - right.position,
				)) {
					next.splice(Math.min(position, next.length), 0, token.rustSlot);
					this.pendingCanonicalInsertions.set(keyOf(collection, change.id), {
						collection,
						position,
					});
				}
				this.rustSlotByCollectionPosition.set(
					collection,
					Int32Array.from(next),
				);
			} else {
				this.canonicalRowsByCollection.delete(collection);
			}
		}
		for (const collection of structurallyChanged) {
			if (!preservedInsertions.has(collection))
				this.rustSlotByCollectionPosition.delete(collection);
		}
		for (const [collection, rows] of Object.entries(
			sync.resetCollections ?? {},
		)) {
			for (const [key, slot] of this.slotById) {
				if (key.startsWith(`${collection}\u0000`)) this.remove(key, slot);
			}
			for (const row of rows) this.put(collection, row);
		}
		for (const change of sync.changes) {
			const key = keyOf(change.collection, change.id);
			if (change.deleted) {
				const existing = this.slotById.get(key);
				if (existing === undefined) {
					this.invalidate();
					return;
				}
				this.remove(key, existing);
			} else {
				this.put(change.collection, change);
			}
		}
	}

	materialize<T>(
		collection: string,
		descriptor: MaterializedResultDescriptor,
		descriptorBytes: number,
	): T {
		this.mutableStats.descriptors += 1;
		this.mutableStats.descriptorBytes += descriptorBytes;
		const value =
			descriptor.kind === "materializedOne"
				? this.materializeRow(collection, descriptor.row)
				: descriptor.rows.map((row) => this.materializeRow(collection, row));
		return value as T;
	}

	recordFastFindFallback() {
		this.mutableStats.fastFindFallbacks += 1;
	}

	acceptAuthorizedFastFind<T>(candidate: FastFindCandidate<T>): T {
		const row = this.slots[candidate.slot];
		this.mutableStats.fastFindHits += 1;
		this.mutableStats.cacheHits += 1;
		this.mutableStats.fullValueBytesAvoided += row?.valueBytes ?? 0;
		if (
			row !== undefined &&
			typeof candidate.value === "object" &&
			candidate.value !== null
		) {
			this.pinFastFindValue(row, candidate.value);
		}
		return candidate.value;
	}

	materializeFastFindRustSlot<T>(collection: string, rustSlot: number): T {
		const slot = this.rustSlotIndex(rustSlot);
		const row = slot === undefined ? undefined : this.slots[slot];
		const candidate =
			row === undefined
				? undefined
				: this.fastFindCandidate<T>(collection, row.id);
		if (candidate === undefined) {
			this.mutableStats.cacheMisses += 1;
			throw new StaleMaterializedHandleError(`slot:${rustSlot}`);
		}
		if (candidate.rustSlot !== rustSlot) {
			this.mutableStats.cacheMisses += 1;
			throw new StaleMaterializedHandleError(`slot:${rustSlot}`);
		}
		return this.acceptAuthorizedFastFind(candidate);
	}

	materializeRustSlots<T>(
		collection: string,
		rustSlots: Uint32Array,
	): ReadonlyArray<T> {
		const values = new Array<T>(rustSlots.length);
		for (let index = 0; index < rustSlots.length; index += 1) {
			const rustSlot = rustSlots[index];
			if (rustSlot === undefined) {
				throw new StaleMaterializedHandleError(`slot:${index}`);
			}
			values[index] = this.materializeRustSlot(collection, rustSlot);
		}
		return values;
	}

	materializeRustSlot<T>(collection: string, rustSlot: number): T {
		const slot = this.rustSlotIndex(rustSlot);
		const row = slot === undefined ? undefined : this.slots[slot];
		const value = slot === undefined ? undefined : this.resolveValue(slot);
		if (row?.collection === collection && value !== undefined) {
			this.mutableStats.cacheHits += 1;
			this.mutableStats.fullValueBytesAvoided += row.valueBytes;
			return value as T;
		}
		this.mutableStats.cacheMisses += 1;
		throw new StaleMaterializedHandleError(`slot:${rustSlot}`);
	}

	materializeCompact<T>(
		collection: string,
		descriptor: CompactMaterializedResultDescriptor,
		descriptorBytes: number,
	): T {
		this.mutableStats.descriptors += 1;
		this.mutableStats.compactDescriptors += 1;
		this.mutableStats.descriptorBytes += descriptorBytes;
		const materialize = (
			rowCollection: string,
			row: CompactMaterializedRow,
		): unknown => {
			if (typeof row === "number") {
				return this.materializeRustSlot(rowCollection, row);
			}
			if (row[0] === null) {
				this.mutableStats.cacheMisses += 1;
				return row[1];
			}
			const [rustSlot, id, value] = row;
			let slot = this.rustSlotIndex(rustSlot);
			let metadata = slot === undefined ? undefined : this.slots[slot];
			if (metadata === undefined) {
				const fallbackSlot = this.metadataFallback?.rustSlotIndex(rustSlot);
				const fallback =
					fallbackSlot === undefined
						? undefined
						: this.metadataFallback?.slots[fallbackSlot];
				if (fallback?.collection === rowCollection && fallback.id === id) {
					this.put(rowCollection, { id, handle: fallback.handle });
					slot = this.rustSlotIndex(rustSlot);
					metadata = slot === undefined ? undefined : this.slots[slot];
				}
			}
			if (metadata?.collection !== rowCollection || metadata.id !== id) {
				this.mutableStats.cacheMisses += 1;
				this.invalidate();
				throw new StaleMaterializedHandleError(`slot:${rustSlot}`);
			}
			this.put(rowCollection, {
				id,
				handle: metadata.handle,
				value,
				valueBytes: 0,
			});
			this.mutableStats.cacheMisses += 1;
			const activeSlot = this.rustSlotIndex(rustSlot);
			const materialized =
				activeSlot === undefined ? undefined : this.resolveValue(activeSlot);
			if (materialized === undefined) {
				this.invalidate();
				throw new StaleMaterializedHandleError(`slot:${rustSlot}`);
			}
			return materialized;
		};
		let value: unknown;
		if (descriptor.k === "f") {
			value = materialize(collection, descriptor.r);
		} else if (descriptor.k === "q") {
			value = descriptor.r.map((row) => materialize(collection, row));
		} else if (descriptor.k === "p") {
			const materializeNode = (
				nodeCollection: string,
				plan: ReadonlyArray<CompactPopulatePlan>,
				node: CompactPopulatedNode,
			): unknown => {
				const source = materialize(nodeCollection, node[0]);
				if (typeof source !== "object" || source === null) return source;
				const output = { ...(source as Record<string, unknown>) };
				for (let index = 0; index < plan.length; index += 1) {
					const entry = plan[index];
					if (entry === undefined) continue;
					const [name, target, kind, nested = []] = entry;
					const relation = node[1][index];
					const inverse = (kind & 2) !== 0;
					const nestedPopulate = (kind & 1) !== 0;
					let relationValue: unknown;
					if (inverse) {
						relationValue = (
							relation as ReadonlyArray<
								CompactMaterializedRow | CompactPopulatedNode
							>
						).map((row) =>
							nestedPopulate
								? materializeNode(target, nested, row as CompactPopulatedNode)
								: materialize(target, row as CompactMaterializedRow),
						);
					} else if (relation === null || relation === undefined) {
						relationValue = undefined;
					} else if (!nestedPopulate) {
						relationValue = materialize(
							target,
							relation as CompactMaterializedRow,
						);
					} else {
						relationValue = materializeNode(
							target,
							nested,
							relation as CompactPopulatedNode,
						);
					}
					Object.defineProperty(output, name, {
						value: relationValue,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				}
				return output;
			};
			value = descriptor.r.map((node) =>
				materializeNode(collection, descriptor.p, node),
			);
		} else {
			const cachedCanonical =
				descriptor.o === 0 && descriptor.l === descriptor.t
					? this.canonicalRowsByCollection.get(collection)
					: undefined;
			if (
				cachedCanonical?.revision === descriptor.v &&
				descriptor.a === undefined
			) {
				value = cachedCanonical.rows.slice();
				this.mutableStats.cacheHits += cachedCanonical.rows.length;
				return value as T;
			}
			let positions = this.rustSlotByCollectionPosition.get(collection);
			if (positions === undefined) {
				positions = new Int32Array(descriptor.t);
				positions.fill(-1);
				this.rustSlotByCollectionPosition.set(collection, positions);
			}
			for (const [position, row] of descriptor.a ?? []) {
				materialize(collection, row);
				if (typeof row === "number") positions[position] = row;
				else if (row[0] !== null) positions[position] = row[0];
			}
			const rows: unknown[] = [];
			for (let index = 0; index < descriptor.l; index += 1) {
				const position = descriptor.o + index;
				const rustSlot = positions[position];
				if (rustSlot === undefined || rustSlot < 0) {
					this.mutableStats.cacheMisses += 1;
					this.invalidate();
					throw new StaleMaterializedHandleError(`position:${position}`);
				}
				rows.push(this.materializeRustSlot(collection, rustSlot));
			}
			if (descriptor.o === 0 && descriptor.l === descriptor.t) {
				this.canonicalRowsByCollection.set(collection, {
					revision: descriptor.v,
					rows: rows.slice(),
				});
			}
			value = rows;
		}
		return value as T;
	}

	private materializeRow(
		collection: string,
		descriptor: MaterializedRowDescriptor,
	): unknown {
		if (descriptor.handle !== undefined && descriptor.id !== undefined) {
			const key = keyOf(collection, descriptor.id);
			const slot = this.slotById.get(key);
			const row = slot === undefined ? undefined : this.slots[slot];
			if (row?.handle !== descriptor.handle) {
				this.mutableStats.cacheMisses += 1;
				this.invalidate();
				throw new StaleMaterializedHandleError(descriptor.handle);
			}
			if (ownsValue(descriptor)) {
				this.put(collection, {
					id: descriptor.id,
					handle: descriptor.handle,
					value: descriptor.value,
					valueBytes: 0,
				});
				this.mutableStats.cacheMisses += 1;
			}
			const activeSlot = this.slotById.get(key);
			const value =
				activeSlot === undefined ? undefined : this.resolveValue(activeSlot);
			if (value !== undefined) {
				if (!ownsValue(descriptor)) {
					this.mutableStats.cacheHits += 1;
					this.mutableStats.fullValueBytesAvoided += row.valueBytes;
				}
				return value;
			}
			this.mutableStats.cacheMisses += 1;
			this.invalidate();
			throw new StaleMaterializedHandleError(descriptor.handle);
		}
		this.mutableStats.cacheMisses += 1;
		return descriptor.value;
	}

	private replaceAllPreservingValues(snapshot: ProjectionSnapshot) {
		const parsed = Object.entries(snapshot.collections).flatMap(
			([collection, rows]) =>
				rows.map((row) => ({
					collection,
					row,
					token: projectionHandleToken(row.handle),
				})),
		);
		if (parsed.some(({ token }) => token === undefined)) {
			this.preserveValuesOnResync = false;
			this.replaceAll(snapshot, true);
			return;
		}
		const oldById = new Map(this.slotById);
		const retained = new Map<string, number>();
		for (const { collection, row } of parsed) {
			const key = keyOf(collection, row.id);
			const slot = oldById.get(key);
			if (slot !== undefined && this.slots[slot] !== undefined) {
				retained.set(key, slot);
			}
		}
		this.clearFastFindPins();
		this.slotById.clear();
		this.clearRustSlotIndexes();
		this.rustSlotByCollectionPosition.clear();
		this.canonicalRowsByCollection.clear();
		this.pendingCanonicalInsertions.clear();
		this.freeSlots.length = 0;
		this.dirtyKeys.clear();
		const retainedSlots = new Set(retained.values());
		for (let slot = 0; slot < this.slots.length; slot += 1) {
			if (retainedSlots.has(slot)) continue;
			const prior = this.slots[slot];
			if (prior?.hasValue) {
				this.mutableStats.materializedRows = Math.max(
					0,
					this.mutableStats.materializedRows - 1,
				);
				this.mutableStats.trackedProxies = Math.max(
					0,
					this.mutableStats.trackedProxies - prior.proxyCount,
				);
			}
			this.slots[slot] = undefined;
			this.freeSlots.push(slot);
		}
		const positions = new Map<string, number[]>();
		for (const { collection, row, token } of parsed) {
			const parsedToken = token!;
			const key = keyOf(collection, row.id);
			const retainedSlot = retained.get(key);
			if (retainedSlot === undefined) {
				this.put(collection, row);
			} else {
				const prior = this.slots[retainedSlot]!;
				this.slots[retainedSlot] = {
					...prior,
					handle: row.handle,
					rustSlot: parsedToken.rustSlot,
					generation: parsedToken.generation,
					revision: parsedToken.revision,
				};
				this.slotById.set(key, retainedSlot);
				this.setRustSlotIndex(parsedToken.rustSlot, retainedSlot);
			}
			const collectionPositions = positions.get(collection) ?? [];
			collectionPositions.push(parsedToken.rustSlot);
			positions.set(collection, collectionPositions);
		}
		for (const [collection, slots] of positions) {
			this.rustSlotByCollectionPosition.set(collection, Int32Array.from(slots));
		}
		this.invalid = false;
		this.preserveValuesOnResync = false;
		this.mutableStats.resynchronizations += 1;
	}

	private replaceAll(snapshot: ProjectionSnapshot, resynchronization: boolean) {
		this.preserveValuesOnResync = false;
		this.slots = [];
		this.slotById.clear();
		this.clearRustSlotIndexes();
		this.rustSlotByCollectionPosition.clear();
		this.canonicalRowsByCollection.clear();
		this.pendingCanonicalInsertions.clear();
		this.freeSlots.length = 0;
		this.dirtyKeys.clear();
		this.clearFastFindPins();
		this.mutableStats.materializedRows = 0;
		this.mutableStats.trackedProxies = 0;
		for (const [collection, rows] of Object.entries(snapshot.collections)) {
			for (const row of rows) this.put(collection, row);
		}
		this.invalid = false;
		if (resynchronization) this.mutableStats.resynchronizations += 1;
	}

	private resolveValue(slot: number): unknown {
		const row = this.slots[slot];
		if (!row?.hasValue) return undefined;
		if (row.value !== undefined) return row.value;
		const value = row.weakValue?.deref();
		if (value !== undefined) return value;
		row.hasValue = false;
		row.weakValue = undefined;
		this.mutableStats.materializedRows = Math.max(
			0,
			this.mutableStats.materializedRows - 1,
		);
		this.mutableStats.trackedProxies = Math.max(
			0,
			this.mutableStats.trackedProxies - row.proxyCount,
		);
		row.proxyCount = 0;
		return undefined;
	}

	private rustSlotIndex(rustSlot: number): number | undefined {
		if (rustSlot < 0 || rustSlot >= this.slotByRustSlot.length)
			return undefined;
		const slot = this.slotByRustSlot[rustSlot];
		return slot === undefined || slot < 0 ? undefined : slot;
	}

	private setRustSlotIndex(rustSlot: number, slot: number) {
		if (rustSlot >= this.slotByRustSlot.length) {
			const capacity = Math.max(
				16,
				rustSlot + 1,
				this.slotByRustSlot.length * 2,
			);
			const expanded = new Int32Array(capacity);
			expanded.fill(-1);
			expanded.set(this.slotByRustSlot);
			this.slotByRustSlot = expanded;
		}
		this.slotByRustSlot[rustSlot] = slot;
	}

	private deleteRustSlotIndex(rustSlot: number) {
		if (rustSlot >= 0 && rustSlot < this.slotByRustSlot.length) {
			this.slotByRustSlot[rustSlot] = -1;
		}
	}

	private clearRustSlotIndexes() {
		this.slotByRustSlot = new Int32Array(0);
	}

	private put(collection: string, row: ProjectionRow) {
		const key = keyOf(collection, row.id);
		const existing = this.slotById.get(key);
		const target = existing ?? this.freeSlots.pop() ?? this.slots.length;
		const prior = this.slots[target];
		const incomingHasValue = ownsValue(row);
		if (!incomingHasValue && prior?.handle === row.handle) return undefined;
		if (incomingHasValue && prior?.handle === row.handle && !prior.hasValue) {
			const token = this.nextProxyToken++;
			const activeToken = token;
			let installed = false;
			let proxyCount = 0;
			let trackedValue: unknown;
			trackedValue = trackDeep(
				row.value,
				() => {
					const active = this.slots[target];
					if (
						active?.token === activeToken &&
						this.authoritativePatchDepth === 0
					) {
						this.dirtyKeys.add(key);
						active.value = trackedValue;
						active.weakValue = undefined;
					}
				},
				new WeakMap<object, unknown>(),
				() => {
					proxyCount += 1;
					const active = this.slots[target];
					if (installed && active?.token === activeToken) {
						active.proxyCount += 1;
						this.mutableStats.trackedProxies += 1;
					}
				},
			);
			const weakValue =
				typeof trackedValue === "object" && trackedValue !== null
					? new WeakRef(trackedValue)
					: undefined;
			this.slots[target] = {
				...prior,
				hasValue: true,
				value: weakValue === undefined ? trackedValue : undefined,
				weakValue,
				valueBytes: row.valueBytes ?? 0,
				proxyCount,
				token,
			};
			installed = true;
			this.dirtyKeys.delete(key);
			this.mutableStats.materializedRows += 1;
			this.mutableStats.trackedProxies += proxyCount;
			this.mutableStats.peakMaterializedRows = Math.max(
				this.mutableStats.peakMaterializedRows,
				this.mutableStats.materializedRows,
			);
			this.mutableStats.peakTrackedProxies = Math.max(
				this.mutableStats.peakTrackedProxies,
				this.mutableStats.trackedProxies,
			);
			return trackedValue;
		}
		const handleToken = projectionHandleToken(row.handle);
		if (handleToken === undefined) {
			this.invalidate();
			throw new StaleMaterializedHandleError(row.handle);
		}
		let trackedValue: unknown;
		let valueBytes = 0;
		let proxyCount = 0;
		let token: number | undefined;
		let installed = false;
		if (incomingHasValue) {
			const proxyCache = new WeakMap<object, unknown>();
			token = this.nextProxyToken;
			this.nextProxyToken += 1;
			const activeToken = token;
			trackedValue = trackDeep(
				row.value,
				() => {
					const active = this.slots[target];
					if (
						active?.token === activeToken &&
						this.authoritativePatchDepth === 0
					) {
						this.dirtyKeys.add(key);
						active.value = trackedValue;
						active.weakValue = undefined;
					}
				},
				proxyCache,
				() => {
					proxyCount += 1;
					const active = this.slots[target];
					if (installed && active?.token === activeToken) {
						active.proxyCount += 1;
						this.mutableStats.trackedProxies += 1;
						this.mutableStats.peakTrackedProxies = Math.max(
							this.mutableStats.peakTrackedProxies,
							this.mutableStats.trackedProxies,
						);
					}
				},
			);
			valueBytes = row.valueBytes ?? 0;
		}
		if (prior !== undefined && this.rustSlotIndex(prior.rustSlot) === target) {
			this.deleteRustSlotIndex(prior.rustSlot);
		}
		if (prior !== undefined) this.unpinFastFindHandle(prior.handle);
		if (prior?.hasValue) {
			this.mutableStats.materializedRows = Math.max(
				0,
				this.mutableStats.materializedRows - 1,
			);
			this.mutableStats.trackedProxies = Math.max(
				0,
				this.mutableStats.trackedProxies - prior.proxyCount,
			);
		}
		const weakValue =
			typeof trackedValue === "object" && trackedValue !== null
				? new WeakRef(trackedValue)
				: undefined;
		this.slots[target] = {
			collection,
			id: row.id,
			handle: row.handle,
			rustSlot: handleToken.rustSlot,
			generation: handleToken.generation,
			revision: handleToken.revision,
			hasValue: incomingHasValue,
			value: weakValue === undefined ? trackedValue : undefined,
			weakValue,
			valueBytes,
			proxyCount,
			token,
		};
		installed = true;
		this.slotById.set(key, target);
		this.setRustSlotIndex(handleToken.rustSlot, target);
		this.dirtyKeys.delete(key);
		if (incomingHasValue) {
			this.mutableStats.materializedRows += 1;
			this.mutableStats.trackedProxies += proxyCount;
			this.mutableStats.peakMaterializedRows = Math.max(
				this.mutableStats.peakMaterializedRows,
				this.mutableStats.materializedRows,
			);
			this.mutableStats.peakTrackedProxies = Math.max(
				this.mutableStats.peakTrackedProxies,
				this.mutableStats.trackedProxies,
			);
		}
		return incomingHasValue ? trackedValue : undefined;
	}

	private pinFastFindValue(row: Slot, value: object) {
		if (this.fastFindPinnedHandles.has(row.handle)) return;
		row.value = value;
		row.weakValue = undefined;
		this.fastFindPinnedHandles.add(row.handle);
		this.fastFindPins.push({ rustSlot: row.rustSlot, handle: row.handle });
		const slot = this.rustSlotIndex(row.rustSlot);
		if (slot !== undefined) {
			const candidate: FastFindCandidate = {
				collection: row.collection,
				id: row.id,
				slot,
				rustSlot: row.rustSlot,
				generation: row.generation,
				revision: row.revision,
				authorizationBase:
					row.generation < 2 ** 21 && row.revision < 2 ** 21
						? row.generation * 2 ** 21 + row.revision
						: -1,
				handle: row.handle,
				value,
			};
			let collectionCandidates = this.fastFindCandidates.get(row.collection);
			if (collectionCandidates === undefined) {
				collectionCandidates = new Map();
				this.fastFindCandidates.set(row.collection, collectionCandidates);
			}
			collectionCandidates.set(row.id, candidate);
			this.fastFindCandidateByHandle.set(row.handle, candidate);
		}
		while (this.fastFindPinnedHandles.size > FAST_FIND_PIN_LIMIT) {
			const evicted = this.fastFindPins.shift();
			if (
				evicted === undefined ||
				!this.fastFindPinnedHandles.delete(evicted.handle)
			) {
				continue;
			}
			this.removeFastFindCandidate(evicted.handle);
			const slot = this.rustSlotIndex(evicted.rustSlot);
			const current = slot === undefined ? undefined : this.slots[slot];
			if (
				current?.handle === evicted.handle &&
				!this.dirtyKeys.has(keyOf(current.collection, current.id)) &&
				typeof current.value === "object" &&
				current.value !== null
			) {
				current.weakValue = new WeakRef(current.value);
				current.value = undefined;
			}
		}
		this.mutableStats.fastPinnedRows = this.fastFindPinnedHandles.size;
	}

	private removeFastFindCandidate(handle: string) {
		const candidate = this.fastFindCandidateByHandle.get(handle);
		if (candidate === undefined) return;
		this.fastFindCandidateByHandle.delete(handle);
		const collectionCandidates = this.fastFindCandidates.get(
			candidate.collection,
		);
		if (collectionCandidates?.get(candidate.id)?.handle === handle) {
			collectionCandidates.delete(candidate.id);
			if (collectionCandidates.size === 0) {
				this.fastFindCandidates.delete(candidate.collection);
			}
		}
	}

	private unpinFastFindHandle(handle: string) {
		if (!this.fastFindPinnedHandles.delete(handle)) return;
		const queued = this.fastFindPins.findIndex((pin) => pin.handle === handle);
		if (queued >= 0) this.fastFindPins.splice(queued, 1);
		this.removeFastFindCandidate(handle);
		this.mutableStats.fastPinnedRows = this.fastFindPinnedHandles.size;
	}

	private clearFastFindPins() {
		for (const pin of this.fastFindPins) {
			const slot = this.rustSlotIndex(pin.rustSlot);
			const current = slot === undefined ? undefined : this.slots[slot];
			if (
				current?.handle === pin.handle &&
				!this.dirtyKeys.has(keyOf(current.collection, current.id)) &&
				typeof current.value === "object" &&
				current.value !== null
			) {
				current.weakValue = new WeakRef(current.value);
				current.value = undefined;
			}
		}
		this.fastFindPins.length = 0;
		this.fastFindPinnedHandles.clear();
		this.fastFindCandidates.clear();
		this.fastFindCandidateByHandle.clear();
		this.mutableStats.fastPinnedRows = 0;
	}

	private remove(key: string, slot: number) {
		const prior = this.slots[slot];
		if (prior?.hasValue) {
			this.mutableStats.materializedRows -= 1;
			this.mutableStats.trackedProxies -= prior.proxyCount;
		}
		this.slots[slot] = undefined;
		this.slotById.delete(key);
		if (prior !== undefined && this.rustSlotIndex(prior.rustSlot) === slot) {
			this.deleteRustSlotIndex(prior.rustSlot);
		}
		if (prior !== undefined) this.unpinFastFindHandle(prior.handle);
		this.dirtyKeys.delete(key);
		this.freeSlots.push(slot);
	}
}

export class StaleMaterializedHandleError extends Error {
	constructor(readonly handle: string) {
		super(`Stale materialized row handle '${handle}'`);
		this.name = "StaleMaterializedHandleError";
	}
}

export const projectionSnapshotFromHandles = (
	handles: ProjectionHandles,
): ProjectionSnapshot => handles;

export const isMaterializedResultDescriptor = (
	value: unknown,
): value is MaterializedResultDescriptor => {
	if (typeof value !== "object" || value === null || !("kind" in value))
		return false;
	const kind = (value as { readonly kind?: unknown }).kind;
	return kind === "materializedOne" || kind === "materializedMany";
};

export const isCompactMaterializedResultDescriptor = (
	value: unknown,
): value is CompactMaterializedResultDescriptor => {
	if (typeof value !== "object" || value === null || !("k" in value)) {
		return false;
	}
	const kind = (value as { readonly k?: unknown }).k;
	return kind === "f" || kind === "q" || kind === "p" || kind === "c";
};
