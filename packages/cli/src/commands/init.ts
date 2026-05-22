/**
 * ProseQL CLI - Init Command
 *
 * Scaffolds a new proseql project with config and data files.
 * Checks for existing config and aborts with warning if found.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Config file names in priority order (same as discovery.ts)
const CONFIG_FILE_NAMES = [
	"proseql.config.ts",
	"proseql.config.js",
	"proseql.config.json",
] as const;

// Default config file name to create
const DEFAULT_CONFIG_FILE = "proseql.config.ts";

// Supported data file formats
type DataFormat = "json" | "yaml" | "toml";

// Map format to file extension
const FORMAT_EXTENSIONS: Record<DataFormat, string> = {
	json: "json",
	yaml: "yaml",
	toml: "toml",
};

/**
 * Generate example note data for initial setup.
 * Creates a realistic sample to help users understand the data structure.
 */
function generateExampleData(): readonly Record<string, unknown>[] {
	const now = new Date().toISOString();
	return [
		{
			id: "note_001",
			title: "Welcome to ProseQL",
			content:
				"This is your first note. ProseQL stores your data in plain text files that you can read, edit, and version control.",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "note_002",
			title: "Getting Started",
			content:
				"Try running 'proseql query notes' to see your data, or 'proseql create notes --data '{...}'' to add new entries.",
			createdAt: now,
			updatedAt: now,
		},
	] as const;
}

/**
 * Serialize data to JSON format.
 */
type DocumentSourceData = Record<
	string,
	Record<string, Record<string, unknown>>
>;

function toDocumentSourceData(
	data: readonly Record<string, unknown>[],
): DocumentSourceData {
	const notes: Record<string, Record<string, unknown>> = {};
	for (const item of data) {
		const id = item.id;
		if (typeof id !== "string") continue;
		const payload: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(item)) {
			if (key !== "id") payload[key] = value;
		}
		notes[id] = payload;
	}
	return { notes };
}

function serializeJson(data: DocumentSourceData): string {
	return JSON.stringify(data, null, 2);
}

const quoteString = (value: string): string =>
	`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Serialize document-source data to YAML format.
 */
function serializeYaml(data: DocumentSourceData): string {
	const lines: string[] = [];
	for (const [collection, records] of Object.entries(data)) {
		lines.push(`${collection}:`);
		for (const [id, payload] of Object.entries(records)) {
			lines.push(`  ${id}:`);
			for (const [key, value] of Object.entries(payload)) {
				const stringValue =
					typeof value === "string" ? quoteString(value) : String(value);
				lines.push(`    ${key}: ${stringValue}`);
			}
		}
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Serialize document-source data to TOML format.
 */
function serializeToml(data: DocumentSourceData): string {
	const lines: string[] = [];
	for (const [collection, records] of Object.entries(data)) {
		for (const [id, payload] of Object.entries(records)) {
			lines.push(`[${collection}.${id}]`);
			for (const [key, value] of Object.entries(payload)) {
				const stringValue =
					typeof value === "string" ? quoteString(value) : String(value);
				lines.push(`${key} = ${stringValue}`);
			}
			lines.push("");
		}
	}
	return lines.join("\n");
}

/**
 * Serialize example data to the specified format.
 */
function serializeExampleData(
	data: DocumentSourceData,
	format: DataFormat,
): string {
	switch (format) {
		case "json":
			return serializeJson(data);
		case "yaml":
			return serializeYaml(data);
		case "toml":
			return serializeToml(data);
	}
}

/**
 * Generate the content for proseql.config.ts with an example collection.
 * The generated config includes a "notes" collection as a simple starting point.
 *
 * @param format - The data file format (json, yaml, toml)
 */
function generateConfigContent(format: string): string {
	const extension =
		format === "yaml" ? "yaml" : format === "toml" ? "toml" : "json";

	return `import { Schema, type DatabaseConfig } from "@proseql/core"

/**
 * Example schema for a notes collection.
 * Customize this schema to match your data structure.
 */
const NoteSchema = Schema.Struct({
  title: Schema.String,
  content: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

/**
 * ProseQL database configuration.
 * Collections define schemas and sources define persistence locations.
 */
const config = {
  collections: {
    notes: {
      schema: NoteSchema,
      id: { kind: "derivedFromKey", field: "id" },
      relationships: {},
    },
  },
  sources: [
    {
      id: "local",
      kind: "documents",
      root: "./data",
      include: "**/*.${extension}",
      format: "${extension}",
      collections: "all",
      outbox: "generated.${extension}",
    },
  ],
} as const satisfies DatabaseConfig

export default config
`;
}

/**
 * Check if a config file already exists in the current directory.
 * Returns the name of the found config file, or null if none found.
 */
function findExistingConfig(cwd: string): string | null {
	for (const configName of CONFIG_FILE_NAMES) {
		const configPath = path.join(cwd, configName);
		if (fs.existsSync(configPath)) {
			return configName;
		}
	}
	return null;
}

/**
 * Check if the current directory is inside a git repository.
 * Returns true if a .git directory exists.
 */
function isGitRepository(cwd: string): boolean {
	const gitPath = path.join(cwd, ".git");
	return fs.existsSync(gitPath);
}

/**
 * Check if a pattern is already in .gitignore.
 * Handles various formats: exact match, with leading slash, with trailing slash.
 */
function isPatternInGitignore(
	gitignoreContent: string,
	pattern: string,
): boolean {
	const lines = gitignoreContent.split("\n").map((line) => line.trim());
	const normalizedPattern = pattern.replace(/^\//, "").replace(/\/$/, "");

	for (const line of lines) {
		// Skip comments and empty lines
		if (line.startsWith("#") || line === "") {
			continue;
		}
		const normalizedLine = line.replace(/^\//, "").replace(/\/$/, "");
		if (normalizedLine === normalizedPattern) {
			return true;
		}
	}
	return false;
}

/**
 * Update .gitignore to include the data directory.
 * Creates .gitignore if it doesn't exist.
 * Returns true if the file was modified, false if pattern was already present.
 */
function updateGitignore(
	cwd: string,
	dataDir: string,
): { updated: boolean; created: boolean } {
	const gitignorePath = path.join(cwd, ".gitignore");
	const pattern = `${dataDir}/`;

	let gitignoreContent = "";
	let fileExists = false;

	if (fs.existsSync(gitignorePath)) {
		fileExists = true;
		gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");

		// Check if pattern is already present
		if (isPatternInGitignore(gitignoreContent, dataDir)) {
			return { updated: false, created: false };
		}
	}

	// Append the pattern to .gitignore
	const newContent = fileExists
		? gitignoreContent.endsWith("\n")
			? `${gitignoreContent}# ProseQL data directory\n${pattern}\n`
			: `${gitignoreContent}\n\n# ProseQL data directory\n${pattern}\n`
		: `# ProseQL data directory\n${pattern}\n`;

	fs.writeFileSync(gitignorePath, newContent, "utf-8");

	return { updated: true, created: !fileExists };
}

/**
 * Options for the init command.
 */
export interface InitOptions {
	readonly format?: string;
	readonly cwd?: string;
}

/**
 * Result of the init command.
 */
export interface InitResult {
	readonly success: boolean;
	readonly message: string;
	readonly createdFiles?: readonly string[];
}

/**
 * Execute the init command.
 *
 * Checks for existing config files and aborts if found.
 * Creates proseql.config.ts with an example collection definition.
 *
 * @param options - Init command options
 * @returns Result indicating success or failure
 */
export function runInit(options: InitOptions = {}): InitResult {
	const cwd = options.cwd ?? process.cwd();
	const format = options.format ?? "json";

	// Validate format
	const validFormats = ["json", "yaml", "toml"];
	if (!validFormats.includes(format)) {
		return {
			success: false,
			message: `Invalid format: ${format}. Valid formats are: ${validFormats.join(", ")}`,
		};
	}

	// Check for existing config file
	const existingConfig = findExistingConfig(cwd);

	if (existingConfig !== null) {
		return {
			success: false,
			message: `A proseql config file already exists: ${existingConfig}\nTo reinitialize, remove the existing config first.`,
		};
	}

	const createdFiles: string[] = [];

	// Task 3.2: Scaffold proseql.config.ts with example collection
	const configPath = path.join(cwd, DEFAULT_CONFIG_FILE);
	const configContent = generateConfigContent(format);

	try {
		fs.writeFileSync(configPath, configContent, "utf-8");
		createdFiles.push(DEFAULT_CONFIG_FILE);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message: `Failed to create config file: ${message}`,
		};
	}

	// Task 3.3: Create data/ directory with example data file
	const dataDir = path.join(cwd, "data");
	const extension = FORMAT_EXTENSIONS[format as DataFormat];
	const dataFilePath = path.join(dataDir, `notes.${extension}`);

	try {
		// Create data directory if it doesn't exist
		if (!fs.existsSync(dataDir)) {
			fs.mkdirSync(dataDir, { recursive: true });
		}
		createdFiles.push("data/");

		// Generate and write example document-source data file
		const exampleData = toDocumentSourceData(generateExampleData());
		const dataContent = serializeExampleData(exampleData, format as DataFormat);
		fs.writeFileSync(dataFilePath, dataContent, "utf-8");
		createdFiles.push(`data/notes.${extension}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message: `Failed to create data directory or file: ${message}`,
		};
	}

	// Task 3.4: Detect .git directory and update .gitignore
	if (isGitRepository(cwd)) {
		try {
			const gitignoreResult = updateGitignore(cwd, "data");
			if (gitignoreResult.created) {
				createdFiles.push(".gitignore");
			} else if (gitignoreResult.updated) {
				createdFiles.push(".gitignore (updated)");
			}
			// If neither created nor updated, the pattern was already present - nothing to report
		} catch (error) {
			// Non-fatal: warn but don't fail the init
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Warning: Could not update .gitignore: ${message}`);
		}
	}

	return {
		success: true,
		message: "ProseQL project initialized successfully!",
		createdFiles,
	};
}

/**
 * Print a formatted summary of the init operation to stdout.
 * Displays the created files in a clear, user-friendly format.
 */
function printInitSummary(result: InitResult): void {
	console.log("");
	console.log(result.message);
	console.log("");

	if (result.createdFiles && result.createdFiles.length > 0) {
		console.log("Created files:");
		for (const file of result.createdFiles) {
			// Use different indicators for different file types
			if (file.endsWith("/")) {
				console.log(`  + ${file.slice(0, -1)}/ (directory)`);
			} else if (file.includes("(updated)")) {
				console.log(`  ~ ${file.replace(" (updated)", "")} (updated)`);
			} else {
				console.log(`  + ${file}`);
			}
		}
		console.log("");
	}

	console.log("Next steps:");
	console.log("  1. Edit proseql.config.ts to define your collections");
	console.log("  2. Run 'proseql query notes' to see example data");
	console.log("  3. Run 'proseql --help' for available commands");
	console.log("");
}

/**
 * Handle the init command from CLI main.ts
 * This is the entry point called by the command dispatcher.
 */
export async function handleInit(options: InitOptions = {}): Promise<void> {
	const result = runInit(options);

	if (!result.success) {
		console.error(`Error: ${result.message}`);
		process.exit(1);
	}

	printInitSummary(result);
}
