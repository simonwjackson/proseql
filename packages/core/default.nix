{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-core";
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
    mkdir -p $out/lib/proseql-core
    cp -r packages/core/src $out/lib/proseql-core/
    cp packages/core/package.json $out/lib/proseql-core/
    runHook postInstall
  '';
}
