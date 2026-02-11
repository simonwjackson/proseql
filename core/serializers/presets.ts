import { hjsonCodec } from "./codecs/hjson.js"
import { jsonCodec } from "./codecs/json.js"
import { json5Codec } from "./codecs/json5.js"
import { jsoncCodec } from "./codecs/jsonc.js"
import { tomlCodec } from "./codecs/toml.js"
import { toonCodec } from "./codecs/toon.js"
import { yamlCodec } from "./codecs/yaml.js"
import { makeSerializerLayer } from "./format-codec.js"

// ============================================================================
// Preset Layers — Pre-configured SerializerRegistry Layers
// ============================================================================

/**
 * A SerializerRegistry Layer that supports all 7 text formats:
 * - JSON (.json)
 * - YAML (.yaml, .yml)
 * - JSON5 (.json5)
 * - JSONC (.jsonc)
 * - TOML (.toml)
 * - TOON (.toon)
 * - Hjson (.hjson)
 *
 * Use this when you need maximum format flexibility.
 *
 * @example
 * ```typescript
 * import { AllTextFormatsLayer } from "./presets.js"
 *
 * const program = Effect.gen(function* () {
 *   const registry = yield* SerializerRegistry
 *   yield* registry.serialize(data, "yaml")
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(AllTextFormatsLayer)))
 * ```
 */
export const AllTextFormatsLayer = makeSerializerLayer([
	jsonCodec(),
	yamlCodec(),
	json5Codec(),
	jsoncCodec(),
	tomlCodec(),
	toonCodec(),
	hjsonCodec(),
])

/**
 * A SerializerRegistry Layer that supports the default formats:
 * - JSON (.json)
 * - YAML (.yaml, .yml)
 *
 * Use this for standard configuration files and data storage.
 * This is the recommended default for most use cases.
 *
 * @example
 * ```typescript
 * import { DefaultSerializerLayer } from "./presets.js"
 *
 * const program = Effect.gen(function* () {
 *   const registry = yield* SerializerRegistry
 *   yield* registry.serialize(data, "json")
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(DefaultSerializerLayer)))
 * ```
 */
export const DefaultSerializerLayer = makeSerializerLayer([
	jsonCodec(),
	yamlCodec(),
])
