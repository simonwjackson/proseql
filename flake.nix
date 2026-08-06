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
          browser = pkgs.callPackage ./packages/browser/default.nix { inherit mkBunDerivation; };
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
          wasmBindgenCli = self.packages.${system}.wasm-bindgen-cli;
          chromiumPackage = chromiumPackageFor pkgs;
          toolingPackages = [
            pkgs.bun
            pkgs.nodejs
            pkgs.biome
            pkgs.actionlint
            pkgs.shellcheck
            pkgs.just
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
          toolingEnv = {
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
          chromiumPackage = chromiumPackageFor pkgs;
        in
        {
          # Building the crates runs their tests, so this gates the Rust side
          # of `nix flake check` alongside the TypeScript suite.
          rust = pkgs.callPackage ./crates/package.nix { };

          default = mkBunDerivation {
            pname = "proseql-checks";
            version = "0.1.0";
            src = source;
            bunNix = ./bun.nix;

            nativeBuildInputs = [
              pkgs.typescript
              pkgs.just
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
