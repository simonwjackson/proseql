#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const repoRoot = resolve(packageDir, "..", "..");
const cratesDir = join(repoRoot, "crates");
const wasmCrate = join(cratesDir, "proseql-wasm", "Cargo.toml");
const nodeOutDir = join(packageDir, "dist", "wasm");
const browserOutDir = join(packageDir, "dist", "browser-wasm");
const bindgenRoot = join(packageDir, ".wasm-bindgen-cli");
const bindgenBin = join(bindgenRoot, "bin", "wasm-bindgen");
const wasmBindgenVersion = "0.2.126";
const targetWasm = join(
  cratesDir,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "proseql_wasm.wasm",
);

mkdirSync(nodeOutDir, { recursive: true });
mkdirSync(browserOutDir, { recursive: true });

const cargoArgs = [
  "build",
  "--manifest-path",
  wasmCrate,
  "-p",
  "proseql-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
];
const nodeBindgenArgs = [
  "--target",
  "experimental-nodejs-module",
  "--out-dir",
  nodeOutDir,
  targetWasm,
];
const browserBindgenArgs = [
  "--target",
  "web",
  "--out-dir",
  browserOutDir,
  targetWasm,
];

if (hasExecutable("cargo") && hasExecutable("lld")) {
  run("cargo", cargoArgs);
} else {
  run("nix", [
    "shell",
    "nixpkgs#cargo",
    "nixpkgs#rustc",
    "nixpkgs#lld",
    "-c",
    "cargo",
    ...cargoArgs,
  ]);
}

if (!existsSync(targetWasm)) {
  throw new Error(`Missing compiled wasm artifact: ${targetWasm}`);
}

ensureMatchingBindgen();
run(bindgenBin, nodeBindgenArgs);
run(bindgenBin, browserBindgenArgs);

function hasExecutable(name) {
  try {
    execFileSync("sh", ["-lc", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasMatchingBindgen(path) {
  try {
    const version = execFileSync(path, ["--version"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return version === `wasm-bindgen ${wasmBindgenVersion}`;
  } catch {
    return false;
  }
}

function ensureMatchingBindgen() {
  if (hasMatchingBindgen(bindgenBin)) {
    return;
  }
  if (hasExecutable("wasm-bindgen") && hasMatchingBindgen("wasm-bindgen")) {
    mkdirSync(dirname(bindgenBin), { recursive: true });
    run("sh", ["-lc", `ln -sf $(command -v wasm-bindgen) ${shellEscape(bindgenBin)}`]);
    return;
  }
  run("nix", [
    "shell",
    "nixpkgs#cargo",
    "nixpkgs#rustc",
    "nixpkgs#lld",
    "-c",
    "cargo",
    "install",
    "wasm-bindgen-cli",
    "--version",
    wasmBindgenVersion,
    "--root",
    bindgenRoot,
    "--force",
  ]);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env },
  });
}
