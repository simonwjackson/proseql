{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-rpc";
  version = "0.0.0";
  src = ../../.;
  bunNix = ../../bun.nix;
  workspaceRoot = ../../.;
}
