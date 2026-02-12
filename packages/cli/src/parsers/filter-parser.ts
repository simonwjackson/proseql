/**
 * Filter Parser - Parses CLI --where expressions into proseql where clause objects
 *
 * Supports operators: =, !=, >, <, >=, <=, contains, startsWith, endsWith
 * Auto-detects value types: numbers, booleans, strings
 *
 * Examples:
 *   "year > 1970"        -> { year: { $gt: 1970 } }
 *   "status = active"    -> { status: { $eq: "active" } }
 *   "active = true"      -> { active: { $eq: true } }
 *   "title contains War" -> { title: { $contains: "War" } }
 */

import { Data, Effect } from "effect"

/**
 * Error thrown when a filter expression cannot be parsed
 */
export class FilterParseError extends Data.TaggedError("FilterParseError")<{
  readonly expression: string
  readonly reason: string
}> {
  get message(): string {
    return `Failed to parse filter "${this.expression}": ${this.reason}`
  }
}

/**
 * Supported comparison operators
 */
const COMPARISON_OPERATORS = [">=", "<=", "!=", ">", "<", "="] as const

/**
 * Supported word operators (case-insensitive)
 */
const WORD_OPERATORS = ["contains", "startswith", "endswith"] as const

type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number]
type WordOperator = (typeof WORD_OPERATORS)[number]
type Operator = ComparisonOperator | WordOperator

/**
 * Map CLI operators to proseql filter operators
 */
function mapOperator(
  op: Operator,
): "$eq" | "$ne" | "$gt" | "$lt" | "$gte" | "$lte" | "$contains" | "$startsWith" | "$endsWith" {
  switch (op) {
    case "=":
      return "$eq"
    case "!=":
      return "$ne"
    case ">":
      return "$gt"
    case "<":
      return "$lt"
    case ">=":
      return "$gte"
    case "<=":
      return "$lte"
    case "contains":
      return "$contains"
    case "startswith":
      return "$startsWith"
    case "endswith":
      return "$endsWith"
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
 * Parsed filter expression
 */
interface ParsedFilter {
  readonly field: string
  readonly operator: Operator
  readonly value: string | number | boolean
}

/**
 * Try to parse a filter expression with comparison operators (=, !=, >, <, >=, <=)
 */
function tryParseComparisonOperator(
  expression: string,
): ParsedFilter | undefined {
  // Try each operator in order (longest first to avoid partial matches)
  for (const op of COMPARISON_OPERATORS) {
    const index = expression.indexOf(op)
    if (index > 0) {
      const field = expression.slice(0, index).trim()
      const valueStr = expression.slice(index + op.length).trim()

      if (field && valueStr) {
        return {
          field,
          operator: op,
          value: parseValue(valueStr),
        }
      }
    }
  }
  return undefined
}

/**
 * Try to parse a filter expression with word operators (contains, startsWith, endsWith)
 */
function tryParseWordOperator(expression: string): ParsedFilter | undefined {
  const lowerExpr = expression.toLowerCase()

  for (const op of WORD_OPERATORS) {
    // Look for the operator as a word boundary (space before and after)
    const pattern = new RegExp(`\\s+${op}\\s+`, "i")
    const match = expression.match(pattern)

    if (match && match.index !== undefined) {
      const field = expression.slice(0, match.index).trim()
      const valueStr = expression.slice(match.index + match[0].length).trim()

      if (field && valueStr) {
        return {
          field,
          operator: op,
          value: parseValue(valueStr),
        }
      }
    }
  }
  return undefined
}

/**
 * Parse a single filter expression into a parsed filter object
 */
function parseExpression(
  expression: string,
): Effect.Effect<ParsedFilter, FilterParseError> {
  return Effect.gen(function* () {
    const trimmed = expression.trim()

    if (!trimmed) {
      return yield* Effect.fail(
        new FilterParseError({
          expression,
          reason: "Empty expression",
        }),
      )
    }

    // Try comparison operators first
    const comparisonResult = tryParseComparisonOperator(trimmed)
    if (comparisonResult) {
      return comparisonResult
    }

    // Try word operators
    const wordResult = tryParseWordOperator(trimmed)
    if (wordResult) {
      return wordResult
    }

    return yield* Effect.fail(
      new FilterParseError({
        expression,
        reason:
          "No valid operator found. Supported operators: =, !=, >, <, >=, <=, contains, startsWith, endsWith",
      }),
    )
  })
}

/**
 * Where clause type - record of field to filter operators
 */
export type WhereClause = Record<
  string,
  | { $eq?: string | number | boolean }
  | { $ne?: string | number | boolean }
  | { $gt?: string | number }
  | { $lt?: string | number }
  | { $gte?: string | number }
  | { $lte?: string | number }
  | { $contains?: string }
  | { $startsWith?: string }
  | { $endsWith?: string }
>

/**
 * Parse a single filter expression into a where clause object
 *
 * @param expression - Filter expression string (e.g., "year > 1970")
 * @returns Effect containing the where clause or a FilterParseError
 */
export function parseFilter(
  expression: string,
): Effect.Effect<WhereClause, FilterParseError> {
  return Effect.gen(function* () {
    const parsed = yield* parseExpression(expression)
    const operator = mapOperator(parsed.operator)

    return {
      [parsed.field]: {
        [operator]: parsed.value,
      },
    } as WhereClause
  })
}

/**
 * Parse multiple filter expressions and combine them into a single where clause
 * Multiple filters on different fields are combined with AND logic
 * Multiple filters on the same field are merged
 *
 * @param expressions - Array of filter expression strings
 * @returns Effect containing the combined where clause or a FilterParseError
 */
export function parseFilters(
  expressions: readonly string[],
): Effect.Effect<WhereClause, FilterParseError> {
  return Effect.gen(function* () {
    if (expressions.length === 0) {
      return {}
    }

    const parsedFilters = yield* Effect.all(expressions.map(parseFilter))

    // Merge all filters into a single where clause
    const combined: WhereClause = {}
    for (const filter of parsedFilters) {
      for (const [field, conditions] of Object.entries(filter)) {
        if (combined[field]) {
          // Merge conditions for the same field
          combined[field] = { ...combined[field], ...conditions }
        } else {
          combined[field] = conditions
        }
      }
    }

    return combined
  })
}
