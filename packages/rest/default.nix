{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-rest";
  version = "0.0.0";
  src = ../../.;
  bunNix = ../../bun.nix;
  workspaceRoot = ../../.;
}
