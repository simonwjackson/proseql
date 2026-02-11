{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-rpc";
  version = "0.0.0";
  src = ../../.;
  bunNix = ../../bun.nix;

  # This is a library, not an executable - copy source files
  buildPhase = ''
    runHook preBuild
    # No compilation needed for TypeScript library
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/proseql-rpc
    cp -r packages/rpc/src $out/lib/proseql-rpc/
    cp packages/rpc/package.json $out/lib/proseql-rpc/
    runHook postInstall
  '';
}
