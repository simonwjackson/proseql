{
  description = "proseql - Type-safe relational database that persists to plain text files";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix?ref=refs/tags/1.5.2";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      bun2nix,
    }:
    let
      forAllSystems =
        function:
        nixpkgs.lib.genAttrs (import systems) (
          system:
          function {
            inherit system;
            pkgs = import nixpkgs {
              inherit system;
            };
            bun2nixPkgs = bun2nix.packages.${system};
          }
        );
    in
    {
      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixfmt-rfc-style);

      packages = forAllSystems (
        { pkgs, system, ... }:
        let
          mkBunDerivation = bun2nix.lib.${system}.mkBunDerivation;
        in
        {
          browser = pkgs.callPackage ./packages/browser/default.nix { inherit mkBunDerivation; };
          core = pkgs.callPackage ./packages/core/default.nix { inherit mkBunDerivation; };
          node = pkgs.callPackage ./packages/node/default.nix { inherit mkBunDerivation; };
          rest = pkgs.callPackage ./packages/rest/default.nix { inherit mkBunDerivation; };
          rpc = pkgs.callPackage ./packages/rpc/default.nix { inherit mkBunDerivation; };
          default = pkgs.callPackage ./packages/core/default.nix { inherit mkBunDerivation; };

          # The engine workspace, built and tested the same way the TypeScript
          # packages are. proseql-wasm is left out: it targets wasm32 and has
          # nothing to say when built for the host.
          rust = pkgs.callPackage ./crates/package.nix { };
        }
      );

      devShells = forAllSystems (
        { pkgs, bun2nixPkgs, ... }:
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.biome
              pkgs.just
              bun2nixPkgs.default
              pkgs.git
              pkgs.gh
              pkgs.lefthook
              # Rust toolchain for the proseql-engine crate workspace (crates/)
              pkgs.rustc
              pkgs.cargo
              pkgs.rustfmt
              pkgs.clippy
            ];

            shellHook = ''
              echo "proseql development environment"
              git config --local core.hooksPath .git/hooks
              lefthook install --force
            '';

            NODE_ENV = "development";
          };
        }
      );

      checks = forAllSystems (
        { pkgs, system, ... }:
        let
          mkBunDerivation = bun2nix.lib.${system}.mkBunDerivation;
        in
        {
          # Building the crates runs their tests, so this gates the Rust side
          # of `nix flake check` alongside the TypeScript suite.
          rust = pkgs.callPackage ./crates/package.nix { };

          default = mkBunDerivation {
            pname = "proseql-checks";
            version = "0.1.0";
            src = ./.;
            bunNix = ./bun.nix;

            nativeBuildInputs = [ pkgs.typescript ];

            buildPhase = ''
              runHook preBuild
              export HOME=$(mktemp -d)
              bun test packages/*/tests/
              bunx tsc --build
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
