// Alternative implementation of QueryReturnType that might handle complex cases better

import type {
	PopulateConfig,
	SelectConfig,
	ApplyPopulateObject,
	ApplySelectConfig,
	ApplySelectAndPopulate,
} from "./types.js";

// Step 1: Determine what transformations to apply based on config
type DetermineTransform<Config> = {
	hasPopulate: "populate" extends keyof Config ? true : false;
	hasSelect: "select" extends keyof Config ? true : false;
};

// Step 2: Apply transformations in a more explicit way
type ApplyTransform<T, Relations, Config, DB, Transform> = Transform extends {
	hasPopulate: true;
	hasSelect: true;
}
	? Config extends { populate: infer P; select: infer S }
		? P extends PopulateConfig<Relations, DB>
			? S extends SelectConfig<T, Relations, DB>
				? ApplySelectAndPopulate<T, Relations, S, P, DB>
				: T
			: T
		: T
	: Transform extends { hasPopulate: true; hasSelect: false }
		? Config extends { populate: infer P }
			? P extends PopulateConfig<Relations, DB>
				? ApplyPopulateObject<T, Relations, P, DB>
				: T
			: T
		: Transform extends { hasPopulate: false; hasSelect: true }
			? Config extends { select: infer S }
				? S extends SelectConfig<T, Relations, DB>
					? ApplySelectConfig<T, S, Relations, DB>
					: T
				: T
			: T;

// Step 3: New QueryReturnType that uses the two-step process
export type QueryReturnTypeAlternative<T, Relations, Config, DB> =
	AsyncIterable<
		ApplyTransform<T, Relations, Config, DB, DetermineTransform<Config>>
	>;
