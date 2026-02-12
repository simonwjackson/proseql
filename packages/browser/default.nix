{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-browser";
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
    mkdir -p $out/lib/proseql-browser
    cp -r packages/browser/src $out/lib/proseql-browser/
    cp packages/browser/package.json $out/lib/proseql-browser/
    runHook postInstall
  '';
}
