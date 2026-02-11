import { matchesFilter } from "../../types/operators.js";

// Type guard to check if where clause is a valid object
export function isValidWhereClause(
	where: unknown,
): where is Record<string, unknown> {
	return where !== null && typeof where === "object" && !Array.isArray(where);
}

// Helper function to filter data based on where clause
export function filterData<T extends Record<string, unknown>>(
	data: T[],
	where: unknown,
	allData?: Record<string, unknown[]>,
	relationships?: Record<
		string,
		{ type: string; target: string; foreignKey?: string }
	>,
	collectionName?: string,
	config?: Record<
		string,
		{
			relationships: Record<
				string,
				{ type: string; target: string; foreignKey?: string }
			>;
		}
	>,
): T[] {
	if (!where || !isValidWhereClause(where)) return data;

	return data.filter((item) => {
		let shouldInclude = true;

		for (const [key, value] of Object.entries(where)) {
			// Handle conditional logic operators
			if (key === "$or") {
				if (!Array.isArray(value)) {
					shouldInclude = false;
					break;
				}
				// OR: at least one condition must be true
				// Empty array means no conditions to match, so it's false
				if ((value as unknown[]).length === 0) {
					shouldInclude = false;
					break;
				}
				const orResults = (value as unknown[]).map((condition) => {
					if (!isValidWhereClause(condition)) return false;
					const filtered = filterData(
						[item],
						condition,
						allData,
						relationships,
						collectionName,
						config,
					);
					return filtered.length > 0;
				});
				if (!orResults.some((result) => result === true)) {
					shouldInclude = false;
					break;
				}
			} else if (key === "$and") {
				if (!Array.isArray(value)) {
					shouldInclude = false;
					break;
				}
				// AND: all conditions must be true
				// Empty array means all conditions are true (vacuous truth)
				if ((value as unknown[]).length === 0) {
					continue;
				}
				const andResults = (value as unknown[]).map((condition) => {
					if (!isValidWhereClause(condition)) return false;
					const filtered = filterData(
						[item],
						condition,
						allData,
						relationships,
						collectionName,
						config,
					);
					return filtered.length > 0;
				});
				if (!andResults.every((result) => result === true)) {
					shouldInclude = false;
					break;
				}
			} else if (key === "$not") {
				if (!isValidWhereClause(value)) {
					shouldInclude = false;
					break;
				}
				// NOT: condition must be false
				const filtered = filterData(
					[item],
					value,
					allData,
					relationships,
					collectionName,
					config,
				);
				if (filtered.length > 0) {
					shouldInclude = false;
					break;
				}
			} else if (
				relationships &&
				relationships[key] &&
				allData &&
				collectionName &&
				config
			) {
				// Handle relationship filtering
				const relationship = relationships[key];
				const targetData = allData[relationship.target] as
					| Record<string, unknown>[]
					| undefined;

				if (relationship.type === "ref") {
					// For ref relationships, find the related item
					const foreignKeyField = relationship.foreignKey || key + "Id";
					const relatedItem = targetData?.find((target) => {
						if (!isValidWhereClause(target)) return false;
						return target.id === item[foreignKeyField];
					});

					if (!relatedItem) {
						// If no related item and we have a filter, it doesn't match
						if (
							value &&
							typeof value === "object" &&
							Object.keys(value).length > 0
						) {
							shouldInclude = false;
							break;
						}
						continue;
					}

					// Recursively filter the related item
					const targetConfig = config[relationship.target];
					if (targetConfig && isValidWhereClause(relatedItem)) {
						const filtered = filterData(
							[relatedItem],
							value,
							allData,
							targetConfig.relationships,
							relationship.target,
							config,
						);
						if (filtered.length === 0) {
							shouldInclude = false;
							break;
						}
					}
				} else if (relationship.type === "inverse") {
					// For inverse relationships, find all related items
					// Find multiple related items where they reference this item
					// The foreign key is based on the collection name (e.g., 'userId' for 'users' collection)
					const foreignKeyField =
						relationship.foreignKey ||
						(collectionName ? `${collectionName.replace(/s$/, "")}Id` : "id");
					const relatedItems =
						targetData?.filter((target) => {
							if (!isValidWhereClause(target)) return false;
							return target[foreignKeyField] === item.id;
						}) || [];

					// Handle array operators
					if (value && typeof value === "object") {
						const operators = value as Record<string, unknown>;
						const targetConfig = config[relationship.target];

						if ("$some" in operators && targetConfig) {
							// At least one related item must match
							const someMatch = relatedItems.some((relItem) => {
								if (!isValidWhereClause(relItem)) return false;
								const filtered = filterData(
									[relItem],
									operators.$some,
									allData,
									targetConfig.relationships,
									relationship.target,
									config,
								);
								return filtered.length > 0;
							});
							if (!someMatch) {
								shouldInclude = false;
								break;
							}
						}

						if ("$every" in operators && targetConfig) {
							// All related items must match (or no related items)
							if (relatedItems.length === 0) continue;
							const everyMatch = relatedItems.every((relItem) => {
								if (!isValidWhereClause(relItem)) return false;
								const filtered = filterData(
									[relItem],
									operators.$every,
									allData,
									targetConfig.relationships,
									relationship.target,
									config,
								);
								return filtered.length > 0;
							});
							if (!everyMatch) {
								shouldInclude = false;
								break;
							}
						}

						if ("$none" in operators && targetConfig) {
							// No related items should match
							const noneMatch = relatedItems.some((relItem) => {
								if (!isValidWhereClause(relItem)) return false;
								const filtered = filterData(
									[relItem],
									operators.$none,
									allData,
									targetConfig.relationships,
									relationship.target,
									config,
								);
								return filtered.length > 0;
							});
							if (noneMatch) {
								shouldInclude = false;
								break;
							}
						}
					}
				}
			} else if (key in item) {
				// Handle regular field filtering
				if (!matchesFilter(item[key], value)) {
					shouldInclude = false;
					break;
				}
			} else {
				// If the field doesn't exist in the item
				if (isValidWhereClause(value)) {
					const ops = value;
					if ("$eq" in ops && ops.$eq === undefined) {
						// Looking for items where field equals undefined (doesn't exist)
						continue;
					} else if ("$ne" in ops && ops.$ne === undefined) {
						// Looking for items where field doesn't equal undefined (doesn't exist)
						shouldInclude = false;
						break;
					}
					// For operator-based filters on non-existent fields, it doesn't match
					const operatorKeys = [
						"$eq",
						"$ne",
						"$in",
						"$nin",
						"$gt",
						"$gte",
						"$lt",
						"$lte",
						"$startsWith",
						"$endsWith",
						"$contains",
						"$all",
						"$size",
						"$search",
					];
					const logicalOperatorKeys = ["$or", "$and", "$not"];
					const hasOperators = Object.keys(ops).some((key) =>
						operatorKeys.includes(key),
					);
					const hasLogicalOperators = Object.keys(ops).some((key) =>
						logicalOperatorKeys.includes(key),
					);
					if (hasOperators || hasLogicalOperators) {
						shouldInclude = false;
						break;
					}
				}
				// For direct equality on a non-existent field:
				// If looking for undefined, it matches (field doesn't exist = undefined)
				// Otherwise, it doesn't match
				if (value !== undefined) {
					shouldInclude = false;
					break;
				}
			}

			if (!shouldInclude) break;
		}

		return shouldInclude;
	});
}
