{
  description = "proseql - Type-safe relational database that persists to plain text files";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix?ref=refs/tags/1.5.2";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      bun2nix,
      rust-overlay,
    }:
    let
      sourceRoot = /. + builtins.toString ./.;
      sourceFilter =
        path: type:
        let
          relativePath = nixpkgs.lib.removePrefix "${builtins.toString sourceRoot}/" (builtins.toString path);
          baseName = builtins.baseNameOf (builtins.toString path);
        in
        !(baseName == ".git" || baseName == "node_modules" || baseName == "dist" || baseName == "target")
        && !(nixpkgs.lib.hasSuffix ".tsbuildinfo" baseName)
        && !(
          relativePath == "packages/engine/build"
          || nixpkgs.lib.hasPrefix "packages/engine/build/" relativePath
        )
        && !(relativePath == "bench/generated" || nixpkgs.lib.hasPrefix "bench/generated/" relativePath)
        && !(
          relativePath == "bench/reports/raw" || nixpkgs.lib.hasPrefix "bench/reports/raw/" relativePath
        );
      source = builtins.path {
        path = sourceRoot;
        name = "proseql-source";
        filter = sourceFilter;
      };
      # The store-path prefix is derived from the complete filtered source NAR,
      # not a declared revision string, and is emitted with browser bundles.
      sourceIdentity = builtins.baseNameOf (builtins.toString source);
      wasmBindgenVersion = "0.2.126";
      wasmBindgenBinaryAssets = {
        x86_64-linux = {
          target = "x86_64-unknown-linux-musl";
          hash = "sha256-BklI1Y4tbAp0UhZHemObppYhbWMJqqkCk50bhlsdhp0=";
        };
      };
      rustToolchainFor =
        pkgs:
        pkgs.rust-bin.fromRustupToolchain {
          channel = "1.92.0";
          profile = "minimal";
          components = [
            "clippy"
            "rustfmt"
            "rust-src"
          ];
          targets = [ "wasm32-unknown-unknown" ];
        };
      rustPlatformFor =
        pkgs:
        pkgs.makeRustPlatform {
          cargo = rustToolchainFor pkgs;
          rustc = rustToolchainFor pkgs;
        };
      chromiumPackageFor =
        pkgs:
        if pkgs.stdenv.isLinux then
          pkgs.chromium
        else
          pkgs.writeShellScriptBin "chromium" ''
            echo >&2 "Chromium is only pinned for Linux in this repository shell."
            exit 1
          '';
      # Development tools shared by the shells and by the `nix run .#<task>` apps.
      toolingFor =
        {
          pkgs,
          bun2nixPkgs,
          system,
        }:
        let
          wasmBindgenCli = self.packages.${system}.wasm-bindgen-cli;
          chromiumPackage = chromiumPackageFor pkgs;
        in
        {
          packages = [
            pkgs.bun
            pkgs.nodejs
            pkgs.biome
            pkgs.actionlint
            pkgs.shellcheck
            bun2nixPkgs.default
            pkgs.git
            pkgs.gh
            pkgs.lefthook
            (rustToolchainFor pkgs)
            pkgs.lld
            pkgs.binaryen
            chromiumPackage
            wasmBindgenCli
          ];
          env = {
            PROSEQL_NIX_TOOLING = "1";
            PROSEQL_WASM_BINDGEN_BIN = "${wasmBindgenCli}/bin/wasm-bindgen";
            PROSEQL_WASM_BINDGEN_VERSION = wasmBindgenVersion;
            PROSEQL_WASM_OPT_BIN = "${pkgs.binaryen}/bin/wasm-opt";
            PROSEQL_WASM_OPT_VERSION = pkgs.binaryen.version;
            CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER = "${pkgs.lld}/bin/wasm-ld";
            CHROMIUM_EXECUTABLE_PATH = "${chromiumPackage}/bin/chromium";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            NODE_ENV = "development";
          };
        };
      # Repository tasks. Run one with `nix run .#<task> [-- args]`, or with
      # `proseql-task <task> [args]` inside `nix develop`. `nix run .` lists them.
      taskNames = [
        "test"
        "test-core"
        "test-node"
        "test-effect"
        "coverage"
        "coverage-core"
        "coverage-node"
        "typecheck"
        "verify-packages"
        "browser-smoke"
        "browser-budget"
        "parity-corpus"
        "parity-examples"
        "parity-gate"
        "workflow-lint"
        "lint"
        "format"
        "clean"
        "build-release-artifacts"
        "release-check"
        "release-prepare"
        "release-finalize"
        "publish-packages"
        "rust-check"
        "rust-test"
        "rust-lint"
        "rust-format"
        "rust-format-check"
        "rust-wasm-check"
        "rust-build"
        "bench-timeseries"
      ];
      taskRunnerFor =
        { pkgs, tooling }:
        pkgs.writeShellApplication {
          name = "proseql-task";
          # `nix develop` adds the stdenv compiler implicitly; apps need it for
          # Cargo build scripts and linking.
          runtimeInputs = tooling.packages ++ [
            pkgs.stdenv.cc
            pkgs.coreutils
          ];
          # Tasks take arguments through the dynamic dispatch at the end, which
          # shellcheck cannot follow; release-check calls them without arguments.
          excludeShellChecks = [
            "SC2119"
            "SC2120"
          ];
          text = ''
            ${nixpkgs.lib.concatStringsSep "\n" (
              nixpkgs.lib.mapAttrsToList (
                name: value: "export ${name}=${nixpkgs.lib.escapeShellArg value}"
              ) tooling.env
            )}
            cd "$(git rev-parse --show-toplevel)"

            # Test Korri-ready foundation paths (accepts extra bun test args)
            task_test() {
              bun test \
                ./bench/browser-runner.test.ts \
                ./bench/runner.test.ts \
                ./packages/engine/tests/boundary-values.test.ts \
                ./packages/engine/tests/browser-entry.test.ts \
                ./packages/engine/tests/browser-persistence-concurrency.test.ts \
                ./packages/engine/tests/engine-duplicate-ids.test.ts \
                ./packages/engine/tests/engine-time-bucket.test.ts \
                ./packages/engine/tests/engine-ordered-index.test.ts \
                ./packages/engine/tests/engine-u8.test.ts \
                ./packages/engine/tests/engine.test.ts \
                ./packages/engine/tests/loader.test.ts \
                ./packages/engine/tests/materialized-projection.test.ts \
                ./packages/effect/tests/effect.test.ts \
                ./packages/browser/tests/browser-entry.test.ts \
                ./packages/rpc/tests/rpc-group.test.ts \
                ./packages/rpc/tests/rpc-handlers.test.ts \
                ./packages/rpc/tests/rpc-streaming.test.ts \
                ./packages/rpc/tests/multi-collection-namespacing.test.ts \
                ./packages/rpc/tests/rpc-wire-contract.test.ts \
                ./scripts/verify-package-artifacts.test.ts \
                ./scripts/verify-packed-packages.test.ts \
                ./scripts/release.test.ts \
                ./scripts/release-check-wiring.test.ts \
                ./scripts/publish-workflow.test.ts \
                packages/core/tests/database-effect.test.ts \
                packages/core/tests/database-source-config.test.ts \
                packages/core/tests/database-document-graph.test.ts \
                packages/core/tests/debounced-writer.test.ts \
                packages/core/tests/deep-merge.test.ts \
                packages/core/tests/derived-id.test.ts \
                packages/core/tests/document-graph-config.test.ts \
                packages/core/tests/document-graph-source.test.ts \
                packages/core/tests/file-watcher.test.ts \
                packages/core/tests/glob-match.test.ts \
                packages/core/tests/infer-codecs.test.ts \
                packages/core/tests/ordered-indexes-config.test.ts \
                packages/core/tests/schema-validation.test.ts \
                packages/core/tests/schema-migrations.test.ts \
                packages/core/tests/serializer-service.test.ts \
                packages/core/tests/source-config.test.ts \
                packages/core/tests/time-bucket-partitions.test.ts \
                packages/core/tests/transactions.test.ts \
                packages/node/tests/convenience.test.ts \
                packages/node/tests/derived-id-convenience.test.ts \
                packages/node/tests/document-graph.test.ts \
                packages/rest/tests/handlers.test.ts \
                packages/cli/tests/ \
                "$@"
            }

            # Test one package only
            task_test_core() { bun test packages/core/tests/ "$@"; }
            task_test_node() { bun test packages/node/tests/ "$@"; }
            task_test_effect() { bun test packages/effect/tests/ "$@"; }

            # Test with coverage
            task_coverage() { bun test --coverage packages/*/tests/; }
            task_coverage_core() { bun test --coverage packages/core/tests/; }
            task_coverage_node() { bun test --coverage packages/node/tests/; }

            task_typecheck() { bun run tsc --build; }

            # Verify npm packages include required built artifacts and browser smoke coverage
            task_verify_packages() { bun run verify:packages; }

            # Run the real-browser smoke suite against the built browser packages
            task_browser_smoke() { bun run verify:browser; }

            # Capture and enforce fresh Chromium startup, memory, interaction, and WASM artifact budgets
            task_browser_budget() {
              rm -rf .artifacts/browser
              mkdir -p .artifacts/browser
              bun run bench/browser-runner.ts > .artifacts/browser/current.json
              bun run scripts/verify-package-artifacts.ts --u2-browser-budget-gate --current-report .artifacts/browser/current.json --output .artifacts/browser/evidence.json
            }

            # Run the first U9 parity corpus slice and emit a machine-readable report
            task_parity_corpus() { bun run packages/effect/scripts/run-corpus.mjs; }

            # Run examples 01-16 where compatible and emit a machine-readable report
            task_parity_examples() { bun run packages/effect/scripts/run-examples.mjs; }

            # Run the U9 parity gate end-to-end
            task_parity_gate() {
              bun run tsc --build
              (cd packages/effect && bun run typecheck:tests)
              bun test packages/effect/tests/
              bun run packages/effect/scripts/run-corpus.mjs
              bun run packages/effect/scripts/run-examples.mjs
              bun run packages/effect/scripts/validate-parity-reports.mjs
            }

            # Validate GitHub Actions structure and every embedded shell script
            task_workflow_lint() { actionlint -shellcheck shellcheck .github/workflows/*.yml; }

            # Lint and format-check every coordinated release source, script, and manifest
            task_lint() {
              biome check --config-path=./biome.json \
                bench/browser-aggregation.ts \
                bench/browser-runner.ts \
                bench/browser-runner.test.ts \
                packages/{core,engine,node,rest,effect,cli,browser,rpc}/src \
                packages/{engine,effect}/scripts \
                scripts \
                package.json \
                packages/{core,engine,node,rest,effect,cli,browser,rpc}/package.json \
                packages/{core,engine,node,rest,effect,cli,browser,rpc}/tsconfig.json \
                tsconfig.json \
                tsconfig.base.json \
                biome.json \
                .github/workflows/ci.yml \
                .github/workflows/publish.yml
            }

            task_format() { biome format --write .; }

            task_clean() {
              rm -rf packages/*/dist packages/*/*.tsbuildinfo ./*.tsbuildinfo dist/**/*.tsbuildinfo
            }

            # Build the publishable TypeScript packages and pinned production/profile WASM artifacts from clean source
            task_build_release_artifacts() {
              task_clean
              bun run copy-license
              bun run --cwd packages/engine build:wasm
              bun run tsc --build
              chmod +x packages/cli/dist/main.js
            }

            # Non-destructive release readiness: never publishes, pushes, tags, or requires npm credentials
            task_release_check() {
              bun install --frozen-lockfile --ignore-scripts
              task_workflow_lint
              task_lint
              task_build_release_artifacts
              task_typecheck
              task_test
              task_rust_format_check
              task_rust_check
              task_rust_test
              task_rust_lint
              task_rust_wasm_check
              task_parity_gate
              rm -rf .artifacts/release-check
              mkdir -p .artifacts/release-check
              bun run scripts/verify-packed-packages.ts --skip-build --output .artifacts/release-check
              task_browser_smoke
              task_browser_budget
            }

            # Prepare reversible version/changelog edits (auto-detects bump, or pass patch/minor/major); never builds, commits, pushes, tags, or publishes
            task_release_prepare() { bun run scripts/release.ts prepare "$@"; }

            # From a clean reviewed commit, run all gates and bind exact tarballs to HEAD; never commits, pushes, tags, or publishes
            task_release_finalize() { bun run scripts/release.ts finalize; }

            # Inspect prepared registry state by default; destructive modes require explicit flags and PROSEQL_PUBLISH_APPROVAL
            task_publish_packages() { bun run scripts/publisher-entry.ts "$@"; }

            # Rust engine (crates/)
            task_rust_check() { cargo check --manifest-path crates/Cargo.toml; }

            # Run the Rust engine test suite with bounded, overrideable Cargo and libtest concurrency
            task_rust_test() {
              CARGO_BUILD_JOBS="''${CARGO_BUILD_JOBS:-1}" RUST_TEST_THREADS="''${RUST_TEST_THREADS:-1}" cargo test --manifest-path crates/Cargo.toml "$@"
            }

            task_rust_lint() { cargo clippy --manifest-path crates/Cargo.toml --all-targets -- -D warnings; }
            task_rust_format() { cargo fmt --manifest-path crates/Cargo.toml; }
            task_rust_format_check() { cargo fmt --manifest-path crates/Cargo.toml --all --check; }

            # Check the WASM boundary crate for its production target
            task_rust_wasm_check() {
              cargo check --manifest-path crates/Cargo.toml -p proseql-wasm --target wasm32-unknown-unknown
            }

            task_rust_build() { cargo build --release --manifest-path crates/Cargo.toml; }

            # Benchmark a partitioned JSONL time series at 140k/1M/10M synthetic rows in lazy mode
            # (the acceptance run; data cached under /var/tmp; later flags override, e.g. --mode baseline)
            task_bench_timeseries() {
              cargo run --release --manifest-path crates/Cargo.toml -p proseql-native --example timeseries_bench -- --rows 140000,1000000,10000000 --years 10 --mode lazy "$@"
            }

            task="''${1:-}"
            case "$task" in
              "" | help | list)
                echo "Usage: nix run .#<task> [-- args], or proseql-task <task> [args] inside nix develop"
                echo "Tasks: ${nixpkgs.lib.concatStringsSep " " taskNames}"
                exit 0
                ;;
            esac
            shift
            fn="task_''${task//-/_}"
            if ! declare -F "$fn" > /dev/null; then
              echo "proseql-task: unknown task '$task'. Run 'nix run .' to list tasks." >&2
              exit 2
            fi
            "$fn" "$@"
          '';
        };
      forAllSystems =
        function:
        nixpkgs.lib.genAttrs (import systems) (
          system:
          function {
            inherit system;
            pkgs = import nixpkgs {
              inherit system;
              overlays = [ rust-overlay.overlays.default ];
            };
            bun2nixPkgs = bun2nix.packages.${system};
          }
        );
    in
    {
      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixfmt-rfc-style);

      apps = forAllSystems (
        {
          pkgs,
          bun2nixPkgs,
          system,
        }:
        let
          runner = taskRunnerFor {
            inherit pkgs;
            tooling = toolingFor { inherit pkgs bun2nixPkgs system; };
          };
          appFor = task: {
            type = "app";
            program = "${pkgs.writeShellScript "proseql-${task}" ''exec ${runner}/bin/proseql-task ${task} "$@"''}";
            meta.description = "Run the proseql ${task} task";
          };
        in
        nixpkgs.lib.genAttrs taskNames appFor
        // {
          default = {
            type = "app";
            program = "${runner}/bin/proseql-task";
            meta.description = "List the proseql tasks";
          };
        }
      );

      packages = forAllSystems (
        {
          pkgs,
          system,
          ...
        }:
        let
          mkBunDerivation = bun2nix.lib.${system}.mkBunDerivation;
          rustPlatform = rustPlatformFor pkgs;
          wasmBindgenAsset = wasmBindgenBinaryAssets.${system} or null;
          pinnedWasmBindgenCli =
            if pkgs.wasm-bindgen-cli.version == wasmBindgenVersion then
              pkgs.wasm-bindgen-cli
            else if wasmBindgenAsset == null then
              pkgs.writeShellScriptBin "wasm-bindgen" ''
                echo >&2 "No pinned wasm-bindgen-cli ${wasmBindgenVersion} package is defined for ${system}."
                echo >&2 "Extend flake.nix or provide PROSEQL_WASM_BINDGEN_BIN explicitly."
                exit 1
              ''
            else
              pkgs.stdenvNoCC.mkDerivation {
                pname = "wasm-bindgen-cli";
                version = wasmBindgenVersion;
                src = pkgs.fetchurl {
                  url = "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${wasmBindgenVersion}/wasm-bindgen-${wasmBindgenVersion}-${wasmBindgenAsset.target}.tar.gz";
                  hash = wasmBindgenAsset.hash;
                };
                dontUnpack = true;
                installPhase = ''
                  runHook preInstall
                  mkdir -p $out/bin
                  tar -xzf $src -C $TMPDIR
                  source_dir=$(find $TMPDIR -maxdepth 1 -type d -name 'wasm-bindgen-*' | head -n 1)
                  cp "$source_dir"/wasm-bindgen "$out/bin/wasm-bindgen"
                  cp "$source_dir"/wasm-bindgen-test-runner "$out/bin/wasm-bindgen-test-runner"
                  cp "$source_dir"/wasm2es6js "$out/bin/wasm2es6js"
                  cp "$source_dir"/README.md "$out/README.md"
                  cp "$source_dir"/LICENSE-APACHE "$out/LICENSE-APACHE"
                  cp "$source_dir"/LICENSE-MIT "$out/LICENSE-MIT"
                  chmod +x $out/bin/*
                  runHook postInstall
                '';
              };
        in
        rec {
          browser = pkgs.callPackage ./packages/browser/default.nix {
            inherit mkBunDerivation sourceIdentity;
            wasmArtifacts = engine-wasm-artifacts;
          };
          core = pkgs.callPackage ./packages/core/default.nix { inherit mkBunDerivation; };
          node = pkgs.callPackage ./packages/node/default.nix { inherit mkBunDerivation; };
          rest = pkgs.callPackage ./packages/rest/default.nix { inherit mkBunDerivation; };
          rpc = pkgs.callPackage ./packages/rpc/default.nix { inherit mkBunDerivation; };
          # The engine workspace, built and tested the same way the TypeScript
          # packages are. proseql-wasm is left out: it targets wasm32 and has
          # nothing to say when built for the host.
          rust = pkgs.callPackage ./crates/package.nix { };
          wasm-bindgen-cli = pinnedWasmBindgenCli;
          engine-wasm-artifacts = rustPlatform.buildRustPackage {
            pname = "proseql-engine-wasm-artifacts";
            version = "0.1.0";
            src = source;
            cargoRoot = "crates";
            cargoLock = {
              lockFile = ./crates/Cargo.lock;
            };
            nativeBuildInputs = [
              pkgs.bun
              pkgs.nodejs
              pkgs.binaryen
              pkgs.lld
              wasm-bindgen-cli
            ];
            strictDeps = true;
            doCheck = false;
            buildPhase = ''
              runHook preBuild
              export HOME=$(mktemp -d)
              export PROSEQL_NIX_TOOLING=1
              export PROSEQL_WASM_BINDGEN_BIN=${wasm-bindgen-cli}/bin/wasm-bindgen
              export PROSEQL_WASM_OPT_BIN=${pkgs.binaryen}/bin/wasm-opt
              export PROSEQL_WASM_OPT_VERSION=${pkgs.binaryen.version}
              export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER=${pkgs.lld}/bin/wasm-ld
              bun packages/engine/scripts/build-wasm.mjs
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out/dist $out/build
              cp -r packages/engine/dist/wasm $out/dist/
              cp -r packages/engine/dist/browser-wasm $out/dist/
              cp -r packages/engine/build/wasm-profile $out/build/
              cp -r packages/engine/build/browser-wasm-profile $out/build/
              cp -r packages/engine/build/wasm-panic-test $out/build/
              cp packages/engine/build/wasm-build-report.json $out/build/
              cp packages/engine/package.json $out/package.json
              runHook postInstall
            '';
          };
          default = core;
        }
      );

      devShells = forAllSystems (
        {
          pkgs,
          bun2nixPkgs,
          system,
          ...
        }:
        let
          tooling = toolingFor { inherit pkgs bun2nixPkgs system; };
          toolingPackages = tooling.packages ++ [ (taskRunnerFor { inherit pkgs tooling; }) ];
          toolingEnv = tooling.env;
        in
        {
          default = pkgs.mkShell (
            {
              packages = toolingPackages;

              shellHook = ''
                echo "proseql development environment"
                git config --local core.hooksPath .git/hooks
                lefthook install --force
              '';
            }
            // toolingEnv
          );

          tooling = pkgs.mkShell ({ packages = toolingPackages; } // toolingEnv);
        }
      );

      checks = forAllSystems (
        {
          pkgs,
          system,
          ...
        }:
        let
          mkBunDerivation = bun2nix.lib.${system}.mkBunDerivation;
          wasmArtifacts = self.packages.${system}.engine-wasm-artifacts;
          browserBundle = self.packages.${system}.browser;
          chromiumPackage = chromiumPackageFor pkgs;
        in
        {
          # Building the crates runs their tests, so this gates the Rust side
          # of `nix flake check` alongside the TypeScript suite.
          rust = pkgs.callPackage ./crates/package.nix { };

          browser-offline-consumer =
            pkgs.runCommand "proseql-browser-offline-consumer"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                PROSEQL_SOURCE_IDENTITY = sourceIdentity;
              }
              ''
                export HOME=$(mktemp -d)
                mkdir -p fixture
                cp -a ${browserBundle}/closure/node_modules fixture/
                cat > fixture/package.json <<'EOF'
                {"private":true,"type":"module"}
                EOF
                cat > fixture/smoke.mjs <<'EOF'
                import * as browser from "@proseql/browser";
                import * as worker from "@proseql/browser/worker";
                if (typeof browser.createPersistentEngineDatabase !== "function") throw new Error("missing browser database");
                if (typeof worker.createServiceWorkerEngineDatabase !== "function") throw new Error("missing worker database");
                process.exit(0);
                EOF
                (cd fixture && node --no-addons smoke.mjs)
                test -f fixture/node_modules/@proseql/engine/dist/browser-wasm/proseql_wasm_bg.wasm
                grep -F "$PROSEQL_SOURCE_IDENTITY" ${browserBundle}/source-identity.json
                mkdir -p $out
                cp ${browserBundle}/source-identity.json $out/
              '';

          default = mkBunDerivation {
            pname = "proseql-checks";
            version = "0.1.0";
            src = source;
            bunNix = ./bun.nix;

            nativeBuildInputs = [
              pkgs.typescript
              pkgs.nodejs
              chromiumPackage
            ];

            buildPhase = ''
              runHook preBuild
              export HOME=$(mktemp -d)
              export PROSEQL_NIX_TOOLING=1
              export PROSEQL_PREBUILT_WASM_ARTIFACTS_DIR=${wasmArtifacts}
              export CHROMIUM_EXECUTABLE_PATH=${chromiumPackage}/bin/chromium
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
              rm -rf packages/engine/build packages/engine/dist/wasm packages/engine/dist/browser-wasm
              mkdir -p packages/engine/dist packages/engine/build
              cp -r ${wasmArtifacts}/dist/wasm packages/engine/dist/
              cp -r ${wasmArtifacts}/dist/browser-wasm packages/engine/dist/
              cp -r ${wasmArtifacts}/build/wasm-profile packages/engine/build/
              cp -r ${wasmArtifacts}/build/browser-wasm-profile packages/engine/build/
              cp -r ${wasmArtifacts}/build/wasm-panic-test packages/engine/build/
              cp ${wasmArtifacts}/build/wasm-build-report.json packages/engine/build/
              bun run build
              bun test \
                ./packages/core/tests/database-effect.test.ts \
                ./packages/core/tests/database-source-config.test.ts \
                ./packages/core/tests/database-document-graph.test.ts \
                ./packages/core/tests/debounced-writer.test.ts \
                ./packages/core/tests/deep-merge.test.ts \
                ./packages/core/tests/derived-id.test.ts \
                ./packages/core/tests/document-graph-config.test.ts \
                ./packages/core/tests/document-graph-source.test.ts \
                ./packages/core/tests/file-watcher.test.ts \
                ./packages/core/tests/glob-match.test.ts \
                ./packages/core/tests/infer-codecs.test.ts \
                ./packages/core/tests/schema-validation.test.ts \
                ./packages/core/tests/schema-migrations.test.ts \
                ./packages/core/tests/serializer-service.test.ts \
                ./packages/core/tests/source-config.test.ts \
                ./packages/core/tests/transactions.test.ts
              bun test ./packages/ai/tests/ ./packages/cli/tests/
              bun test ./packages/node/tests/ ./packages/rest/tests/
              bun test ./packages/engine/tests/
              bun test ./packages/browser/tests/
              bun test ./packages/effect/tests/
              bun run verify:packages
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out
              echo "All checks passed" > $out/result
              runHook postInstall
            '';
          };
        }
      );
    };
}
