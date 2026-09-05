import datetime as dt
import json
import unittest

from python import forex_engine as engine


class ForexEngineTests(unittest.TestCase):
    def setUp(self):
        self.db = engine.connect(":memory:")
        start = dt.date(2025, 1, 1)
        for index in range(130):
            label = int(index % 3 == 0)
            features = {factor: (0.7 if label else -0.7) if factor == "momentum" else 0.0 for factor in engine.FACTORS}
            self.db.execute(
                "INSERT INTO training_examples(pair, as_of, horizon, features_json, label) VALUES (?, ?, ?, ?, ?)",
                ("EURUSD", (start + dt.timedelta(days=index)).isoformat(), 30, json.dumps(features), label),
            )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_walk_forward_is_strictly_chronological(self):
        result = engine.walk_forward_horizon(
            self.db, 30, 0.8, window="rolling", initial_train=30, test_size=12, rolling_train_size=75,
        )
        self.assertGreaterEqual(result["fold_count"], 4)
        self.assertTrue(all(fold["train_end"] < fold["test_start"] for fold in result["folds"]))
        self.assertGreaterEqual(result["brier_score"], 0)

    def test_score_includes_confidence_regime_and_importance_log(self):
        features = {factor: 0.0 for factor in engine.FACTORS}
        features["risk"] = 0.4
        features["sentiment"] = 0.2
        result = engine.score_pair(self.db, "EURUSD", 30, features, 0.8, vix=27.0)
        self.assertIn("confidence", result)
        self.assertEqual(result["regime"]["label"], "risk-off")
        self.assertEqual(result["top_driver"]["factor"], "risk")
        count = self.db.execute("SELECT COUNT(*) FROM feature_importance_logs").fetchone()[0]
        self.assertEqual(count, 1)

    def test_lexical_sentiment_is_directional(self):
        self.assertGreater(engine.lexical_sentiment("Inflation is persistent and policy remains restrictive"), 0)
        self.assertLess(engine.lexical_sentiment("Weak growth and downside risk support a rate cut"), 0)


if __name__ == "__main__":
    unittest.main()
