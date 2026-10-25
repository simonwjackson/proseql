"""Focused tests for target evaluation and real cache/append verification."""

import json
import tempfile
import unittest
from pathlib import Path

from measure import evict, residency, verify_append, warm
from summarize import aggregate, verdict


class HarnessTests(unittest.TestCase):
    def test_failures_and_missing_values_cannot_pass(self):
        self.assertEqual(verdict([None, 0], 2), "miss")
        self.assertEqual(verdict([], 2), "miss")
        self.assertEqual(verdict([0.5, 0.5], 1, eligible=False), "miss")
        self.assertEqual(verdict([1, 1.5], 1.5), "pass")
        self.assertEqual(verdict([1, 1.5001], 1.5), "miss")

    def test_instrumented_trials_do_not_change_timing_median(self):
        def trial(profile, wall, code=0):
            return {
                "profile": profile,
                "returncode": code,
                "wall_ms": wall,
                "rss_1s": 10,
                "rss_peak": 20,
                "instructions": None,
                "file_cache_before": 0,
                "file_cache_after": 4096,
            }

        rows = [trial("timing", 2), trial("timing", 4), trial("meter", 1000)]
        self.assertEqual(aggregate(rows)["wall_ms"], 3)
        rows.append(trial("timing", 0, 137))
        self.assertIsNone(aggregate(rows)["wall_ms"])
        self.assertIsNone(aggregate(rows)["rss_peak"])

    def test_owned_file_eviction_and_warm_residency(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "owned"
            path.write_bytes(b"x" * 65536)
            evict([path])
            warm([path])
            self.assertGreaterEqual(residency([path]), 65536)

    def test_append_verifier_rejects_non_new_ids_and_truncation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "samples").mkdir()
            path = root / "samples" / "2025-10.jsonl"
            path.write_text(json.dumps({"id": "new:append:1"}) + "\n")
            self.assertEqual(verify_append(root, "samples", "streaming", {}), 1)
            with self.assertRaises(AssertionError):
                verify_append(
                    root, "samples", "streaming", {path: path.stat().st_size + 1}
                )
            path.write_text(json.dumps({"id": "old"}) + "\n")
            with self.assertRaises(AssertionError):
                verify_append(root, "samples", "streaming", {})


if __name__ == "__main__":
    unittest.main()
