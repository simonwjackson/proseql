import { isValidWhereClause } from "../query/filter.js";
import { applyObjectSelection } from "../query/select.js";

// Types for better type safety
type RelationshipType = "ref" | "inverse";

interface Relationship {
	type: RelationshipType;
	target: string;
	foreignKey?: string;
}

interface CollectionConfig {
	relationships: Record<string, Relationship>;
}

export type PopulateValue = boolean | Record<string, unknown>;

// Type guard for populate config objects
export function isPopulateConfig(
	value: unknown,
): value is Record<string, PopulateValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Type guard to check if value is a record
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Type guard for string arrays
function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

// Type guard for selection config
type SelectionConfig = Record<string, unknown> | readonly string[];
function isSelectionConfig(value: unknown): value is SelectionConfig {
	return isStringArray(value) || isRecord(value);
}

// Safe extraction of nested populate configuration
function extractNestedConfig(value: Record<string, unknown>): {
	select?: SelectionConfig;
	nestedPopulate: Record<string, PopulateValue>;
} {
	const { select, populate, ...otherProps } = value;

	const validNestedPopulate: Record<string, PopulateValue> = {};

	// Safely copy otherProps that are valid PopulateValue types
	for (const [key, value] of Object.entries(otherProps)) {
		if (typeof value === "boolean" || isRecord(value)) {
			validNestedPopulate[key] = value as PopulateValue;
		}
	}

	// Safely merge populate if it's valid
	if (isPopulateConfig(populate)) {
		for (const [key, value] of Object.entries(populate)) {
			if (typeof value === "boolean" || isRecord(value)) {
				validNestedPopulate[key] = value as PopulateValue;
			}
		}
	}

	const result: {
		select?: SelectionConfig;
		nestedPopulate: Record<string, PopulateValue>;
	} = {
		nestedPopulate: validNestedPopulate,
	};

	if (isSelectionConfig(select)) {
		result.select = select;
	}

	return result;
}

// Helper function to find a single related item
function findRelatedItem(
	item: Record<string, unknown>,
	foreignKeyField: string,
	targetData: unknown[] | undefined,
): Record<string, unknown> | undefined {
	if (!targetData || !isValidWhereClause(item)) return undefined;

	return targetData.find((target): target is Record<string, unknown> => {
		if (!isValidWhereClause(target)) return false;
		return target.id === item[foreignKeyField];
	});
}

// Helper function to find multiple related items
function findRelatedItems(
	item: Record<string, unknown>,
	foreignKeyField: string,
	targetData: unknown[] | undefined,
): Record<string, unknown>[] {
	if (!targetData || !isValidWhereClause(item)) return [];

	return targetData.filter((target): target is Record<string, unknown> => {
		if (!isValidWhereClause(target)) return false;
		return target[foreignKeyField] === item.id;
	});
}

// Helper function to apply populate configuration recursively
export function applyPopulate<T extends Record<string, unknown>>(
	item: T,
	populateConfig: Record<string, PopulateValue>,
	allData: Record<string, unknown[]>,
	relationships: Record<string, Relationship>,
	collectionName: string,
	config: Record<string, CollectionConfig>,
): T {
	const populated = { ...item };

	for (const [key, value] of Object.entries(populateConfig)) {
		const relationship = relationships[key];
		if (!relationship) continue;

		const targetData = allData[relationship.target];

		if (relationship.type === "ref") {
			// Handle ref relationships
			const foreignKeyField = relationship.foreignKey || key + "Id";
			const relatedItem = findRelatedItem(
				populated,
				foreignKeyField,
				targetData,
			);

			if (relatedItem && value === true) {
				Object.assign(populated, { [key]: relatedItem });
			} else if (relatedItem && isPopulateConfig(value)) {
				// Recursively populate nested config
				const targetConfig = config[relationship.target];
				if (targetConfig) {
					// Extract nested populate config and select from value safely
					const { select, nestedPopulate } = extractNestedConfig(value);

					// Apply nested population first
					let populatedRelated = relatedItem;
					if (Object.keys(nestedPopulate).length > 0) {
						populatedRelated = applyPopulate(
							relatedItem,
							nestedPopulate,
							allData,
							targetConfig.relationships,
							relationship.target,
							config,
						);
					}

					// Apply field selection if specified (supports both array and object-based)
					if (select) {
						let selectedFields: Record<string, unknown>;
						if (isStringArray(select)) {
							// Convert array to object format
							const objectSelect: Record<string, boolean> = {};
							for (const field of select) {
								objectSelect[field] = true;
							}
							selectedFields = applyObjectSelection(
								populatedRelated,
								objectSelect,
							);
						} else if (isRecord(select)) {
							selectedFields = applyObjectSelection(populatedRelated, select);
						} else {
							// Invalid select format, skip selection
							selectedFields = populatedRelated;
						}

						// For object-based selection, the nested fields are already handled by applyObjectSelection
						// For array-based selection, preserve any populated fields that are defined in relationships
						let finalResult = selectedFields;

						if (isStringArray(select)) {
							// Only for array-based selection, we need to preserve populated relationships
							finalResult = { ...selectedFields };

							// Check relationships in the target config to know which fields are populated
							for (const [relKey, relDef] of Object.entries(
								targetConfig.relationships,
							)) {
								if (nestedPopulate[relKey] && relKey in populatedRelated) {
									finalResult[relKey] = populatedRelated[relKey];
								}
							}
						}

						populatedRelated = finalResult;
					}

					Object.assign(populated, { [key]: populatedRelated });
				}
			} else {
				Object.assign(populated, { [key]: undefined });
			}
		} else if (relationship.type === "inverse") {
			// Handle inverse relationships
			// For inverse relationships, we need to find items in the target collection
			// that have a foreign key pointing back to this collection

			// First, check if there's a specific foreignKey configured
			let foreignKeyField: string;
			if (relationship.foreignKey) {
				foreignKeyField = relationship.foreignKey;
			} else {
				// Look for the corresponding ref relationship in the target collection
				const targetConfig = config[relationship.target];
				if (targetConfig) {
					// Find the relationship that points back to our collection
					const reverseRelationship = Object.entries(
						targetConfig.relationships,
					).find(
						([, rel]) => rel.type === "ref" && rel.target === collectionName,
					);

					if (reverseRelationship && reverseRelationship[1].foreignKey) {
						foreignKeyField = reverseRelationship[1].foreignKey;
					} else {
						// Fall back to the default naming convention
						const singularName = collectionName.endsWith("ies")
							? collectionName.slice(0, -3) + "y" // companies -> company, industries -> industry
							: collectionName.replace(/s$/, ""); // users -> user, posts -> post
						foreignKeyField = singularName + "Id";
					}
				} else {
					// Fall back to the default naming convention
					const singularName = collectionName.endsWith("ies")
						? collectionName.slice(0, -3) + "y" // companies -> company, industries -> industry
						: collectionName.replace(/s$/, ""); // users -> user, posts -> post
					foreignKeyField = singularName + "Id";
				}
			}

			const relatedItems = findRelatedItems(
				populated,
				foreignKeyField,
				targetData,
			);

			if (value === true) {
				Object.assign(populated, { [key]: relatedItems });
			} else if (isPopulateConfig(value)) {
				// Recursively populate each item in the array
				const targetConfig = config[relationship.target];
				if (targetConfig) {
					// Extract nested populate config and select from value safely
					const { select, nestedPopulate } = extractNestedConfig(value);

					const populatedItems = relatedItems.map((relItem) => {
						// Apply nested population first
						let populatedItem = relItem;
						if (Object.keys(nestedPopulate).length > 0) {
							populatedItem = applyPopulate(
								relItem,
								nestedPopulate,
								allData,
								targetConfig.relationships,
								relationship.target,
								config,
							);
						}

						// Apply field selection if specified (supports both array and object-based)
						if (select) {
							let selectedFields: Record<string, unknown>;
							if (isStringArray(select)) {
								// Convert array to object format
								const objectSelect: Record<string, boolean> = {};
								for (const field of select) {
									objectSelect[field] = true;
								}
								selectedFields = applyObjectSelection(
									populatedItem,
									objectSelect,
								);
							} else if (isRecord(select)) {
								selectedFields = applyObjectSelection(populatedItem, select);
							} else {
								// Invalid select format, skip selection
								selectedFields = populatedItem;
							}

							// For object-based selection, the nested fields are already handled by applyObjectSelection
							// For array-based selection, preserve any populated fields that are defined in relationships
							let finalResult = selectedFields;

							if (isStringArray(select)) {
								// Only for array-based selection, we need to preserve populated relationships
								finalResult = { ...selectedFields };

								// Check relationships in the target config to know which fields are populated
								for (const [relKey, relDef] of Object.entries(
									targetConfig.relationships,
								)) {
									if (nestedPopulate[relKey] && relKey in populatedItem) {
										finalResult[relKey] = populatedItem[relKey];
									}
								}
							}

							populatedItem = finalResult;
						}

						return populatedItem;
					});
					Object.assign(populated, { [key]: populatedItems });
				}
			}
		}
	}

	return populated;
}

// Helper function to populate relationships
export function populateRelationships<T extends Record<string, unknown>>(
	items: T[],
	populateConfig: Record<string, PopulateValue> | undefined,
	allData: Record<string, unknown[]>,
	relationships: Record<string, Relationship>,
	collectionName: string,
	config: Record<string, CollectionConfig>,
): T[] {
	if (!populateConfig || !isPopulateConfig(populateConfig)) return items;

	return items.map((item) =>
		applyPopulate(
			item,
			populateConfig,
			allData,
			relationships,
			collectionName,
			config,
		),
	);
}
