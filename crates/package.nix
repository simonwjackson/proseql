{
  lib,
  rustPlatform,
}:

# The Rust engine workspace: proseql-engine, proseql-formats, proseql-storage.
#
# A library workspace rather than a program, so the value here is not the
# artifact but the check -- `cargo test` runs during the build, which is what
# makes `nix flake check` cover the Rust side as well as the TypeScript one.
#
# proseql-wasm is deliberately excluded. It targets wasm32 and building it for
# the host proves nothing.
let
  workspaceMembers = [
    "--package=proseql-engine"
    "--package=proseql-formats"
    "--package=proseql-storage"
  ];
in
rustPlatform.buildRustPackage {
  pname = "proseql-rust";
  version = "0.1.0";

  src = ./.;

  cargoLock.lockFile = ./Cargo.lock;

  cargoBuildFlags = workspaceMembers;
  cargoTestFlags = workspaceMembers;

  meta = {
    description = "proseQL platform-blind engine, format codecs, and document storage";
    platforms = lib.platforms.all;
  };
}
