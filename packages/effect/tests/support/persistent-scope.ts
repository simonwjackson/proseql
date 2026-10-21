import { Effect, Exit, Scope } from "effect";
import { afterAll } from "vitest";

const scopes = new Set<Scope.Closeable>();

export const openPersistentDatabase = async <A, E>(
	effect: Effect.Effect<A, E, Scope.Scope>,
): Promise<A> => {
	const scope = await Effect.runPromise(Scope.make());
	try {
		const db = await Effect.runPromise(Scope.provide(effect, scope));
		scopes.add(scope);
		return db;
	} catch (error) {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		throw error;
	}
};

afterAll(async () => {
	for (const scope of scopes) {
		await Effect.runPromise(Scope.close(scope, Exit.void));
	}
	scopes.clear();
});
