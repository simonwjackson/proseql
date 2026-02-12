/**
 * ProseQL CLI - Confirmation Prompt
 *
 * Provides a y/n confirmation prompt for destructive operations.
 * Skipped when --force is passed or stdin is not a TTY (non-interactive mode).
 */

import * as readline from "node:readline"

/**
 * Options for the confirmation prompt.
 */
export interface ConfirmOptions {
	/** The message to display to the user */
	readonly message: string
	/** Whether to skip the prompt (e.g., --force flag was passed) */
	readonly force?: boolean
	/** Default answer if the user just presses Enter (defaults to false) */
	readonly defaultAnswer?: boolean
}

/**
 * Result of the confirmation prompt.
 */
export interface ConfirmResult {
	/** Whether the user confirmed the action */
	readonly confirmed: boolean
	/** Whether the prompt was skipped (force flag or non-TTY) */
	readonly skipped: boolean
	/** Reason why the prompt was skipped, if applicable */
	readonly skipReason?: "force" | "non-tty"
}

/**
 * Check if stdin is a TTY (interactive terminal).
 */
function isTTY(): boolean {
	return process.stdin.isTTY === true
}

/**
 * Read a single line from stdin.
 * Returns a promise that resolves to the trimmed input.
 */
function readLine(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		})

		rl.question(prompt, (answer) => {
			rl.close()
			resolve(answer.trim().toLowerCase())
		})
	})
}

/**
 * Parse a y/n answer string into a boolean.
 * Accepts: y, yes, n, no (case-insensitive)
 * Empty string returns the default answer.
 * Invalid input returns null.
 */
function parseAnswer(
	answer: string,
	defaultAnswer: boolean,
): boolean | null {
	if (answer === "") {
		return defaultAnswer
	}
	if (answer === "y" || answer === "yes") {
		return true
	}
	if (answer === "n" || answer === "no") {
		return false
	}
	return null
}

/**
 * Format the prompt string with y/n indicator.
 * Shows the default option in uppercase.
 */
function formatPrompt(message: string, defaultAnswer: boolean): string {
	const yesNo = defaultAnswer ? "[Y/n]" : "[y/N]"
	return `${message} ${yesNo} `
}

/**
 * Prompt the user for confirmation with a y/n question.
 *
 * The prompt is skipped in these cases:
 * - `force` option is true (returns confirmed: true)
 * - stdin is not a TTY (returns confirmed: true, matching common CLI conventions)
 *
 * @param options - Confirmation prompt options
 * @returns Promise resolving to the confirmation result
 *
 * @example
 * ```ts
 * const result = await confirm({
 *   message: "Delete entity 'abc123'?",
 *   force: flags.force,
 * })
 *
 * if (!result.confirmed) {
 *   console.log("Aborted.")
 *   return
 * }
 * ```
 */
export async function confirm(options: ConfirmOptions): Promise<ConfirmResult> {
	const { message, force = false, defaultAnswer = false } = options

	// Skip if --force flag is passed
	if (force) {
		return {
			confirmed: true,
			skipped: true,
			skipReason: "force",
		}
	}

	// Skip if stdin is not a TTY (non-interactive mode like CI or piped input)
	// In non-interactive mode, proceed as if confirmed (matching common CLI conventions)
	if (!isTTY()) {
		return {
			confirmed: true,
			skipped: true,
			skipReason: "non-tty",
		}
	}

	// Interactive prompt
	const prompt = formatPrompt(message, defaultAnswer)

	// Keep prompting until we get a valid answer
	while (true) {
		const answer = await readLine(prompt)
		const parsed = parseAnswer(answer, defaultAnswer)

		if (parsed !== null) {
			return {
				confirmed: parsed,
				skipped: false,
			}
		}

		// Invalid input - show hint and ask again
		console.log("Please answer 'y' or 'n'.")
	}
}

/**
 * Synchronous version of isTTY check.
 * Exported for testing purposes.
 */
export function isInteractive(): boolean {
	return isTTY()
}
