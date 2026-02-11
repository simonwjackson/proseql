{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-node";
  version = "0.1.0";
  src = ../../.;
  bunNix = ../../bun.nix;
  workspaceRoot = ../../.;
}
