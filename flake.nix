{
  description = "proseql - Type-safe relational database that persists to plain text files";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix";
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
            pkgs = import nixpkgs {
              inherit system;
              overlays = [ bun2nix.overlays.default ];
            };
            bun2nixPkgs = bun2nix.packages.${system};
          }
        );
    in
    {
      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixfmt-rfc-style);

      packages = forAllSystems (
        { pkgs, ... }:
        {
          core = pkgs.callPackage ./packages/core/default.nix { };
          node = pkgs.callPackage ./packages/node/default.nix { };
          rest = pkgs.callPackage ./packages/rest/default.nix { };
          rpc = pkgs.callPackage ./packages/rpc/default.nix { };
          default = pkgs.callPackage ./packages/core/default.nix { };
        }
      );

      devShells = forAllSystems (
        { pkgs, bun2nixPkgs }:
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.biome
              pkgs.just
              bun2nixPkgs.default
              pkgs.git
            ];

            shellHook = ''
              echo "proseql development environment"
            '';

            NODE_ENV = "development";
          };
        }
      );

      checks = forAllSystems (
        { pkgs, ... }:
        {
          default = pkgs.stdenvNoCC.mkDerivation {
            name = "proseql-checks";
            src = ./.;

            nativeBuildInputs = [ pkgs.bun ];

            buildPhase = ''
              export HOME=$(mktemp -d)
              bun install --frozen-lockfile
              bun test packages/*/tests/
              bunx tsc --build
            '';

            installPhase = ''
              mkdir -p $out
              echo "All checks passed" > $out/result
            '';
          };
        }
      );
    };
}
