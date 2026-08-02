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

export type CompactMaterializedResultDescriptor =
	| { readonly k: "f"; readonly r: CompactMaterializedRow }
	| { readonly k: "q"; readonly r: ReadonlyArray<CompactMaterializedRow> };

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
	readonly handle: string;
	readonly value: T;
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
			return trackDeep(
				Reflect.get(target, property, receiver),
				markDirty,
				cache,
				countProxy,
			);
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
	private readonly slotByRustSlot = new Map<number, number>();
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

	constructor(snapshot: ProjectionSnapshot) {
		this.replaceAll(snapshot, false);
	}

	get needsResynchronization() {
		return this.invalid;
	}

	get hasDirtyRows() {
		return this.dirtyKeys.size > 0;
	}

	get stats(): MaterializationStats {
		return this.mutableStats;
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

	materializedEntries(collection: string): ReadonlyMap<string, unknown> {
		const entries = new Map<string, unknown>();
		for (let slot = 0; slot < this.slots.length; slot += 1) {
			const row = this.slots[slot];
			if (row?.collection !== collection || !row.hasValue) continue;
			const value = this.resolveValue(slot);
			if (value !== undefined) entries.set(row.id, value);
		}
		return entries;
	}

	cacheAuthoritativeValue(collection: string, id: string, value: unknown) {
		const slot = this.slotById.get(keyOf(collection, id));
		const row = slot === undefined ? undefined : this.slots[slot];
		if (row === undefined) return undefined;
		this.put(collection, { id, handle: row.handle, value });
		const cachedSlot = this.slotById.get(keyOf(collection, id));
		const cached =
			cachedSlot === undefined ? undefined : this.resolveValue(cachedSlot);
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
		this.replaceAll(snapshot, true);
	}

	invalidate() {
		this.invalid = true;
	}

	clear() {
		this.slots.length = 0;
		this.slotById.clear();
		this.slotByRustSlot.clear();
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
		for (const change of sync.changes) {
			if (!change.deleted) continue;
			const existing = this.slotById.get(keyOf(change.collection, change.id));
			if (
				existing === undefined ||
				this.slots[existing]?.handle !== change.handle
			) {
				this.invalidate();
				return;
			}
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
		const started = performance.now();
		this.mutableStats.descriptors += 1;
		this.mutableStats.descriptorBytes += descriptorBytes;
		const value =
			descriptor.kind === "materializedOne"
				? this.materializeRow(collection, descriptor.row)
				: descriptor.rows.map((row) => this.materializeRow(collection, row));
		this.mutableStats.materializationMilliseconds +=
			performance.now() - started;
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
		const slot = this.slotByRustSlot.get(rustSlot);
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

	materializeRustSlot<T>(collection: string, rustSlot: number): T {
		const slot = this.slotByRustSlot.get(rustSlot);
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
		const started = performance.now();
		this.mutableStats.descriptors += 1;
		this.mutableStats.compactDescriptors += 1;
		this.mutableStats.descriptorBytes += descriptorBytes;
		const materialize = (row: CompactMaterializedRow): unknown => {
			if (typeof row === "number") {
				return this.materializeRustSlot(collection, row);
			}
			if (row[0] === null) {
				this.mutableStats.cacheMisses += 1;
				return row[1];
			}
			const [rustSlot, id, value] = row;
			const slot = this.slotByRustSlot.get(rustSlot);
			const metadata = slot === undefined ? undefined : this.slots[slot];
			if (metadata?.collection !== collection || metadata.id !== id) {
				this.mutableStats.cacheMisses += 1;
				this.invalidate();
				throw new StaleMaterializedHandleError(`slot:${rustSlot}`);
			}
			this.put(collection, {
				id,
				handle: metadata.handle,
				value,
				valueBytes: JSON.stringify(value)?.length ?? 0,
			});
			this.mutableStats.cacheMisses += 1;
			const activeSlot = this.slotByRustSlot.get(rustSlot);
			const materialized =
				activeSlot === undefined ? undefined : this.resolveValue(activeSlot);
			if (materialized === undefined) {
				this.invalidate();
				throw new StaleMaterializedHandleError(`slot:${rustSlot}`);
			}
			return materialized;
		};
		const value =
			descriptor.k === "f"
				? materialize(descriptor.r)
				: descriptor.r.map(materialize);
		this.mutableStats.materializationMilliseconds +=
			performance.now() - started;
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
					valueBytes: JSON.stringify(descriptor.value)?.length ?? 0,
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

	private replaceAll(snapshot: ProjectionSnapshot, resynchronization: boolean) {
		this.slots = [];
		this.slotById.clear();
		this.slotByRustSlot.clear();
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

	private put(collection: string, row: ProjectionRow) {
		const key = keyOf(collection, row.id);
		const existing = this.slotById.get(key);
		const target = existing ?? this.freeSlots.pop() ?? this.slots.length;
		const prior = this.slots[target];
		const handleToken = projectionHandleToken(row.handle);
		if (handleToken === undefined) {
			this.invalidate();
			throw new StaleMaterializedHandleError(row.handle);
		}
		const incomingHasValue = ownsValue(row);
		if (!incomingHasValue && prior?.handle === row.handle) return;
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
					if (active?.token === activeToken) {
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
		if (
			prior !== undefined &&
			this.slotByRustSlot.get(prior.rustSlot) === target
		) {
			this.slotByRustSlot.delete(prior.rustSlot);
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
		this.slotByRustSlot.set(handleToken.rustSlot, target);
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
	}

	private pinFastFindValue(row: Slot, value: object) {
		if (this.fastFindPinnedHandles.has(row.handle)) return;
		row.value = value;
		row.weakValue = undefined;
		this.fastFindPinnedHandles.add(row.handle);
		this.fastFindPins.push({ rustSlot: row.rustSlot, handle: row.handle });
		const slot = this.slotByRustSlot.get(row.rustSlot);
		if (slot !== undefined) {
			const candidate: FastFindCandidate = {
				collection: row.collection,
				id: row.id,
				slot,
				rustSlot: row.rustSlot,
				generation: row.generation,
				revision: row.revision,
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
			const slot = this.slotByRustSlot.get(evicted.rustSlot);
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
		if (
			prior !== undefined &&
			this.slotByRustSlot.get(prior.rustSlot) === slot
		) {
			this.slotByRustSlot.delete(prior.rustSlot);
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
	return kind === "f" || kind === "q";
};
