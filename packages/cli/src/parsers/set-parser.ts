/**
 * Set Parser - Parses CLI --set assignment strings into partial update objects
 *
 * Parses key=value pairs separated by commas.
 * Auto-detects value types: numbers, booleans, strings
 *
 * Examples:
 *   "year=2025"                   -> { year: 2025 }
 *   "title=New Title"             -> { title: "New Title" }
 *   "active=true"                 -> { active: true }
 *   "year=2025,title=New Title"   -> { year: 2025, title: "New Title" }
 *   "url=https://example.com/a=b" -> { url: "https://example.com/a=b" }
 */

import { Data, Effect } from "effect"

/**
 * Error thrown when a set expression cannot be parsed
 */
export class SetParseError extends Data.TaggedError("SetParseError")<{
  readonly expression: string
  readonly reason: string
}> {
  get message(): string {
    return `Failed to parse set expression "${this.expression}": ${this.reason}`
  }
}

/**
 * Parse a string value into the appropriate type (number, boolean, or string)
 */
function parseValue(value: string): string | number | boolean {
  const trimmed = value.trim()

  // Check for boolean
  if (trimmed.toLowerCase() === "true") {
    return true
  }
  if (trimmed.toLowerCase() === "false") {
    return false
  }

  // Check for number
  const num = Number(trimmed)
  if (!Number.isNaN(num) && trimmed !== "") {
    return num
  }

  // Default to string - strip quotes if present
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

/**
 * Parsed assignment
 */
interface ParsedAssignment {
  readonly key: string
  readonly value: string | number | boolean
}

/**
 * Parse a single key=value assignment
 * Handles values containing '=' by only splitting on the first '='
 */
function parseAssignment(
  assignment: string,
): Effect.Effect<ParsedAssignment, SetParseError> {
  return Effect.gen(function* () {
    const trimmed = assignment.trim()

    if (!trimmed) {
      return yield* Effect.fail(
        new SetParseError({
          expression: assignment,
          reason: "Empty assignment",
        }),
      )
    }

    // Find the first '=' to split key and value
    const eqIndex = trimmed.indexOf("=")

    if (eqIndex === -1) {
      return yield* Effect.fail(
        new SetParseError({
          expression: assignment,
          reason: "Missing '=' operator. Expected format: key=value",
        }),
      )
    }

    if (eqIndex === 0) {
      return yield* Effect.fail(
        new SetParseError({
          expression: assignment,
          reason: "Missing key before '='",
        }),
      )
    }

    const key = trimmed.slice(0, eqIndex).trim()
    const valueStr = trimmed.slice(eqIndex + 1)

    // Validate key is a valid identifier
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      return yield* Effect.fail(
        new SetParseError({
          expression: assignment,
          reason: `Invalid key "${key}". Keys must be valid identifiers (start with letter or underscore, contain only letters, numbers, and underscores)`,
        }),
      )
    }

    return {
      key,
      value: parseValue(valueStr),
    }
  })
}

/**
 * Split assignment string by commas, respecting quoted values
 * This handles cases where values might contain commas inside quotes
 */
function splitAssignments(input: string): readonly string[] {
  const assignments: string[] = []
  let current = ""
  let inQuotes = false
  let quoteChar = ""

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true
      quoteChar = char
      current += char
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false
      quoteChar = ""
      current += char
    } else if (!inQuotes && char === ",") {
      if (current.trim()) {
        assignments.push(current.trim())
      }
      current = ""
    } else {
      current += char
    }
  }

  // Don't forget the last assignment
  if (current.trim()) {
    assignments.push(current.trim())
  }

  return assignments
}

/**
 * Update object type - record of field to value
 */
export type UpdateObject = Record<string, string | number | boolean>

/**
 * Parse a single assignment string into an update object
 *
 * @param assignment - Assignment string (e.g., "year=2025")
 * @returns Effect containing the update object or a SetParseError
 */
export function parseSet(
  assignment: string,
): Effect.Effect<UpdateObject, SetParseError> {
  return Effect.gen(function* () {
    const parsed = yield* parseAssignment(assignment)
    return {
      [parsed.key]: parsed.value,
    }
  })
}

/**
 * Parse a comma-separated assignment string into an update object
 * Multiple assignments are merged into a single object
 *
 * @param input - Comma-separated assignment string (e.g., "year=2025,title=New Title")
 * @returns Effect containing the combined update object or a SetParseError
 */
export function parseSets(
  input: string,
): Effect.Effect<UpdateObject, SetParseError> {
  return Effect.gen(function* () {
    const trimmed = input.trim()

    if (!trimmed) {
      return yield* Effect.fail(
        new SetParseError({
          expression: input,
          reason: "Empty input",
        }),
      )
    }

    const assignments = splitAssignments(trimmed)

    if (assignments.length === 0) {
      return yield* Effect.fail(
        new SetParseError({
          expression: input,
          reason: "No valid assignments found",
        }),
      )
    }

    const parsedAssignments = yield* Effect.all(assignments.map(parseSet))

    // Merge all assignments into a single object
    // Later assignments override earlier ones for the same key
    const combined: UpdateObject = {}
    for (const assignment of parsedAssignments) {
      for (const [key, value] of Object.entries(assignment)) {
        combined[key] = value
      }
    }

    return combined
  })
}

/**
 * Parse multiple comma-separated assignment strings into an update object
 * Useful when --set is passed multiple times
 *
 * @param inputs - Array of comma-separated assignment strings
 * @returns Effect containing the combined update object or a SetParseError
 */
export function parseMultipleSets(
  inputs: readonly string[],
): Effect.Effect<UpdateObject, SetParseError> {
  return Effect.gen(function* () {
    if (inputs.length === 0) {
      return {}
    }

    const parsedInputs = yield* Effect.all(inputs.map(parseSets))

    // Merge all into a single object
    const combined: UpdateObject = {}
    for (const input of parsedInputs) {
      for (const [key, value] of Object.entries(input)) {
        combined[key] = value
      }
    }

    return combined
  })
}
