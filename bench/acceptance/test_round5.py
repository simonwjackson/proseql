"""Strict round-5 cell summaries over separate timing and meter profiles."""

import unittest

import measure
import round5


class Round5Tests(unittest.TestCase):
    def rows(self):
        rows = []
        for shape in round5.SHAPES:
            workloads = (
                ("ten",)
                if shape == "raw16"
                else ("hour",)
                if shape == "raw_month"
                else measure.WORKLOADS
            )
            for workload in workloads:
                for mode in round5.MODES:
                    for cache in measure.CACHES:
                        for profile, wall in (
                            ("timing", 1),
                            ("timing", 2),
                            ("timing", 9),
                            ("meter", 1000),
                        ):
                            rows.append(
                                dict(
                                    shape=shape,
                                    workload=workload,
                                    mode=mode,
                                    cache=cache,
                                    profile=profile,
                                    wall_ms=wall,
                                    rss_peak=wall * 100,
                                    rss_1s=wall * 10,
                                    release_ms=None,
                                    rss_release_1s=None,
                                    sync_stages_ms=None,
                                    rust_heap_live_peak=[10, 20],
                                    sqlite_c_heap_live_peak=[30, 40],
                                    instructions=50,
                                    file_cache_before=60,
                                )
                            )
        return rows

    def test_three_timing_trials_and_independent_meter(self):
        rows = self.rows()
        self.assertEqual(len(rows), 432)
        summary = round5.summarize(rows)
        self.assertEqual(len(summary), 108)
        for row in summary:
            self.assertEqual(row["median_ms"], 2)
            self.assertEqual(row["floor_ms"], 1)
            self.assertEqual(row["rss_peak"], 900)
            self.assertEqual(row["rss_1s"], 20)
            self.assertEqual(row["rust_heap_live_peak"], [10, 20])

    def test_missing_timing_trial_cannot_be_summarized(self):
        with self.assertRaises(AssertionError):
            round5.summarize(self.rows()[1:])


if __name__ == "__main__":
    unittest.main()
