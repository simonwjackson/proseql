#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p python3
"""Check only a disposable copy of Coach data. Never print records or IDs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def digests(root):
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*")) if path.is_file()
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coach-repo", type=Path, default=Path.home() / "code/sandbox/coach")
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".local/share/coach")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    schema_path = repo / "crates/proseql-native/tests/fixtures/coach-schema.json"
    schema = json.loads(schema_path.read_text())
    legacy = subprocess.check_output(["git", "-C", str(args.coach_repo), "show", "legacy:src/app/data/db-config.ts"])
    if hashlib.sha256(legacy).hexdigest() != schema["legacySchemaSha256"]:
        raise RuntimeError("Legacy schema changed. Refresh the schema-only fixture before checking data.")
    source = args.data_dir.resolve(strict=True)
    if any(path.is_symlink() for path in source.rglob("*")):
        raise RuntimeError("Source contains symlinks. Refusing a copy with links to live files.")
    with tempfile.TemporaryDirectory(prefix="proseql-coach-copy-") as temporary:
        temporary = Path(temporary).resolve()
        if temporary.is_relative_to(repo):
            raise RuntimeError("Disposable copy must stay outside the repository.")
        copied = temporary / "data"
        shutil.copytree(source, copied)
        before = digests(copied)
        result = subprocess.run([
            "nix", "develop", "--command", "cargo", "run", "--manifest-path", "crates/Cargo.toml",
            "-p", "proseql-native", "--example", "coach_compatibility", "--", str(schema_path), str(copied)
        ], cwd=repo, capture_output=True, text=True)
        if result.returncode:
            # Child validation errors must not escape into logs with personal IDs.
            raise RuntimeError("Rust copy check failed. Child output was suppressed.")
        if "Opened 42 collections without a mutation." not in result.stdout:
            raise RuntimeError("Rust process did not confirm all 42 collections.")
        if digests(copied) != before:
            raise RuntimeError("Opening or closing changed the disposable copy.")
        print("Verified: Rust opened all 42 Coach collections. Every copied file stayed unchanged.")
        print("The temporary copy was removed. The live folder was not opened by Rust or written.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Even OS error details can reveal private filenames. Keep them out of logs.
        raise SystemExit("Coach copy check failed. Details suppressed to protect personal data.")
