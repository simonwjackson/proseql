/**
 * Plugin validation functions.
 * Validates that plugins conform to the ProseQLPlugin interface and
 * detects conflicts between plugins.
 */

import { Effect } from "effect";
import { PluginError } from "../errors/plugin-errors.js";
import type {
	CustomIdGenerator,
	CustomOperator,
	ProseQLPlugin,
} from "./plugin-types.js";
import type { FormatCodec } from "../serializers/format-codec.js";

// ============================================================================
// Plugin Validation
// ============================================================================

/**
 * Validates that a plugin conforms to the ProseQLPlugin interface.
 *
 * Checks:
 * - `name` is a non-empty string
 * - `codecs` entries have `name`, `extensions`, `encode`, and `decode`
 * - `operators` entries have `name` starting with `$` and an `evaluate` function
 * - `idGenerators` entries have `name` and `generate`
 *
 * @param plugin - The plugin to validate
 * @returns Effect<void, PluginError> - Succeeds if valid, fails with PluginError if not
 */
export const validatePlugin = (
	plugin: ProseQLPlugin,
): Effect.Effect<void, PluginError> => {
	return Effect.gen(function* () {
		// Validate name is a non-empty string
		if (typeof plugin.name !== "string" || plugin.name.trim() === "") {
			return yield* Effect.fail(
				new PluginError({
					plugin: plugin.name ?? "(unnamed)",
					reason: "invalid_name",
					message: "Plugin name must be a non-empty string",
				}),
			);
		}

		const pluginName = plugin.name;

		// Validate codecs
		if (plugin.codecs !== undefined) {
			for (let i = 0; i < plugin.codecs.length; i++) {
				const codec = plugin.codecs[i];
				const codecError = validateCodec(codec, i, pluginName);
				if (codecError !== null) {
					return yield* Effect.fail(codecError);
				}
			}
		}

		// Validate operators
		if (plugin.operators !== undefined) {
			for (let i = 0; i < plugin.operators.length; i++) {
				const operator = plugin.operators[i];
				const operatorError = validateOperator(operator, i, pluginName);
				if (operatorError !== null) {
					return yield* Effect.fail(operatorError);
				}
			}
		}

		// Validate idGenerators
		if (plugin.idGenerators !== undefined) {
			for (let i = 0; i < plugin.idGenerators.length; i++) {
				const generator = plugin.idGenerators[i];
				const generatorError = validateIdGenerator(generator, i, pluginName);
				if (generatorError !== null) {
					return yield* Effect.fail(generatorError);
				}
			}
		}
	});
};

/**
 * Validates a FormatCodec entry.
 * Returns null if valid, PluginError if invalid.
 */
const validateCodec = (
	codec: FormatCodec,
	index: number,
	pluginName: string,
): PluginError | null => {
	if (typeof codec.name !== "string" || codec.name.trim() === "") {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_codec",
			message: `Codec at index ${index} must have a non-empty 'name' string`,
		});
	}

	if (!Array.isArray(codec.extensions) || codec.extensions.length === 0) {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_codec",
			message: `Codec '${codec.name}' must have a non-empty 'extensions' array`,
		});
	}

	for (const ext of codec.extensions) {
		if (typeof ext !== "string" || ext.trim() === "") {
			return new PluginError({
				plugin: pluginName,
				reason: "invalid_codec",
				message: `Codec '${codec.name}' has an invalid extension (must be a non-empty string)`,
			});
		}
	}

	if (typeof codec.encode !== "function") {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_codec",
			message: `Codec '${codec.name}' must have an 'encode' function`,
		});
	}

	if (typeof codec.decode !== "function") {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_codec",
			message: `Codec '${codec.name}' must have a 'decode' function`,
		});
	}

	return null;
};

/**
 * Validates a CustomOperator entry.
 * Returns null if valid, PluginError if invalid.
 */
const validateOperator = (
	operator: CustomOperator,
	index: number,
	pluginName: string,
): PluginError | null => {
	if (typeof operator.name !== "string" || operator.name.trim() === "") {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_operator",
			message: `Operator at index ${index} must have a non-empty 'name' string`,
		});
	}

	if (!operator.name.startsWith("$")) {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_operator",
			message: `Operator '${operator.name}' name must start with '$'`,
		});
	}

	if (typeof operator.evaluate !== "function") {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_operator",
			message: `Operator '${operator.name}' must have an 'evaluate' function`,
		});
	}

	return null;
};

/**
 * Validates a CustomIdGenerator entry.
 * Returns null if valid, PluginError if invalid.
 */
const validateIdGenerator = (
	generator: CustomIdGenerator,
	index: number,
	pluginName: string,
): PluginError | null => {
	if (typeof generator.name !== "string" || generator.name.trim() === "") {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_id_generator",
			message: `ID generator at index ${index} must have a non-empty 'name' string`,
		});
	}

	if (typeof generator.generate !== "function") {
		return new PluginError({
			plugin: pluginName,
			reason: "invalid_id_generator",
			message: `ID generator '${generator.name}' must have a 'generate' function`,
		});
	}

	return null;
};
