{
  mkBunDerivation,
  ...
}:
mkBunDerivation {
  pname = "proseql-rest";
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
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
    mkdir -p $out/lib/proseql-rest
    cp -r packages/rest/src $out/lib/proseql-rest/
    cp packages/rest/package.json $out/lib/proseql-rest/
    runHook postInstall
  '';
}
