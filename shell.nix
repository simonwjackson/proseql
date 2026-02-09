{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  buildInputs = with pkgs; [
    bun
    pnpm
    biome
    typescript
    just
    git
    curl
  ];

  shellHook = ''
  '';

  NODE_ENV = "development";
  NPM_CONFIG_FUND = "false";
  NPM_CONFIG_AUDIT = "false";
  FORCE_COLOR = "1";
}
