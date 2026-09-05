# FX Engine CLI

Die Kern-Engine verwendet nur Python-Standardbibliotheken und SQLite. API-Schlüssel werden ausschließlich aus `FRED_API_KEY` und `ALPHA_VANTAGE_API_KEY` gelesen. FinBERT ist optional und wird nur für den NLP-Befehl geladen.

```bash
python3 python/forex_engine.py --db data/forex.db init-db
python3 python/forex_engine.py --db data/forex.db refresh
python3 python/forex_engine.py --db data/forex.db ingest-snapshot --pair EURUSD --as-of 2026-09-04 --close 1.165 --features '{"policy":0.2,"inflation":0.1,"growth":0.3,"yields":0.2,"cot":0.1,"commodities":0,"risk":0.2,"seasonality":0.1,"momentum":0.4,"sentiment":0.15}'
python3 python/forex_engine.py --db data/forex.db build-training
python3 python/forex_engine.py --db data/forex.db train --blend 0.8
python3 python/forex_engine.py --db data/forex.db backtest --horizon 30 --window expanding --initial-train 40 --test-size 20 --blend 0.8
python3 python/forex_engine.py --db data/forex.db backtest --horizon 30 --window rolling --rolling-train-size 180 --initial-train 40 --test-size 20 --blend 0.8
python3 python/forex_engine.py --db data/forex.db score --pair EURUSD --horizon 30 --blend 0.8 --features '{"policy":0.2,"inflation":0.1,"growth":0.3,"yields":0.2,"cot":0.1,"commodities":0,"risk":0.2,"seasonality":0.1,"momentum":0.4,"sentiment":0.15}'
python3 python/forex_engine.py --db data/forex.db explain --pair EURUSD --horizon 30 --vix 24.5 --features '{"policy":0.2,"inflation":0.1,"growth":0.3,"yields":0.2,"cot":0.1,"commodities":0,"risk":0.2,"seasonality":0.1,"momentum":0.4,"sentiment":0.15}'
```

## Walk-Forward statt In-Sample-Backtest

`backtest` trainiert nie auf Testdaten. Zusätzlich werden Trainingslabels verworfen, deren Zielzeitpunkt in das nächste Testfenster reicht (Purging gegen Horizon-Leakage). Bei `expanding` wächst das Trainingsfenster nach jedem Fold; bei `rolling` bleibt nur das jüngste, über `--rolling-train-size` begrenzte Trainingsfenster erhalten. Die Ausgabe enthält pro Fold getrennte Datumsbereiche sowie aggregierte Out-of-Sample-Werte für Accuracy, Log-Loss und Brier-Score.

## FinBERT-Sentiment

Für das kostenlose Modell `ProsusAI/finbert` einmalig installieren:

```bash
python3 -m pip install transformers torch
python3 python/forex_engine.py --db data/forex.db sentiment --currency EUR --engine finbert --file statement.txt --source ECB
```

Ohne Zusatzpakete steht `--engine lexicon` als reproduzierbarer Offline-Fallback bereit. Beide Varianten speichern einen normalisierten `nlpSentiment`-Faktor in SQLite.

## Konfidenz, Regime und Explainability

`score` liefert neben `probability_up` eine Konfidenz aus Trainingsumfang und Richtungskonsistenz der gewichteten Signale. Das Regime wird aus dem FRED-VIX (`VIXCLS`) abgeleitet und passt die Gewichte automatisch an. `score` und `explain` schreiben sortierte Faktorbeiträge in `feature_importance_logs`; das Web-Terminal stellt dieselben Diagnosen getrennt unter `/api/model-debug` bereit.

Cron-Beispiel für tägliche Datenaktualisierung um 17:15 Uhr und wöchentliches Re-Training am Sonntag:

```cron
15 17 * * * cd /path/to/fx-macro-terminal && /usr/bin/python3 python/forex_engine.py --db data/forex.db refresh
0 18 * * 0 cd /path/to/fx-macro-terminal && /usr/bin/python3 python/forex_engine.py --db data/forex.db build-training && /usr/bin/python3 python/forex_engine.py --db data/forex.db backtest --window expanding --blend 0.8 && /usr/bin/python3 python/forex_engine.py --db data/forex.db train --blend 0.8
```

`export-web` gibt Gewichte, letzte Walk-Forward-Metriken und Regime im Format des Web-Terminals aus. Erst ab ausreichender chronologischer Historie wird validiert und trainiert; vorher bleibt das transparente Bootstrap-Modell aktiv.
