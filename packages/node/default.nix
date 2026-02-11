{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-node";
  version = "0.1.0";
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
    mkdir -p $out/lib/proseql-node
    cp -r packages/node/src $out/lib/proseql-node/
    cp packages/node/package.json $out/lib/proseql-node/
    runHook postInstall
  '';
}
