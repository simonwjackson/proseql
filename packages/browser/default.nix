{
  mkBunDerivation,
  wasmArtifacts,
  sourceIdentity,
  nodejs,
  ...
}:
mkBunDerivation {
  pname = "proseql-browser-bundle";
  version = "0.16.0";
  src = ../../.;
  bunNix = ../../bun.nix;

  nativeBuildInputs = [ nodejs ];

  buildPhase = ''
    runHook preBuild
    rm -rf packages/engine/dist/wasm packages/engine/dist/browser-wasm
    mkdir -p packages/engine/dist packages/engine/build
    cp -r ${wasmArtifacts}/dist/wasm packages/engine/dist/
    cp -r ${wasmArtifacts}/dist/browser-wasm packages/engine/dist/
    cp ${wasmArtifacts}/build/wasm-build-report.json packages/engine/build/
    bun run copy-license
    bun run tsc --build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/closure $out/tarballs $out/packages

    # Copy only the exact runtime dependency closure, dereferencing Bun's
    # workspace links. Development tools and platform binaries are excluded.
    mkdir -p $out/closure/node_modules/@proseql $out/closure/node_modules/@toon-format
    cp -LR node_modules/effect $out/closure/node_modules/
    # mkBunDerivation installs the deterministic dependency closure at the
    # workspace root. Never read package-scoped node_modules from the source:
    # dirty path builds can contain them while clean Git/Nix sources cannot.
    for package in hjson json5 jsonc-parser picomatch smol-toml yaml; do
      cp -LR node_modules/$package $out/closure/node_modules/
    done
    cp -LR node_modules/@toon-format/toon $out/closure/node_modules/@toon-format/

    for package in core engine effect browser; do
      mkdir -p $out/packages/$package
      cp packages/$package/package.json packages/$package/README.md packages/$package/LICENSE $out/packages/$package/
      cp -r packages/$package/dist $out/packages/$package/
      cp -r $out/packages/$package $out/closure/node_modules/@proseql/$package
      (cd packages/$package && bun pm pack --ignore-scripts --quiet --destination $out/tarballs)
    done

    cat > $out/source-identity.json <<EOF
    {"schemaVersion":"proseql.browser-bundle.v1","sourceIdentity":"${sourceIdentity}","wasmBuildReport":"${wasmArtifacts}/build/wasm-build-report.json"}
    EOF
    cp $out/source-identity.json $out/closure/node_modules/@proseql/source-identity.json

    test -f $out/closure/node_modules/@proseql/engine/dist/browser-wasm/proseql_wasm_bg.wasm
    test -f $out/closure/node_modules/@proseql/browser/dist/worker.js
    runHook postInstall
  '';
}
