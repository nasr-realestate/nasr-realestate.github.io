#!/usr/bin/env python3
"""Focused regression/smoke tests for the optional GE2E speaker measurement tool.

Run with: python3 -m unittest scripts/tests/test_measure_voice_identity.py
Embedding tests run only when the pinned external model/runtime is installed;
no model weights or heavy ML packages are downloaded by the test itself.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import math
import os
import tempfile
import unittest
from unittest.mock import patch

from scripts.audio import measure_voice_identity as measure


class SignalGateTests(unittest.TestCase):
    def test_short_signal_is_inconclusive(self):
        issue = measure.signal_quality_issue([0.2] * (2 * 16000))
        self.assertIn("قصير", issue)

    def test_silence_is_inconclusive(self):
        issue = measure.signal_quality_issue([0.0] * (7 * 16000))
        self.assertIn("منخفض جدًا", issue)

    def test_non_finite_signal_is_inconclusive(self):
        issue = measure.signal_quality_issue([0.2] * (6 * 16000 - 1) + [math.nan])
        self.assertIn("NaN", issue)

    def test_valid_duration_and_level_pass_signal_gate(self):
        self.assertIsNone(measure.signal_quality_issue([0.1] * (6 * 16000)))

    def test_corrupt_audio_returns_inconclusive_without_cosine(self):
        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            f.write(b"not an MP3 stream")
            f.flush()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                status = measure.cmd_mp3(f.name)
            self.assertEqual(status, 3)
            self.assertIn("غير حاسمة", output.getvalue())
            self.assertIn("لا cosine", output.getvalue())
            self.assertNotIn("تشابه جيب التمام", output.getvalue())


@unittest.skipUnless(
    all(importlib.util.find_spec(x) for x in ("torch", "numpy", "soundfile", "librosa", "resemblyzer")),
    "optional CPU GE2E runtime/model not installed",
)
class SpeakerEmbeddingSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        measure.NP, measure.SF, measure.LIBROSA, measure.VOICE_ENCODER = measure.load_dependencies()
        cls.encoder = measure.VOICE_ENCODER(device="cpu", verbose=False)
        cls.reference = "assets/audio/properties/apartment-sale-helmy-abdel-aaty-seraj-mall-230m.mp3"
        cls.target = "assets/audio/properties/apartment-sale-hassan-hassanein-heikal-200m.mp3"
        cls.negative = "assets/audio/requests/shop-rent-request-beauty-center-nasr-city.mp3"

    def embedding(self, path):
        signal = measure.read_pcm16k(path)
        self.assertIsNone(measure.signal_quality_issue(signal))
        return measure.unit(self.encoder.embed_utterance(signal))

    def test_reference_self_is_one_and_embedding_is_256d(self):
        a = self.embedding(self.reference)
        b = self.embedding(self.reference)
        self.assertEqual(a.shape, (256,))
        self.assertAlmostEqual(float(measure.NP.dot(a, b)), 1.0, places=5)

    def test_reference_target_measurement_matches_recorded_value(self):
        a = self.embedding(self.reference)
        b = self.embedding(self.target)
        repeated = self.embedding(self.target)
        cosine = round(float(measure.NP.dot(a, b)), 4)
        self.assertEqual(cosine, 0.9143)
        self.assertAlmostEqual(float(measure.NP.dot(b, repeated)), 1.0, places=5)
        self.assertEqual(measure.classify(cosine, measure.load_spec()["identityBand"]["thresholds"]), "possible-deviation-review")

    def test_short_decodable_file_returns_inconclusive_without_cosine(self):
        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            measure.SF.write(f.name, measure.NP.full(2 * 16000, 0.1, dtype="float32"), 16000, format="WAV")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                status = measure.cmd_mp3(f.name)
            self.assertEqual(status, 3)
            self.assertIn("غير حاسمة", output.getvalue())
            self.assertIn("قصير", output.getvalue())
            self.assertNotIn("تشابه جيب التمام", output.getvalue())

    def test_invalid_embedding_vectors_are_rejected(self):
        with self.assertRaises(ValueError):
            measure.unit(measure.NP.zeros(256))
        with self.assertRaises(ValueError):
            measure.unit(measure.NP.full(255, 1.0))
        bad = measure.NP.ones(256)
        bad[0] = measure.NP.nan
        with self.assertRaises(ValueError):
            measure.unit(bad)

    def test_batch_marks_corrupt_sample_inconclusive_and_keeps_other_results(self):
        with tempfile.NamedTemporaryFile(suffix=".mp3") as corrupt, tempfile.NamedTemporaryFile(suffix=".json") as output:
            corrupt.write(b"corrupt audio")
            corrupt.flush()
            entries = [
                {"audioFile": self.reference, "productionSession": "ref", "origin": "reference", "script": "reference"},
                {"audioFile": corrupt.name, "productionSession": "bad", "origin": "test"},
            ]
            with patch.object(measure, "audio_files", return_value=[self.reference, corrupt.name]), \
                 patch.object(measure, "load_log", return_value={"entries": entries}):
                status = measure.cmd_all(output.name)
            self.assertEqual(status, 0)
            with open(output.name, encoding="utf-8") as result_file:
                result = json.load(result_file)
            self.assertEqual(result["files"][self.reference]["classification"], "reference")
            self.assertEqual(result["files"][corrupt.name]["classification"], "cannot-assess")
            self.assertIsNone(result["files"][corrupt.name]["cosineToReference"])

    def test_reference_and_different_sample_are_not_confused(self):
        a = self.embedding(self.reference)
        b = self.embedding(self.negative)
        cosine = float(measure.NP.dot(a, b))
        self.assertAlmostEqual(cosine, 0.7245, places=4)
        self.assertEqual(measure.classify(cosine, measure.load_spec()["identityBand"]["thresholds"]), "clear-difference")


if __name__ == "__main__":
    unittest.main()
