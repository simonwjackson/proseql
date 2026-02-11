{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-core";
  version = "0.1.0";
  src = ../../.;
  bunNix = ../../bun.nix;
  workspaceRoot = ../../.;
}
