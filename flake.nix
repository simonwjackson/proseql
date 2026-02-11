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
            pkgs = nixpkgs.legacyPackages.${system};
            bun2nixPkgs = bun2nix.packages.${system};
          }
        );
    in
    {
      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixfmt-rfc-style);

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
    };
}
