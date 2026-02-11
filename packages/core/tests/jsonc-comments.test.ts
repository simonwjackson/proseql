import { describe, it, expect } from "vitest"
import { jsoncCodec } from "../src/serializers/codecs/jsonc.js"

/**
 * JSONC-specific comment handling tests.
 *
 * JSONC (JSON with Comments) supports:
 * - Line comments: // comment
 * - Block comments: /* comment *‌/
 *
 * On decode: Comments are stripped using jsonc-parser
 * On encode: Standard JSON is output (comments are not preserved)
 *
 * This mirrors VS Code's settings.json behavior — comments in hand-edited
 * .jsonc files do not survive a save cycle.
 */

describe("jsoncCodec comment handling", () => {
	const codec = jsoncCodec()

	describe("line comments", () => {
		it("strips single line comment at end of line", () => {
			const input = `{
  "name": "test" // inline comment
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("strips line comment on its own line", () => {
			const input = `{
  // This is a comment
  "name": "test"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("strips multiple line comments", () => {
			const input = `{
  // First comment
  "a": 1,
  // Second comment
  "b": 2,
  // Third comment
  "c": 3
  // Trailing comment
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ a: 1, b: 2, c: 3 })
		})

		it("strips line comment before opening brace", () => {
			const input = `// Header comment
{
  "name": "test"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("strips line comment after closing brace", () => {
			const input = `{
  "name": "test"
}
// Footer comment`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("handles line comment with special characters", () => {
			const input = `{
  // Comment with special chars: !@#$%^&*(){}[]|\\:";'<>?,./
  "value": 42
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ value: 42 })
		})

		it("handles line comment with URL", () => {
			const input = `{
  // See https://example.com/docs for more info
  "url": "https://test.com"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ url: "https://test.com" })
		})
	})

	describe("block comments", () => {
		it("strips single-line block comment", () => {
			const input = `{
  /* Block comment */ "name": "test"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("strips multi-line block comment", () => {
			const input = `{
  /*
   * This is a multi-line
   * block comment with
   * multiple lines
   */
  "name": "test"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("strips block comment in the middle of object", () => {
			const input = `{
  "a": 1,
  /* comment in middle */
  "b": 2
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ a: 1, b: 2 })
		})

		it("strips multiple block comments", () => {
			const input = `{
  /* First block */
  "a": 1,
  /* Second block */
  "b": 2,
  /* Third block */
  "c": 3
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ a: 1, b: 2, c: 3 })
		})

		it("strips block comment before key", () => {
			const input = `{
  /* description of name */ "name": "test"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("strips block comment after value", () => {
			const input = `{
  "name": "test" /* value explanation */
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})

		it("handles block comment with asterisks", () => {
			const input = `{
  /************************************
   * Very important comment here!     *
   ************************************/
  "important": true
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ important: true })
		})

		it("handles empty block comment", () => {
			const input = `{
  /**/ "name": "test"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ name: "test" })
		})
	})

	describe("mixed comments", () => {
		it("handles both line and block comments together", () => {
			const input = `{
  // Line comment
  "a": 1,
  /* Block comment */
  "b": 2
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ a: 1, b: 2 })
		})

		it("handles alternating comment styles", () => {
			const input = `{
  // Line
  "a": 1,
  /* Block */
  "b": 2,
  // Line again
  "c": 3,
  /* Block again */
  "d": 4
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ a: 1, b: 2, c: 3, d: 4 })
		})

		it("handles comments in nested structures", () => {
			const input = `{
  // Top level comment
  "user": {
    /* User object comment */
    "name": "Alice", // Name of the user
    "profile": {
      // Profile section
      "age": 30, /* Age in years */
      "active": true
    }
  }
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({
				user: {
					name: "Alice",
					profile: {
						age: 30,
						active: true,
					},
				},
			})
		})

		it("handles comments around arrays", () => {
			const input = `{
  // Array of items
  "items": [
    /* First item */ 1,
    // Second item
    2,
    /* Third item */ 3
  ]
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ items: [1, 2, 3] })
		})

		it("handles complex real-world config style", () => {
			const input = `{
  // Database configuration
  // See https://docs.example.com/db-config for details
  "database": {
    "host": "localhost",     // Database host
    "port": 5432,            // Default PostgreSQL port
    /*
     * Connection pool settings
     * Adjust based on server capacity
     */
    "pool": {
      "min": 2,    // Minimum connections
      "max": 10    // Maximum connections
    }
  },

  // Feature flags
  /* These control experimental features */
  "features": {
    "darkMode": true,    // Enable dark mode
    "betaFeatures": false  /* Disable beta features for now */
  }
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({
				database: {
					host: "localhost",
					port: 5432,
					pool: {
						min: 2,
						max: 10,
					},
				},
				features: {
					darkMode: true,
					betaFeatures: false,
				},
			})
		})
	})

	describe("encode outputs clean JSON", () => {
		it("outputs no line comments", () => {
			const data = { name: "test", value: 42 }
			const encoded = codec.encode(data)
			expect(encoded).not.toContain("//")
		})

		it("outputs no block comments", () => {
			const data = { name: "test", value: 42 }
			const encoded = codec.encode(data)
			expect(encoded).not.toContain("/*")
			expect(encoded).not.toContain("*/")
		})

		it("outputs valid JSON parseable by JSON.parse", () => {
			const data = {
				user: {
					name: "Alice",
					age: 30,
					active: true,
				},
				items: [1, 2, 3],
			}
			const encoded = codec.encode(data)
			// Should be parseable by standard JSON.parse
			expect(() => JSON.parse(encoded)).not.toThrow()
			expect(JSON.parse(encoded)).toEqual(data)
		})

		it("preserves data through decode-encode cycle", () => {
			// Input with comments
			const input = `{
  // Important config
  "name": "test",
  /* Value description */
  "value": 42
}`
			const decoded = codec.decode(input)
			const reencoded = codec.encode(decoded)

			// Output should be clean JSON
			expect(reencoded).not.toContain("//")
			expect(reencoded).not.toContain("/*")

			// Data should be preserved
			const redecoded = codec.decode(reencoded)
			expect(redecoded).toEqual(decoded)
		})

		it("respects indent option", () => {
			const compactCodec = jsoncCodec({ indent: 0 })
			const prettyCodec = jsoncCodec({ indent: 4 })

			const data = { a: 1, b: 2 }

			const compact = compactCodec.encode(data)
			const pretty = prettyCodec.encode(data)

			expect(compact).not.toContain("\n")
			expect(pretty).toContain("    ") // 4 spaces
			expect(pretty).not.toContain("//")
		})
	})

	describe("edge cases", () => {
		it("handles empty object with comments", () => {
			const input = `{
  // Empty object
  /* Nothing here */
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({})
		})

		it("handles comment-only content with empty object", () => {
			const input = `// Just a comment
{}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({})
		})

		it("handles string containing comment-like text", () => {
			const input = `{
  "code": "// not a comment",
  "block": "/* also not a comment */"
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({
				code: "// not a comment",
				block: "/* also not a comment */",
			})
		})

		it("preserves string containing comment characters through round-trip", () => {
			const data = {
				url: "https://example.com/path",
				regex: "a//b",
				comment: "/* test */",
			}
			const encoded = codec.encode(data)
			const decoded = codec.decode(encoded)
			expect(decoded).toEqual(data)
		})

		it("handles trailing comma with comment (JSONC extension)", () => {
			const input = `{
  "a": 1,
  "b": 2, // trailing comma allowed in JSONC
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ a: 1, b: 2 })
		})

		it("handles deeply nested comments", () => {
			const input = `{
  "level1": {
    // L1 comment
    "level2": {
      /* L2 comment */
      "level3": {
        // L3 comment
        "value": "deep"
        // More comments
      }
    }
  }
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({
				level1: {
					level2: {
						level3: {
							value: "deep",
						},
					},
				},
			})
		})

		it("handles null with comments", () => {
			const input = `{
  "nullable": null // This is null
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ nullable: null })
		})

		it("handles boolean values with comments", () => {
			const input = `{
  "enabled": true, // Feature is enabled
  "debug": false /* Debug mode off */
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({ enabled: true, debug: false })
		})

		it("handles numeric values with comments", () => {
			const input = `{
  "integer": 42, // The answer
  "float": 3.14, /* Pi approximation */
  "negative": -100, // Negative number
  "zero": 0 /* Zero value */
}`
			const decoded = codec.decode(input)
			expect(decoded).toEqual({
				integer: 42,
				float: 3.14,
				negative: -100,
				zero: 0,
			})
		})
	})
})
