#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p python3 git
"""Run the existing synthetic benchmark with explicit source lifetimes.

Primary RSS comes from unprofiled processes. Meter/DHAT RSS is never accepted
as process-memory evidence. Output records are intentionally not B/loaded-row.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

MIB = 1024 * 1024
ROOT = Path(__file__).resolve().parent.parent


def records(path):
    result = {}
    for line in path.read_text().splitlines():
        for prefix in ("LM_SUMMARY ", "LM_CALLER_RECLAIM "):
            if line.startswith(prefix):
                result.setdefault(prefix.strip(), []).append(json.loads(line[len(prefix):]))
    return result


def hashes(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file()}


def check_idle(summary, empty_rss):
    for key in ("rss", "idle_rss", "open_rss", "rss_hwm"):
        if type(summary.get(key)) is not int or summary[key] <= 0:
            raise ValueError("Linux RSS metrics must be positive measured integers, not placeholders")
    if summary.get("idle_seconds") != 30:
        raise ValueError("primary idle evidence requires the 30-second endpoint")
    if summary.get("instrumented") is not False or summary.get("profiled") is not False:
        raise ValueError("primary RSS evidence must use the unprofiled binary")
    limit = min(empty_rss + 8 * MIB, summary["open_rss"] + 50 * MIB)
    return summary["idle_rss"] <= limit and summary["rss"] <= limit


def self_test():
    sample = {"rss":14*MIB,"idle_rss":14*MIB,"open_rss":6*MIB,"rss_hwm":128*MIB,
              "idle_seconds":30,"instrumented":False,"profiled":False}
    assert check_idle(sample, 6*MIB)
    assert not check_idle({**sample,"rss":14*MIB+1},6*MIB)
    assert not check_idle({**sample,"idle_rss":14*MIB+1},6*MIB)
    second={**sample,"open_rss":MIB,"idle_rss":51*MIB,"rss":51*MIB}
    assert check_idle(second,100*MIB)
    assert not check_idle({**second,"rss":51*MIB+1},100*MIB)
    for key in ("rss","idle_rss","open_rss","rss_hwm"):
        for invalid in (None,0,-1,False):
            try:
                check_idle({**sample,key:invalid},6*MIB)
            except ValueError:
                continue
            raise AssertionError("unknown or invalid RSS passed")
    try:
        check_idle({**sample,"instrumented":True},6*MIB)
    except ValueError:
        pass
    else:
        raise AssertionError("meter RSS passed as unprofiled evidence")
    print("idle checker boundary tests passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, nargs="?")
    parser.add_argument("--feedback", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.out is None:
        parser.error("out is required")
    out = args.out.resolve()
    binary = out / "bin"
    for name in ("unprofiled", "meter"):
        if not (binary / name).is_file():
            raise ValueError("run profile-lazy-memory.sh build in this evidence directory first")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if not args.feedback:
        built = (binary / "source.sha").read_text().strip()
        status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
        if built != head or status or (binary / "source.status").read_text().strip():
            raise ValueError("qualification needs binaries from the current clean commit; do not delete unrelated files, use an owned worktree")
    evidence = out / ("idle-feedback" if args.feedback else "idle")
    evidence.mkdir(parents=True, exist_ok=False)
    manifest = {"source": head, "feedback_only": args.feedback,
                "binaries": {name: hashlib.sha256((binary / name).read_bytes()).hexdigest()
                             for name in ("unprofiled", "meter")}, "cases": []}
    (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    def run(name, command):
        print("IDLE_RUN " + name, flush=True)
        log = evidence / (name + ".log")
        with log.open("w") as stream:
            completed = subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
        (evidence / (name + ".command.json")).write_text(json.dumps({"command": command, "exit": completed.returncode}, indent=2) + "\n")
        if completed.returncode:
            raise RuntimeError(f"{name} exited {completed.returncode}; inspect {log}")
        return log

    if args.feedback:
        cases = [(kind, "consumer", 100, 100, "scan", 0, False)
                 for kind in ("month", "file", "documents", "sharded", "yaml-partitions")]
        roles = ["meter"]
    else:
        cases = [("empty", "consumer", 1000, 1000, "empty", 0, False)]
        cases += [(kind, "consumer", 1000, 1000, "scan", 0, True)
                  for kind in ("month", "file", "documents", "sharded", "yaml-partitions")]
        cases += [("legacy-scan", "legacy", 43000, 10000, "scan", 0, False),
                  ("consumer-scan", "consumer", 65348, 10000, "scan", 0, False),
                  ("legacy-output", "legacy", 43000, 10000, "ascending", 0, False),
                  ("consumer-output", "consumer", 65348, 10000, "ascending", 0, False),
                  ("eager-ids", "consumer", 1000, 139420, "eager-id", 0, False),
                  ("history-small", "consumer", 1000, 1000, "zero", 0, False),
                  ("history-large", "consumer", 1000, 1000, "zero", 9, False)]
        roles = ["unprofiled", "meter"]
    empty_rss = None
    failures = []
    for name, shape, rows, ids, mode, history, append in cases:
        kind = name if name in ("file", "documents", "sharded", "yaml-partitions") else "month"
        before_by_role = None
        for role in roles:
            data = evidence / (name + "-" + role + "-data")
            common = ["--data-dir", str(data), "--fixture", shape, "--source-kind", kind,
                      "--rows-per-month", str(rows), "--id-rows", str(ids), "--history-copies", str(history)]
            run(name + "-" + role + "-prepare", [str(binary / "unprofiled"), *common, "--prepare-only"])
            before = hashes(data)
            if before_by_role is not None and before != before_by_role:
                raise ValueError("profile roles must start from identical fixture bytes")
            before_by_role = before
            command = [str(binary / role), *common, "--mode", mode, "--bounded", "--sessions", "--cache-partitions", "0"]
            if not args.feedback:
                command += ["--reclaim-idle"]
            if role == "meter":
                command += ["--idle-check"]
            else:
                command += ["--idle-seconds", "30"]
            if append:
                command += ["--append-one"]
            log = run(name + "-" + role, command)
            captured = records(log)
            summary = captured["LM_SUMMARY"][-1]
            after = hashes(data)
            changed = [path for path in before if before[path] != after.get(path)]
            expected_path = {"month": "samples/2025-10.jsonl", "file": "all.jsonl",
                             "documents": "records.yaml", "sharded": "shards/ff.jsonl",
                             "yaml-partitions": "yaml-parts/2025-10.yaml"}[kind]
            if set(after) != set(before) or changed != ([expected_path] if append else []):
                raise ValueError(f"unexpected source-byte changes in {name}/{role}: {changed}")
            passed = not summary["check_failed"]
            if role == "unprofiled":
                if name == "empty":
                    empty_rss = summary["rss"]
                passed = passed and check_idle(summary, empty_rss)
            row = {"case": name, "role": role, "summary": summary,
                   "input_hashes": before, "output_hashes": after, "idle_contract_pass": passed,
                   "caller_output_reclaims":captured.get("LM_CALLER_RECLAIM",[])}
            if name in ("legacy-scan", "consumer-scan") and role == "unprofiled":
                target = summary["open_rss"] + 2 * rows * 500 + 50 * MIB
                row["compact_peak_target_bytes"] = target
                row["compact_peak_target_met"] = summary["rss_hwm"] <= target
            manifest["cases"].append(row)
            (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            if not passed:
                failures.append(name + "/" + role)
    if not args.feedback:
        by_name = {(row["case"], row["role"]): row for row in manifest["cases"]}
        small = by_name[("history-small", "meter")]["summary"]["final_heap"]["live"]
        large = by_name[("history-large", "meter")]["summary"]["final_heap"]["live"]
        manifest["cold_history_idle_growth_bytes"] = large - small
        if large - small > 64 * 1024:
            failures.append("cold-history live-heap growth")
    if not args.feedback:
        final_head=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
        final_status=subprocess.check_output(["git","status","--porcelain"],cwd=ROOT,text=True)
        if final_head!=head or final_status:
            raise ValueError("source changed during qualification; preserve the logs and qualify the final candidate")
    manifest["idle_contract_pass"] = not failures
    manifest["failures"] = failures
    manifest["loaded_row_target_measured"] = False
    (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if failures:
        raise RuntimeError("idle contract failed: " + ", ".join(failures))
    print("IDLE_CONTRACT_PASS (loaded-row compactness is a separate requirement)", flush=True)


if __name__ == "__main__":
    main()
