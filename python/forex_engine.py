#!/usr/bin/env python3
"""Local FX scoring, walk-forward validation and retraining CLI."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sqlite3
import statistics
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

FACTORS = (
    "policy", "inflation", "growth", "yields", "cot",
    "commodities", "risk", "seasonality", "momentum", "sentiment",
)
HORIZONS = (10, 30, 60, 90)
MAJORS = ("EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD")
EXPERT_WEIGHTS = {
    "policy": 0.16, "inflation": 0.09, "growth": 0.14,
    "yields": 0.15, "cot": 0.09, "commodities": 0.05,
    "risk": 0.10, "seasonality": 0.04, "momentum": 0.12,
    "sentiment": 0.06,
}
BOOTSTRAP_MODEL_WEIGHTS = {
    "policy": 0.16, "inflation": 0.09, "growth": 0.14,
    "yields": 0.20, "cot": 0.09, "commodities": 0.05,
    "risk": 0.11, "seasonality": 0.04, "momentum": 0.10,
    "sentiment": 0.06,
}


def connect(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          currency TEXT NOT NULL,
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          period TEXT NOT NULL,
          source TEXT NOT NULL,
          received_at TEXT NOT NULL,
          UNIQUE(currency, metric, period, source)
        );
        CREATE TABLE IF NOT EXISTS feature_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pair TEXT NOT NULL,
          as_of TEXT NOT NULL,
          close REAL NOT NULL,
          features_json TEXT NOT NULL,
          UNIQUE(pair, as_of)
        );
        CREATE TABLE IF NOT EXISTS training_examples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pair TEXT NOT NULL,
          as_of TEXT NOT NULL,
          horizon INTEGER NOT NULL,
          features_json TEXT NOT NULL,
          label INTEGER NOT NULL CHECK(label IN (0, 1)),
          label_end TEXT,
          UNIQUE(pair, as_of, horizon)
        );
        CREATE TABLE IF NOT EXISTS model_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trained_at TEXT NOT NULL,
          horizon INTEGER NOT NULL,
          learned_weights_json TEXT NOT NULL,
          expert_weights_json TEXT NOT NULL,
          model_blend REAL NOT NULL,
          sample_count INTEGER NOT NULL,
          log_loss REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS forecasts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pair TEXT NOT NULL,
          horizon INTEGER NOT NULL,
          probability REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS walk_forward_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          validated_at TEXT NOT NULL,
          horizon INTEGER NOT NULL,
          window_mode TEXT NOT NULL,
          fold_count INTEGER NOT NULL,
          oos_sample_count INTEGER NOT NULL,
          accuracy REAL NOT NULL,
          log_loss REAL NOT NULL,
          brier_score REAL NOT NULL,
          folds_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feature_importance_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pair TEXT NOT NULL,
          horizon INTEGER NOT NULL,
          probability REAL NOT NULL,
          confidence REAL NOT NULL,
          regime TEXT NOT NULL,
          contributions_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """
    )
    training_columns = {row[1] for row in connection.execute("PRAGMA table_info(training_examples)")}
    if "label_end" not in training_columns:
        connection.execute("ALTER TABLE training_examples ADD COLUMN label_end TEXT")
    return connection


def normalize(weights: dict[str, float]) -> dict[str, float]:
    cleaned = {factor: max(0.0, float(weights.get(factor, 0.0))) for factor in FACTORS}
    total = sum(cleaned.values())
    return {factor: (cleaned[factor] / total if total else 1 / len(FACTORS)) for factor in FACTORS}


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, value))))


def parse_features(raw: str) -> dict[str, float]:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("features must be a JSON object")
    return {factor: clamp(float(data.get(factor, 0.0)), -1.0, 1.0) for factor in FACTORS}


def detect_regime(vix: float | None, risk_signal: float = 0.0) -> dict[str, Any]:
    vix_component = 0.0 if vix is None else (vix - 20.0) / 5.5
    risk_off_probability = sigmoid(vix_component - risk_signal * 1.6)
    label = "risk-off" if risk_off_probability >= 0.62 else "risk-on" if risk_off_probability <= 0.38 else "neutral"
    return {"label": label, "risk_off_probability": risk_off_probability, "vix": vix}


def apply_regime(weights: dict[str, float], risk_off_probability: float) -> dict[str, float]:
    risk_off = clamp(risk_off_probability)
    risk_on = 1.0 - risk_off
    multipliers = {
        "risk": 0.82 + risk_off * 1.55,
        "yields": 0.92 + risk_off * 0.32,
        "policy": 0.95 + risk_off * 0.20,
        "growth": 0.86 + risk_on * 0.34,
        "commodities": 0.84 + risk_on * 0.42,
        "momentum": 0.90 + risk_on * 0.25,
        "sentiment": 0.94 + abs(risk_off - 0.5) * 0.34,
    }
    return normalize({factor: weights[factor] * multipliers.get(factor, 1.0) for factor in FACTORS})


def effective_weights(learned: dict[str, float], blend: float, risk_off_probability: float = 0.5) -> dict[str, float]:
    expert = normalize(EXPERT_WEIGHTS)
    model = normalize(learned)
    ratio = clamp(blend)
    hybrid = normalize({factor: expert[factor] * (1 - ratio) + model[factor] * ratio for factor in FACTORS})
    return apply_regime(hybrid, risk_off_probability)


def probability(features: dict[str, float], weights: dict[str, float]) -> float:
    return sigmoid(sum(features[factor] * weights[factor] for factor in FACTORS) * 5.0)


def http_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "fx-dominance-cli/1.0"})
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


POSITIVE_TERMS = (
    "raise", "raising", "higher rates", "tighten", "tightening", "restrictive",
    "persistent inflation", "strong growth", "resilient", "robust", "upside risk",
    "above target", "price stability", "hawkish", "accelerat",
)
NEGATIVE_TERMS = (
    "cut rates", "rate cut", "lower rates", "easing", "accommodative", "weak growth",
    "downside risk", "recession", "contraction", "disinflation", "below target",
    "dovish", "slowdown", "economic weakness", "decelerat",
)


def lexical_sentiment(text: str) -> float:
    normalized = re.sub(r"\s+", " ", text.lower())
    positive = sum(len(re.findall(re.escape(term), normalized)) for term in POSITIVE_TERMS)
    negative = sum(len(re.findall(re.escape(term), normalized)) for term in NEGATIVE_TERMS)
    return math.tanh((positive - negative) / 3.0)


def finbert_sentiment(text: str) -> float:
    try:
        from transformers import pipeline  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("FinBERT requires: pip install transformers torch") from exc
    classifier = pipeline("text-classification", model="ProsusAI/finbert")
    output = classifier(text, truncation=True, top_k=None)
    rows = output[0] if output and isinstance(output[0], list) else output
    scores = {str(row["label"]).lower(): float(row["score"]) for row in rows}
    return clamp(scores.get("positive", 0.0) - scores.get("negative", 0.0), -1.0, 1.0)


def score_sentiment(text: str, engine: str) -> dict[str, Any]:
    raw = finbert_sentiment(text) if engine == "finbert" else lexical_sentiment(text)
    return {
        "engine": engine,
        "raw_score": raw,
        "factor_score": clamp(0.5 + raw * 0.45, 0.05, 0.95),
    }


def upsert_observation(db: sqlite3.Connection, currency: str, metric: str, value: float, period: str, source: str) -> None:
    db.execute(
        """INSERT INTO observations(currency, metric, value, period, source, received_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(currency, metric, period, source)
           DO UPDATE SET value=excluded.value, received_at=excluded.received_at""",
        (currency, metric, value, period, source, dt.datetime.now(dt.timezone.utc).isoformat()),
    )


def refresh_data(db: sqlite3.Connection) -> dict[str, int]:
    fred_key = os.environ.get("FRED_API_KEY")
    alpha_key = os.environ.get("ALPHA_VANTAGE_API_KEY")
    counts = {"fred": 0, "alpha_vantage": 0}
    if fred_key:
        for metric, series_id in {"rate": "DFF", "yield2y": "DGS2", "yield10y": "DGS10"}.items():
            query = urllib.parse.urlencode({
                "series_id": series_id, "api_key": fred_key, "file_type": "json",
                "sort_order": "desc", "limit": 12,
            })
            body = http_json(f"https://api.stlouisfed.org/fred/series/observations?{query}")
            row = next((item for item in body.get("observations", []) if item.get("value") not in (None, ".")), None)
            if row:
                upsert_observation(db, "USD", metric, float(row["value"]), row["date"], "FRED")
                counts["fred"] += 1
        query = urllib.parse.urlencode({
            "series_id": "VIXCLS", "api_key": fred_key, "file_type": "json",
            "sort_order": "desc", "limit": 12,
        })
        body = http_json(f"https://api.stlouisfed.org/fred/series/observations?{query}")
        row = next((item for item in body.get("observations", []) if item.get("value") not in (None, ".")), None)
        if row:
            upsert_observation(db, "GLOBAL", "vix", float(row["value"]), row["date"], "FRED")
            counts["fred"] += 1
    if alpha_key:
        scores: list[float] = []
        for currency in MAJORS:
            query = urllib.parse.urlencode({
                "function": "FX_DAILY", "from_symbol": currency, "to_symbol": "USD",
                "outputsize": "compact", "apikey": alpha_key,
            })
            body = http_json(f"https://www.alphavantage.co/query?{query}")
            series = body.get("Time Series FX (Daily)", {})
            rows = sorted(
                ((period, float(values["4. close"])) for period, values in series.items() if values.get("4. close")),
                reverse=True,
            )
            if len(rows) < 2:
                continue
            period, close = rows[0]
            close20 = rows[min(19, len(rows) - 1)][1]
            close60 = rows[min(59, len(rows) - 1)][1]
            momentum = clamp(0.5 + math.log(close / close20) * 4.5 + math.log(close / close60) * 2.2, 0.05, 0.95)
            upsert_observation(db, currency, "fxCloseUsd", close, period, "Alpha Vantage")
            upsert_observation(db, currency, "momentum", momentum, period, "Alpha Vantage")
            scores.append(momentum)
            counts["alpha_vantage"] += 1
        if scores:
            upsert_observation(db, "USD", "momentum", 1 - sum(scores) / len(scores), dt.date.today().isoformat(), "Alpha Vantage")
            counts["alpha_vantage"] += 1
    db.commit()
    return counts


def build_examples(db: sqlite3.Connection) -> int:
    inserted = 0
    pairs = [row[0] for row in db.execute("SELECT DISTINCT pair FROM feature_snapshots")]
    for pair in pairs:
        rows = list(db.execute("SELECT as_of, close, features_json FROM feature_snapshots WHERE pair=? ORDER BY as_of", (pair,)))
        dated = [(dt.date.fromisoformat(row["as_of"][:10]), row) for row in rows]
        for index, (as_of, row) in enumerate(dated):
            for horizon in HORIZONS:
                target = as_of + dt.timedelta(days=horizon)
                future = next((candidate for date, candidate in dated[index + 1:] if date >= target), None)
                if future is None:
                    continue
                label = int(float(future["close"]) > float(row["close"]))
                before = db.total_changes
                db.execute(
                    """INSERT OR IGNORE INTO training_examples(pair, as_of, horizon, features_json, label, label_end)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (pair, row["as_of"], horizon, row["features_json"], label, future["as_of"]),
                )
                inserted += int(db.total_changes > before)
    db.commit()
    return inserted


def latest_learned_weights(db: sqlite3.Connection, horizon: int) -> dict[str, float]:
    row = db.execute(
        "SELECT learned_weights_json FROM model_runs WHERE horizon=? ORDER BY trained_at DESC LIMIT 1",
        (horizon,),
    ).fetchone()
    return normalize(json.loads(row[0])) if row else normalize(BOOTSTRAP_MODEL_WEIGHTS)


def fit_model(
    examples: list[tuple[dict[str, float], int]],
    initial: dict[str, float],
    epochs: int = 500,
) -> dict[str, float]:
    weights = normalize(initial)
    learning_rate = 0.12
    for _ in range(epochs):
        gradients = {factor: 0.0 for factor in FACTORS}
        for features, label in examples:
            error = probability(features, weights) - label
            for factor in FACTORS:
                gradients[factor] += error * features[factor]
        for factor in FACTORS:
            gradient = gradients[factor] / len(examples) + 0.01 * weights[factor]
            weights[factor] = max(0.001, weights[factor] - learning_rate * gradient)
        weights = normalize(weights)
    return weights


def evaluate(examples: list[tuple[dict[str, float], int]], weights: dict[str, float]) -> dict[str, float]:
    epsilon = 1e-9
    predictions = [(probability(features, weights), label) for features, label in examples]
    loss = -sum(
        label * math.log(max(epsilon, predicted))
        + (1 - label) * math.log(max(epsilon, 1 - predicted))
        for predicted, label in predictions
    ) / len(predictions)
    accuracy = sum(int((predicted >= 0.5) == bool(label)) for predicted, label in predictions) / len(predictions)
    brier_score = sum((predicted - label) ** 2 for predicted, label in predictions) / len(predictions)
    return {"log_loss": loss, "accuracy": accuracy, "brier_score": brier_score}


def train_horizon(db: sqlite3.Connection, horizon: int, blend: float, epochs: int = 500) -> dict[str, Any]:
    rows = list(db.execute("SELECT features_json, label FROM training_examples WHERE horizon=? ORDER BY as_of", (horizon,)))
    if len(rows) < 20:
        raise ValueError(f"need at least 20 labeled examples for {horizon}d; found {len(rows)}")
    examples = [(parse_features(row["features_json"]), int(row["label"])) for row in rows]
    weights = fit_model(examples, latest_learned_weights(db, horizon), epochs)
    blended = effective_weights(weights, blend)
    metrics = evaluate(examples, blended)
    trained_at = dt.datetime.now(dt.timezone.utc).isoformat()
    db.execute(
        """INSERT INTO model_runs(trained_at, horizon, learned_weights_json, expert_weights_json, model_blend, sample_count, log_loss)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (trained_at, horizon, json.dumps(weights), json.dumps(EXPERT_WEIGHTS), blend, len(examples), metrics["log_loss"]),
    )
    db.commit()
    return {"horizon": horizon, "samples": len(examples), "log_loss": round(metrics["log_loss"], 6), "learned_weights": weights}


def walk_forward_horizon(
    db: sqlite3.Connection,
    horizon: int,
    blend: float,
    window: str = "expanding",
    initial_train: int = 40,
    test_size: int = 20,
    rolling_train_size: int = 180,
) -> dict[str, Any]:
    rows = list(db.execute(
        "SELECT as_of, features_json, label, label_end FROM training_examples WHERE horizon=? ORDER BY as_of",
        (horizon,),
    ))
    if len(rows) < initial_train + 1:
        raise ValueError(f"need at least {initial_train + 1} chronological examples for {horizon}d; found {len(rows)}")
    groups: list[tuple[str, list[tuple[dict[str, float], int, str]]]] = []
    for row in rows:
        as_of = str(row["as_of"])[:10]
        label_end = str(row["label_end"])[:10] if row["label_end"] else (
            dt.date.fromisoformat(as_of) + dt.timedelta(days=horizon)
        ).isoformat()
        example = (parse_features(row["features_json"]), int(row["label"]), label_end)
        if groups and groups[-1][0] == as_of:
            groups[-1][1].append(example)
        else:
            groups.append((as_of, [example]))

    train_end = 0
    accumulated = 0
    while train_end < len(groups) and accumulated < initial_train:
        accumulated += len(groups[train_end][1])
        train_end += 1

    folds: list[dict[str, Any]] = []
    while train_end < len(groups):
        test_end = train_end
        test_count = 0
        while test_end < len(groups) and test_count < test_size:
            test_count += len(groups[test_end][1])
            test_end += 1
        train_start = 0
        if window == "rolling":
            rolling_count = 0
            train_start = train_end
            while train_start > 0 and rolling_count < rolling_train_size:
                train_start -= 1
                rolling_count += len(groups[train_start][1])
        test_start = groups[train_end][0]
        unpurged_train_set = [example for _, group in groups[train_start:train_end] for example in group]
        train_set = [(features, label) for features, label, label_end in unpurged_train_set if label_end < test_start]
        test_set = [(features, label) for _, group in groups[train_end:test_end] for features, label, _ in group]
        if not test_set:
            break
        if len(train_set) < initial_train:
            train_end += 1
            continue
        learned = fit_model(train_set, BOOTSTRAP_MODEL_WEIGHTS, epochs=180)
        metrics = evaluate(test_set, effective_weights(learned, blend))
        folds.append({
            "train_start": groups[train_start][0],
            "train_end": groups[train_end - 1][0],
            "test_start": groups[train_end][0],
            "test_end": groups[test_end - 1][0],
            "train_samples": len(train_set),
            "test_samples": len(test_set),
            "purged_samples": len(unpurged_train_set) - len(train_set),
            "accuracy": round(metrics["accuracy"], 6),
            "log_loss": round(metrics["log_loss"], 6),
            "brier_score": round(metrics["brier_score"], 6),
        })
        train_end = test_end
    if not folds:
        raise ValueError("not enough distinct dates to create a forward-only test fold")
    oos_samples = sum(fold["test_samples"] for fold in folds)
    aggregate = lambda key: sum(fold[key] * fold["test_samples"] for fold in folds) / oos_samples
    validated_at = dt.datetime.now(dt.timezone.utc).isoformat()
    result = {
        "horizon": horizon,
        "window": window,
        "fold_count": len(folds),
        "oos_samples": oos_samples,
        "accuracy": round(aggregate("accuracy"), 6),
        "log_loss": round(aggregate("log_loss"), 6),
        "brier_score": round(aggregate("brier_score"), 6),
        "validated_at": validated_at,
        "folds": folds,
    }
    db.execute(
        """INSERT INTO walk_forward_runs(
             validated_at, horizon, window_mode, fold_count, oos_sample_count,
             accuracy, log_loss, brier_score, folds_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            validated_at, horizon, window, len(folds), oos_samples,
            result["accuracy"], result["log_loss"], result["brier_score"], json.dumps(folds),
        ),
    )
    db.commit()
    return result


def latest_vix(db: sqlite3.Connection) -> float | None:
    row = db.execute(
        "SELECT value FROM observations WHERE currency='GLOBAL' AND metric='vix' ORDER BY period DESC LIMIT 1"
    ).fetchone()
    return float(row[0]) if row else None


def confidence_measure(db: sqlite3.Connection, horizon: int, contributions: list[dict[str, Any]]) -> dict[str, float]:
    sample_count = int(db.execute(
        "SELECT COUNT(*) FROM training_examples WHERE horizon=?", (horizon,)
    ).fetchone()[0])
    values = [float(item["contribution"]) for item in contributions]
    absolute_sum = sum(abs(value) for value in values)
    consistency = abs(sum(values)) / absolute_sum if absolute_sum else 0.0
    dispersion = statistics.pstdev(values) if len(values) > 1 else 0.0
    sample_adequacy = 1.0 - math.exp(-sample_count / 240.0)
    confidence = clamp(0.12 + sample_adequacy * 0.48 + consistency * 0.40, 0.08, 0.97)
    return {
        "confidence": confidence,
        "sample_count": float(sample_count),
        "signal_consistency": consistency,
        "signal_dispersion": dispersion,
    }


def explain_pair(
    db: sqlite3.Connection,
    pair: str,
    horizon: int,
    features: dict[str, float],
    blend: float,
    vix: float | None = None,
    persist: bool = True,
) -> dict[str, Any]:
    learned = latest_learned_weights(db, horizon)
    regime = detect_regime(latest_vix(db) if vix is None else vix)
    weights = effective_weights(learned, blend, regime["risk_off_probability"])
    result = probability(features, weights)
    contributions = sorted(({
        "factor": factor,
        "feature_value": features[factor],
        "weight": weights[factor],
        "contribution": features[factor] * weights[factor],
    } for factor in FACTORS), key=lambda item: abs(item["contribution"]), reverse=True)
    confidence = confidence_measure(db, horizon, contributions)
    created_at = dt.datetime.now(dt.timezone.utc).isoformat()
    explanation = {
        "pair": pair,
        "horizon": horizon,
        "probability_up": round(result, 6),
        "confidence": round(confidence["confidence"], 6),
        "confidence_label": "high" if confidence["confidence"] >= 0.72 else "medium" if confidence["confidence"] >= 0.48 else "low",
        "training_samples": int(confidence["sample_count"]),
        "signal_consistency": round(confidence["signal_consistency"], 6),
        "signal_dispersion": round(confidence["signal_dispersion"], 6),
        "regime": regime,
        "top_driver": contributions[0] if contributions else None,
        "contributions": contributions,
        "model_blend": blend,
        "created_at": created_at,
    }
    if persist:
        db.execute(
            """INSERT INTO feature_importance_logs(
                 pair, horizon, probability, confidence, regime, contributions_json, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (pair, horizon, result, confidence["confidence"], regime["label"], json.dumps(contributions), created_at),
        )
        db.commit()
    return explanation


def score_pair(db: sqlite3.Connection, pair: str, horizon: int, features: dict[str, float], blend: float, vix: float | None = None) -> dict[str, Any]:
    explanation = explain_pair(db, pair, horizon, features, blend, vix=vix, persist=True)
    db.execute(
        "INSERT INTO forecasts(pair, horizon, probability, created_at) VALUES (?, ?, ?, ?)",
        (pair, horizon, explanation["probability_up"], explanation["created_at"]),
    )
    db.commit()
    return explanation


def main() -> None:
    parser = argparse.ArgumentParser(description="FX hybrid scoring and walk-forward validation engine")
    parser.add_argument("--db", default="forex.db", help="SQLite database path")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init-db")
    sub.add_parser("refresh")
    sub.add_parser("build-training")

    snapshot = sub.add_parser("ingest-snapshot")
    snapshot.add_argument("--pair", required=True)
    snapshot.add_argument("--as-of", required=True)
    snapshot.add_argument("--close", type=float, required=True)
    snapshot.add_argument("--features", required=True)

    train = sub.add_parser("train")
    train.add_argument("--horizon", type=int, choices=HORIZONS)
    train.add_argument("--blend", type=float, default=0.8)

    backtest = sub.add_parser("backtest")
    backtest.add_argument("--horizon", type=int, choices=HORIZONS)
    backtest.add_argument("--blend", type=float, default=0.8)
    backtest.add_argument("--window", choices=("expanding", "rolling"), default="expanding")
    backtest.add_argument("--initial-train", type=int, default=40)
    backtest.add_argument("--test-size", type=int, default=20)
    backtest.add_argument("--rolling-train-size", type=int, default=180)

    score = sub.add_parser("score")
    score.add_argument("--pair", required=True)
    score.add_argument("--horizon", type=int, choices=HORIZONS, required=True)
    score.add_argument("--features", required=True)
    score.add_argument("--blend", type=float, default=0.8)
    score.add_argument("--vix", type=float)

    explain = sub.add_parser("explain")
    explain.add_argument("--pair", required=True)
    explain.add_argument("--horizon", type=int, choices=HORIZONS, required=True)
    explain.add_argument("--features", required=True)
    explain.add_argument("--blend", type=float, default=0.8)
    explain.add_argument("--vix", type=float)

    sentiment = sub.add_parser("sentiment")
    sentiment.add_argument("--currency", required=True)
    text_source = sentiment.add_mutually_exclusive_group(required=True)
    text_source.add_argument("--text")
    text_source.add_argument("--file")
    sentiment.add_argument("--engine", choices=("lexicon", "finbert"), default="finbert")
    sentiment.add_argument("--source", default="Manual central-bank text")

    export = sub.add_parser("export-web")
    export.add_argument("--horizon", type=int, choices=HORIZONS, default=30)
    export.add_argument("--blend", type=float, default=0.8)

    args = parser.parse_args()
    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    db = connect(args.db)
    if args.command == "init-db":
        result: Any = {"database": args.db, "status": "ready"}
    elif args.command == "refresh":
        result = refresh_data(db)
    elif args.command == "ingest-snapshot":
        features = parse_features(args.features)
        db.execute(
            """INSERT INTO feature_snapshots(pair, as_of, close, features_json) VALUES (?, ?, ?, ?)
               ON CONFLICT(pair, as_of) DO UPDATE SET close=excluded.close, features_json=excluded.features_json""",
            (args.pair.upper(), args.as_of, args.close, json.dumps(features)),
        )
        db.commit()
        result = {"pair": args.pair.upper(), "as_of": args.as_of, "status": "stored"}
    elif args.command == "build-training":
        result = {"examples_added": build_examples(db)}
    elif args.command == "train":
        horizons = (args.horizon,) if args.horizon else HORIZONS
        result = [train_horizon(db, horizon, clamp(args.blend)) for horizon in horizons]
    elif args.command == "backtest":
        horizons = (args.horizon,) if args.horizon else HORIZONS
        result = [walk_forward_horizon(
            db,
            horizon,
            clamp(args.blend),
            window=args.window,
            initial_train=max(20, args.initial_train),
            test_size=max(1, args.test_size),
            rolling_train_size=max(args.initial_train, args.rolling_train_size),
        ) for horizon in horizons]
    elif args.command == "score":
        result = score_pair(
            db, args.pair.upper(), args.horizon, parse_features(args.features), clamp(args.blend), vix=args.vix,
        )
    elif args.command == "explain":
        result = explain_pair(
            db, args.pair.upper(), args.horizon, parse_features(args.features), clamp(args.blend), vix=args.vix,
        )
    elif args.command == "sentiment":
        text = args.text if args.text is not None else Path(args.file).read_text(encoding="utf-8")
        result = score_sentiment(text, args.engine)
        currency = args.currency.upper()
        upsert_observation(
            db, currency, "nlpSentiment", result["factor_score"], dt.date.today().isoformat(), args.source,
        )
        db.commit()
        result = {"currency": currency, **result, "status": "stored"}
    else:
        learned = latest_learned_weights(db, args.horizon)
        count = db.execute("SELECT COUNT(*) FROM training_examples WHERE horizon=?", (args.horizon,)).fetchone()[0]
        validation = db.execute(
            """SELECT window_mode, fold_count, oos_sample_count, accuracy, log_loss, brier_score, validated_at
               FROM walk_forward_runs WHERE horizon=? ORDER BY validated_at DESC LIMIT 1""",
            (args.horizon,),
        ).fetchone()
        result = {
            "modelBlend": clamp(args.blend),
            "expertWeights": normalize(EXPERT_WEIGHTS),
            "learnedWeights": learned,
            "trainedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "trainingSamples": count,
            "walkForwardValidation": dict(validation) if validation else None,
            "regime": detect_regime(latest_vix(db)),
        }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
