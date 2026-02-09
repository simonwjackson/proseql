import type {
	DeleteOptions,
	DeleteManyOptions,
} from "../../core/types/crud-types";

/**
 * Helper to create soft delete options with proper type inference
 */
export function softDeleteOptions<
	T extends { deletedAt?: string | null | undefined },
>(options: { soft: true; returnDeleted?: boolean }): DeleteOptions<T> {
	return options as DeleteOptions<T>;
}

/**
 * Helper to create soft delete many options with proper type inference
 */
export function softDeleteManyOptions<
	T extends { deletedAt?: string | null | undefined },
>(options: {
	soft: true;
	returnDeleted?: boolean;
	limit?: number;
}): DeleteManyOptions<T> {
	return options as DeleteManyOptions<T>;
}
