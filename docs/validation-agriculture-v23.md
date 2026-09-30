# Validation und Agricultural Research – Abschlussstand 30.09.2026

Fortsetzung von GitHub `f9ec257041e8cc0a9e24e8b62b40862add88631c`, bestehende Site v22, identischer Ausgangsbaum `2fcd0525400d980e78882301b9554ca883a7f970`. Der Arbeitsauftrag heißt V22; die nächste gespeicherte Site-Version ist v23. Projekt, öffentliche URL, D1 und Scheduler bleiben dieselben. Keine Produktions-Testdaten, Löschungen, Secret-Änderungen oder manuelle Aktivierung. Die v19–v22-Arbeiten einschließlich RSS-Datum, CAD-Sprachdaten, automatischer Gewichtung und Forecast-Migration bleiben erhalten.

## IMPLEMENTED

- Die aktive Validation nutzt alle zulässigen Forecast-Daten. Die alte `labelEnd + horizon`-Ausdünnung entfällt. `independentBlocks` bleibt nur im abgeschalteten alten Research-Layer und für den reproduzierbaren Alt/Neu-Bericht.
- Ein Datum ist ein Zeitcluster, kein einzelnes Currency-Sample. Gleiche Währung am selben Datum wird deterministisch auf die erste zulässige Prediction reduziert. Training und Validation verwenden keine doppelten Intraday-Beispiele.
- Purging prüft tatsächliche Entry-/Label-End-Intervalle und die Verfügbarkeit des Outcomes am Testbeginn. Embargo gilt nur nach einer vorangegangenen Fold-Grenze bis zu deren letztem realen Label-Ende. Es entfernt nicht periodisch alle Zwischenbeobachtungen.
- Entfernte Trainingszeilen erhalten Grund, Entity, Forecast-Zeit, Entry, Ende und Test-/Embargogrenzen. Main-/Context-Retrain schreibt einzelne `purge-audit`-Records. Hypothesen speichern zusätzlich `hypothesis-split` und die zugehörigen Einzelentfernungen. Alte Records werden nicht umgeschrieben.
- Main ML und Context ML: chronologische Entwicklung, expandierende Walk-Forward-Folds, letzte 20 % Forecast-Daten als Holdout; finale Gewichte ausschließlich aus vor dem Holdout verfügbaren, gepurgten Trainingslabels. Änderungen nur an Holdout-Labels verändern weder Gewichte noch Feature-Vokabular. Danach bleiben neue Modelle bei 0 in SHADOW.
- Deterministische Hypothesen: erste 1/3 der Daten Entwicklung/Initialisierung, nächste 1/2 Validation, letztes 1/6 Holdout. Eine unveränderte Formel erhält neue, nach Datum festgelegte Testepochen frühestens alle zehn Forecast-Daten. Spätere Epochen dürfen frühere Testdaten in frühere Abschnitte übernehmen; sie werden deshalb ausdrücklich als weitere korrigierte Tests gezählt. Das ist kein immer wieder unberührter identischer Holdout.
- Historische und Holdout-Zertifikate bleiben separat erhalten. Context ML braucht beide Vergleiche gegen Core **und** gegen das einfache Hypothesen-Ensemble. Eine spätere Shadow-Prüfung kann ein fehlgeschlagenes historisches Zertifikat nicht überschreiben.
- Hypothesen benötigen zusätzlich einen eingefrorenen Vergleich gegen Core plus die anderen damals wirksamen adaptiven Beiträge, jeweils ohne sich selbst. Feature-/Signal-/Loss-Korrelation, gemeinsame Datenherkunft, Decay, Quellenqualität und Regime bleiben Freigabebedingungen.
- Neue Agrar-Hypothesen haben zusätzlich einen konservativen Common-Cause-Screen gegen variable Core-/FX-/Energie-/Proxy-Kontrollen: mindestens 30 verschiedene Tage, mindestens drei variable Kontrollreihen; absolute Korrelation über 0,8 blockiert. Das ist ein zusätzlicher Redundanzfilter, **kein Kausalitätsbeweis**. Zahlen und Entscheidung werden separat gespeichert.
- Discovery priorisiert beobachtete Features anhand Neuheit, Herkunft, wirtschaftlicher Definition, zeitlicher Verfügbarkeit, Historientiefe und Variation – niemals anhand späterer Outcomes. Neue Operatoren: saisonales Fenster, beobachtetes Regime, Schwelle, vergangenheitsbasierter Z-Score, Beschleunigung. Dazu die bestehenden Level-/Change-/Lag-/Interaction-Rezepte. Außerhalb eines Saison-/Regime-/Schwellenfensters entsteht kein Signal statt einer künstlichen Neutralprognose.
- Budget unverändert begrenzt: maximal acht neue Kandidaten pro Refresh, 128 nicht abgelehnte Hypothesen, 4.096 Formeln insgesamt. Neue Daten eröffnen keine unbegrenzte Suche. Bestehende Formeln behalten ihre Identität; neue Grammatik erhält eine eigene Version.
- UI/Health zeigen je Horizon Rohdaten, verschiedene Forecast-Tage, Overlap, Training, effektive Information, Folds, OOS, Purging, Holdout/Shadow und nächste Bedingung. Hypothesen und Currency-/Pair-Context besitzen eigene Detaildiagnosen. Alte Snapshots melden fehlende neue Detaildiagnosen ehrlich bis zum nächsten Refresh.

## Statistik: was die neue ESS bedeutet

Pro Forecast-Tag wird die mittlere gepaarte Brier-Loss-Verbesserung gegenüber dem eingefrorenen Benchmark gebildet. Acht gleichzeitige Währungen erzeugen höchstens **einen** Zeitcluster. Die Bartlett/Newey-West-Varianz berücksichtigt serielle Kovarianzen. Die Bandbreite ist mindestens so lang wie die tatsächlich überlappenden Labelintervalle; eine zweite Berechnung mit doppelter Bandbreite darf die Unsicherheit nur erhöhen.

`ESS = min(Anzahl Tage, Anzahl verschiedener Entry/End-Intervalle, Tage × Stichprobenvarianz / konservative Langfristvarianz)`.

Die Langfristvarianz ist das Maximum aus einfacher Varianz und beiden HAC-Schätzungen. Negative Autokovarianz erhöht ESS daher nicht über die beobachteten Tage/Intervalle. Identische Wochenend-Entry-/End-Paare werden nicht zu zusätzlicher unabhängiger Information. Nullvarianz, kaputte Intervalle und nicht belegte Point-in-Time-Daten qualifizieren nicht.

Verwendet wird eine einseitige Student-t-Approximation mit ESS-basierten Freiheitsgraden. Methodischer Bezug: [Newey/West, ursprüngliches Paper](https://www.nber.org/papers/t0055). HAC ist eine asymptotische Schätzung unter geeigneten Abhängigkeits-/Stabilitätsannahmen, keine exakte endliche Stichprobengarantie und kein Schutz gegen jede denkbare Nichtstationarität. Deshalb bleiben getrenntes OOS, Holdout, neue Zukunftsdaten, Kalibrierung, Regimes, Drift und Rückfallpflicht bestehen.

Keine reine Schwellenabsenkung: Hypothesen brauchen insgesamt historische ESS ≥120, Validation ESS ≥60, Holdout ESS ≥20 und danach zukünftige Shadow ESS ≥30. Main-/Context-ML brauchen Walk-Forward ESS ≥60, Holdout ESS ≥20, mindestens drei Folds, danach zukünftige Shadow ESS ≥30. Jeweils zusätzlich mindestens zwei unterstützte Regimes (ESS ≥10 je Regime), positive Teilperioden, Stabilität ≥65 %, bessere Log-Loss/Brier-Leistung, begrenzter Kalibrierungsfehler und positive jüngere Leistung. Die Zahlen sind notwendige, nicht ausreichende Bedingungen.

Family-Correction, versions-/retrainabhängige Suchkorrektur und `look × (look + 1)`-Alpha-Spending bleiben aktiv. Jede erneute historische oder prospektive Prüfung zählt. Ein Retrain allein kann keinen Einfluss freischalten. Vorherige Zertifikate ohne `date-cluster-hac-v1` gelten nicht automatisch als neue Qualifikation; heute gibt es ohnehin keine aktiven Modelle/Hypothesen.

## ALT / NEU mit echten Produktionsdaten

Basis: 104 unveränderte, tatsächlich aufgelöste Outcomes aus Produktions-D1, read-only am 30.09.2026. Reproduzierbar mit `node scripts/validation-audit.mjs`; Ausgangsdaten und Ausgabe liegen in `docs/evidence/validation-*-2026-09-30.json`. Keine simulierten Labels in dieser Tabelle.

| Horizon | OLD Raw | OLD Blöcke / genutzte Zeilen | NEW Raw | NEW verschiedene Forecast-Tage | NEW genutzte Zeilen | Label-Prozess-ESS | OOS-Folds / Purging |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1D | 40 | 1 / 8 | 40 | 4 | 32 | 4 | 0 / 0 |
| 3D | 40 | 1 / 8 | 40 | 4 | 32 | 4 | 0 / 0 |
| 5D | 24 | 1 / 8 | 24 | 2 | 16 | 0 – zu klein | 0 / 0 |
| 10D | 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 30D | 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 60D | 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 90D | 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 / 0 |

Die alte Auswahl ließ 80/104 Rohzeilen ungenutzt. Davon sind 24 legitime gleiche Datum/Entity-Duplikate; **56 zusätzliche Zeilen** werden jetzt erhalten. Insgesamt 80 statt 24 nutzbare Zeilen, entsprechend 10 statt 3 Horizon/Datum-Clustern. Das sind nicht 80 unabhängige Beobachtungen. Anteil überlappender Intervallpaare: 1D 50 %, 3D/5D 100 %.

Die angegebene ESS beschreibt ausschließlich den Label-Prozess. Eine kandidatenspezifische ESS der gepaarten Loss-Verbesserung kann daraus nicht rekonstruiert werden; **Qualifikations-ESS ist hier nicht verfügbar**, nicht erfunden. Mangels trainiertem langem Modell existieren in dieser Produktion noch keine solchen Folds/Purging-Entfernungen. Alle Kurzfrist-Horizonte bleiben Hilfs-/Hypothesentargets; 1D ersetzt kein 90D-Outcome.

## Agricultural Research: angeschlossen und begrenzt

Öffentliche, rein lesende Prüfung am **30.09.2026 13:12:46 UTC**: neun öffentliche Quellabfragen erfolgreich, **42 valide Research-Beobachtungen**. Prüfdatei: `docs/evidence/agricultural-source-check-2026-09-30.json`. Das ist Adapter-/Quellennachweis, keine Produktions-D1-Ingestion und keine Prognosevalidierung. Neue optionale Anfragen sind auf drei gleichzeitig begrenzt.

| Quelle | Implementierte Features | Referenz / Frequenz und Grenzen |
|---|---|---|
| [USDA NASS Crop Progress](https://esmis.nal.usda.gov/publication/crop-progress) | Corn/Soy/Winter-/Spring-Wheat good+excellent, gedruckte Wochenänderung; Aussaat/Ernte und Abweichung vom veröffentlichten Fünfjahreswert; Top-/Subsoil very short+short | Wochenberichte in der Saison. Aktuell zwölf Werte, Referenz 27.09., Veröffentlichung 28.09.2026. Fehlende saisonale Weizenzeilen werden nicht ergänzt. Nationale Provider-Gewichte, keine erfundenen Ertragsprognosen |
| [USDA NASS Crop Production](https://esmis.nal.usda.gov/publication/crop-production) | Corn/Soy/Wheat acreage, yield, production; Corn/Soy monatliche Yield-Revision mit benannten Vor-/Aktuellspalten | Elf Werte aus Bericht 11.09.2026. Ernteschätzungen sind veröffentlichte Erwartungen, keine schon realisierten zukünftigen Ernten. Keine Marktkonsens-Surprises |
| [USDA NASS Grain Stocks](https://esmis.nal.usda.gov/publication/grain-stocks) | Corn/Soy/Wheat Gesamtbestände, YoY-Log-Transformation | Drei Werte; Referenz 01.06., Veröffentlichung 30.06.2026. Quartalsdaten, keine künstliche tägliche Aktualität |
| [US Drought Monitor API](https://usdmdataservices.unl.edu/) | D2+/D4+-Flächenanteil und Siebentageänderung | Vier Werte. CONUS-Fläche, nicht nach Crop-Produktion gewichtet; Dienstagsreferenz ist kein behaupteter Veröffentlichungszeitpunkt |
| [NOAA NCEI Climate at a Glance](https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/) | Monatliche CONUS-Temperatur-/Niederschlagsabweichung vom Normal 1991–2020 | Zwei Werte. Keine täglichen Heat-Stress-Tage, Wettervorhersagen oder regionale Crop-Exposition |
| [EIA Fuel Ethanol](https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=pet&s=W_EPOOXE_YOP_NUS_MBBLD&f=w) | Produktion und Ending Stocks, jeweiliges Level und Wochen-Log-Änderung | Vier Werte, getrennte Einheiten thousand barrels/day bzw. thousand barrels; Referenz 18.09., Veröffentlichung 23.09.2026 |
| [USDA AMS Grain Inspections](https://www.ams.usda.gov/mnreports/wa_gr101.txt) | Corn/Soy/Wheat Inspektionsvolumen und Wochenänderung | Sechs Werte, metrische Tonnen; Referenz 24.09., Veröffentlichung 28.09.2026. Exportinspektionen sind keine Exportverkäufe |
| IMF über FRED: [Corn](https://fred.stlouisfed.org/series/PMAIZMTUSDM), [Wheat](https://fred.stlouisfed.org/series/PWHEAMTUSDM), [Soy](https://fred.stlouisfed.org/series/PSOYBUSDM) | Monatliches Level, 1M/3M-Änderung, 12M-Realized-Volatilität bei vollständigen Monaten, saisonale Abweichung bei ≥3 Vorjahren | API-Adapter implementiert, vorhandenes Produktions-FRED-Secret konfiguriert und unverändert. Lokaler Live-API-Test ohne Secret: NOT_CONFIGURED. Serienmetadaten verifiziert, authentifizierte Ingestion noch nicht. Aktuelle öffentliche FRED-Karten zeigen Juli 2026; bei unverändertem API-Stand wäre das unter der 75-Tage-Regel STALE. Kein Erfolg/FRESH vorgetäuscht |

Wetter-/Dürre-/Crop-/Ethanol-/Exportdaten aus den USA gelten ausschließlich für USD. Globale monatliche Grain-Preisproxies besitzen dokumentierte, explizite Research-Expositionen: Corn USD/CAD/NZD/JPY; Wheat USD/AUD/CAD/EUR/GBP/JPY/CHF; Soy USD/CAD/AUD/NZD. Begründungen stehen an jeder Rohbeobachtung. Die schwache CHF-Food-/AUD-China-/NZD-Feed-Verbindung ist eine zu prüfende Möglichkeit, keine behauptete bullische/bärische Wirkung.

Referenzperiode, Veröffentlichungsdatum, frühester offizieller Termin und tatsächlicher Empfang bleiben getrennt. Unbekannte genaue Veröffentlichung bleibt `releaseDate=null`, `publicationTimeKnown=false`. US-Veröffentlichungspläne berücksichtigen New-York-Sommer-/Winterzeit, werden aber nicht als exakte gemessene Veröffentlichung ausgegeben. Revidierte Historie wird erst ab tatsächlichem Empfang bekannt; alte Inhalte/Vintages/Predictions bleiben unverändert.

Nicht angebunden: tägliche Grain-Futures/5D- oder20D-Preisänderungen, crop-gewichtete regionale Wetterpanels, echte tägliche Heat-Stress-Tage, WASDE-Bilanzen, Soybean Crush und archivierter Forecast-Konsens. Ein zusätzlicher Stress-Composite wurde bewusst nicht mit erfundenen Gewichten eingeführt. Premium-Options-/Basis-/Freight-/Retail-/Trend-/Social-/YouTube-Feeds bleiben wie zuvor ehrlich als Lücke sichtbar. Keine externe Variable bekommt einen eigenen Punkt in der Punktewolke.

## TESTED und Grenzen

Gezielte Tests zuerst, danach vollständige Suite: **143 Tests**, einschließlich RSS/Datums-/Freshness-/Revision-/Future-Rejection, COT/BIS/WDI/FRED/Narrative, neuen Agrarparsers, HAC/ESS, genauer Intervalle, Shadow/Activation, Context-/Holdout-Isolation, Cap/Runtime/Kill-Switch, SQLite-Persistenz, Outcomes, Cron und Forecast-Regression. Sämtliche synthetischen Fixtures laufen ausschließlich lokal/in CI. Typecheck und Lint werden im Abschluss-Workflow erneut geprüft; Lint besitzt die unveränderte Scheduler-Export-Warnung, keine neue Warnung.

Die existente Forecast-Fixture `tests/fixtures/pre-automatic-forecasts.json` bleibt unverändert. Core-Faktorgewichte, feste Baseline, Evidence-Kombination, Strength-/Pair-/Dominance-/Forecast-/Punktwolkenformeln werden nicht geändert. Abwesende/unqualifizierte Agrarsignale erzeugen exakt 0 zusätzlichen Einfluss. Pair-Context wird weiterhin nicht in Currency Evidence zurückprojiziert.

Browser-E2E **BLOCKED**: interner Preview-Server startete, der Testbrowser verweigerte die Navigation mit `net::ERR_BLOCKED_BY_CLIENT`. Kein Browser-Pass behauptet. Produktions-Health per HTTP lieferte 401; Authentifizierung blieb unverändert. Betriebsdaten wurden deshalb über den autorisierten, read-only Sites-D1-Zugang geprüft. Keine gefälschten Nutzerheader und kein Bypass der App-Anmeldung.

Produktionsbuild, GitHub-CI, finaler Commit und gespeicherte/deployte Site-Version werden aus den tatsächlichen Abschlussresultaten im Handoff angegeben; dieser Bericht behauptet keinen zukünftigen Build-/Deploy-Erfolg vor dessen Ergebnis.

## LIVE VERIFIED: vorhandener Produktionsbetrieb

Stand vor Veröffentlichung dieses Changes; vollständige Einzelbelege in `docs/evidence/production-baseline-2026-09-30.json`.

| Kennzahl | Real beobachteter Wert |
|---|---|
| Letzter erfolgreicher echter Daily Cron | 29.09.2026 15:16:54.327 UTC, `CLOUDFLARE_CRON`, HTTP200, Snapshot vorgerückt; Run `6f5e161d-86fe-4714-980f-d6c906238294` |
| Letzter erfolgreicher Refresh | 29.09.2026 20:22:50.285 UTC, **MANUAL**, Run `eb65a1b3-f940-47a3-83b1-04ffdb66f3de` aus dem früheren Lauf |
| Letzter Snapshot | 29.09.2026 20:21:46.921 UTC |
| Snapshots / aktuelle Beobachtungen / Vintages | **44 / 237 / 1.598**. 237 durch vollständige Paginierung gezählt; 230 im Snapshotstatus war ausdrücklich vor dem damaligen Upsert |
| Resolved Outcomes / Main-Training-Beispiele | **104 / 0** |
| Aktuelles ML-Modell / operativer Status | **DETERMINISTIC_CORE / WAITING_FOR_DATA**; Gesamtpipeline des letzten Snapshots `WAITING_FOR_QUALITY_DATA` |
| ML / Hypothesen / adaptiver Gesamteinfluss | **0 % / 0 % / 0 %** |
| Hypothesen gesamt / Testing / Shadow / Active / Rejected | **96 / 96 / 0 / 0 / 0** |
| Letzter regulärer Weekly Retrain | 26.09.2026 20:01:07.695 UTC; Cron-Request HTTP200, Ende 20:01:10.777; **WAITING_FOR_DATA**, 0 Samples |
| Adaptive Cap / technische Obergrenze | **10 % / 15 %**, gemeinsam für ML und Hypothesen |
| Runtime Gates | Alle drei effektiv **true** durch explizit geprüfte Defaults; keine deaktivierenden Env-Werte. Runtime-Revision9 unverändert |
| Coverage | **PARTIAL LIVE**, Core54/80, kritisch40/60; rein Datenquellenstatus |
| Qualitätslücken | 13 carried +13 partial; 0 stale; 10 Faktoren mit Fehlermerkmal, 13 ohne belegte Inputs; Merkmale überlappen |
| Source Checks | 18 nicht erfolgreiche Einzelchecks:14 FAILED +4 MISSING. Diese Zahl ist nicht die Anzahl verschiedener Provider oder fehlerhafter Faktoren |
| Letzter Pipelinefehler | Kein `error`-Record vorhanden; aktive Source-Fehler unten. Der große Zustandsdatensatz wird im administrativen Reader gekürzt, daher kein erfundener vollständiger Health-Read |
| Neue Agrar-Production-Records | Noch keine vor diesem Deployment. Nächster regulärer Daily-Cron: 30.09.2026 ab17:15 Europe/Berlin; erst dessen echte Records können die neue Version LIVE verifizieren |

Fehlende/partielle Core-Faktoren: alle acht Yields, alle acht Risk, alle acht Commodity-Kontexte sowie JPY/NZD Sentiment. Kritisch davon: acht Yields, acht Risk, vier Commodity. Der unveränderte Risk-Anchor und fehlende Commodity-Score-Definitionen werden nicht durch Agrardaten heimlich ersetzt. LIVE benötigt alle60 kritischen Kombinationen und jede vertretene Core-Kategorie; FULL LIVE80/80. Freshness bleibt quellenabhängig.

Fehlgeschlagene Quellen: WDI EUR currentAccount/debt, JPY debt, AUD debt (ungültig/zu alt); RBA Exportbasket HTTP403; Alpha Vantage sieben Nicht-USD-Währungen PREMIUM_REQUIRED; zwei entdeckte WDI-Proxies ohne Daten. MISSING: UNODC EUR/GBP/NZD und UNCTAD CHF. Vollständige Inputliste einschließlich unveränderter nicht angebundener Yield-/Options-/Basis-/Freight- usw. Klassen steht im Health-UI und in `lib/research-coverage.ts`.

## WAITING FOR REAL DATA: Zeitplanung ohne Aktivierungsversprechen

Nur **ein gültiger täglicher Produktionsframe** wird angenommen. Das ist nicht eine neue unabhängige Marktbewegung pro Tag: ECB-Wochenenden können denselben Entry/End-Pfad teilen. Mit den vorhandenen wenigen Tagen ist die künftige Loss-Abhängigkeit nicht seriös schätzbar. „Realistic“ kann heute nur ein ausdrücklich angenommenes Planungsszenario sein, kein prognostiziertes Aktivierungsdatum.

Die folgenden frühesten Größenordnungen setzen außergewöhnlich klare stabile Effekte, alle p-/Qualitätsgates, schnell wechselnde geeignete Regimes und bis zu etwa5/7 informative neue Fixingintervalle pro Kalendertag voraus. Zehn-Tage-Prüfraster, Labelreife, Purging und der getrennte zukünftige Shadow sind eingeschlossen/aufgerundet. Das Planungsszenario setzt illustrativ **ESS/Forecast-Tage =0,25** an, nicht als Messwert. Bei0,05 dauern Informationsphasen ungefähr fünfmal so lange. Saisonfilter nutzen nur ihre tatsächlichen Saison-Tage und können mehrere Jahre zusätzlich benötigen.

| Layer / Horizon | EARLIEST POSSIBLE, ungefähre Untergrenze | REALISTIC – nur Szenario mit ESS-Anteil0,25 | ROBUST LONG-RUN, Beobachtungsziel |
|---|---|---|---|
| Hypothesen1D | etwa8 Monate | etwa21 Monate | mindestens2–3 Jahre / mehrere Regimes |
| Hypothesen3D | etwa8 Monate | etwa22 Monate | mindestens2–3 Jahre |
| Hypothesen5D | etwa9 Monate | etwa22 Monate | mindestens2–3 Jahre |
| Hypothesen10D | etwa9–10 Monate | etwa23 Monate | mindestens3 Jahre |
| Main-/Context-ML10D | etwa9 Monate | etwa25 Monate | mindestens3 Jahre |
| Main-/Context-ML30D | etwa11 Monate | etwa27 Monate | etwa3–5 Jahre |
| Main-/Context-ML60D | etwa13 Monate | etwa29 Monate | etwa4–7 Jahre |
| Main-/Context-ML90D | etwa17 Monate | etwa31 Monate | etwa5–10 Jahre oder mehr |

Rechenbasis für das Szenario: Hypothesen ungefähr `max(120/d, 2×(60/d + Grenzverlust), 120/d) + 30/d + zweimal Labelreife`; Main ML ungefähr `150/d + 30/d + zweimal Labelreife`, zusätzlich ausreichend Initialtraining vor der ersten Fold-Grenze. Kleine Raster-/Feiertags-/Review-Abweichungen sind nicht als exakter Termin modelliert. Für lange überlappende Targets kann0,25 wesentlich zu optimistisch sein. Mehr Daten allein garantieren keinen Edge: eine Hypothese kann dauerhaft REJECTED/SHADOW bleiben. Für saisonales Crop-Stress-Research sind mindestens mehrere echte Saisons sinnvoll; die Tabelle ist für kontinuierlich verfügbare Kandidaten.

## Antworten auf die25 Abschlussfragen

1. **Alte Logik überkonservativ?** Ja, im aktiven Gate wurde nach dem Label-Ende nochmals ein voller Horizon übersprungen. Der lokale Beleg zeigt beim10D-Target die nächste akzeptierte Prediction erst nach22 Tagen. Das eigentliche Main-Training war nicht pauschal um denselben Faktor ausgedünnt.
2. **Änderung?** Erhaltene überlappende Daten, Datumcluster, HAC/ESS, echte Grenz-Purges, getrennte historische/Holdout-/Shadow-Zertifikate und auditierbare Diagnosen.
3. **Overlapping Outcomes genutzt?** Ja; nur unzulässige/duplizierte und an Train/Test-Grenzen überlappende Trainingszeilen entfallen.
4. **Abhängigkeit?** Datumcluster, tatsächliche Intervallbandbreite, konservative HAC-Varianz und begrenzte ESS; keine iid-Zählung aller Zeilen.
5. **Purging?** Tatsächliche Entry/Label-End-Überlappung und reale Resolution-Verfügbarkeit am Testbeginn, mit Einzelgrund.
6. **Embargo?** Nur nach der vorangegangenen Fold-Grenze bis deren letztem Label-Ende, kein globaler zweiter Horizon-Abstand.
7. **ESS?** Formel und Grenzen oben. Geschätzt, nicht direkt beobachtete Anzahl unabhängiger Marktereignisse.
8. **Acht Währungen ein Cluster?** Ja, ein Forecast-Tag bleibt ein Zeitcluster.
9. **Prospective Shadow Pflicht?** Ja, nach bestandener historischer und Holdout-Prüfung ausschließlich neue zukünftige eingefrorene Prognosen/Outcomes.
10. **Multiple Testing aktiv?** Ja, Family-/Version-/Repeated-Look-Korrektur sowie Suchbudget.
11. **Schwelle nur gesenkt?** Nein. Informationsschwellen bleiben erhalten, aber die statistische Einheit ist nun geschätzte effektive Information statt unnötig ausgesiebter Blöcke. Die Inferenzmethode ist eine begründete Änderung mit den genannten Annahmen.
12. **Früher evaluierbar?** Insbesondere kontinuierliche1D/3D/5D/10D-Rezepte mit vorhandenen variablen Inputs und ausreichender effektiver Information. Monatliche/seasonale Reihen werden durch häufigeres Abrufen nicht plötzlich täglich neu.
13. **Erste adaptive Evidence wann?** Nicht seriös datierbar. Szenarien oben; heute weder genug lange Outcomes noch historische/Shadow-Freigabe.
14. **Agrarquellen?** NASS Progress/Production/Stocks, USDM, NOAA, EIA Ethanol, AMS Inspections; IMF/FRED-Monatspreisadapter mit bestehender Produktionskonfiguration, Live-API-Receipt noch nicht belegt.
15. **Agrarfeatures?** Level, Änderungen, Saisonabweichungen, Yield-Revisionen, Moisture/Drought/Weather, Ethanol und Exporte; Z-Score/Schwellen/Regime-/Saison-/Lag-/Interaction-/Acceleration-Grammatik.
16. **Fehlend?** Tägliche Futures, crop-regionale Wetter-/Heat-Stress-Panels, WASDE, Crush, historischer Forecast-Konsens; kein erfundener Composite.
17. **Automatisch entdeckte Agrarhypothesen?** Technischer Discovery-Test bestanden. In Produktions-D1 vor dem ersten neuen Cron **noch keine**. Ein lokaler Testkandidat zählt nicht als echte Produktionsentdeckung.
18. **Agrar-Evidence-Einfluss?** Nein,0 %.
19. **Warum0?** Fehlende echte prospektive Daten, historische/Holdout-/Shadow-/Regime-/Incremental-Zertifikate; neue Quelle allein reicht nie.
20. **Falls ja, bestandene Gates?** Nicht zutreffend; keine Aktivierung behauptet.
21. **Default Cap10 %?** Ja, gemeinsamer Gesamtdeckel.
22. **Hard Cap15 %?** Ja.
23. **Final Evidence exact-once?** Unverändert, mit bestehender Regression abgesichert: Core + validierte Komponenten; kein zweiter Adaptive-Shift und kein direkter NLP-Eingriff.
24. **Punktewolke vollständiger Modellzustand?** Ja; keine zusätzlichen Mais-/News-/Event-Punkte.
25. **Nur zukünftige Daten abwarten?** Reife Outcomes, zeitlich belegte Qualifikation, echte Aktivierung, Gewichtserhöhung, Degradation/Rollback als Produktionsereignis und neues Cron-Ingestion-Proof. Die separat aufgeführten nicht angebundenen Daten-/Core-Definitionslücken lösen sich nicht durch bloßes Warten.

## Ursprüngliche Automatikfragen: eindeutiger Betriebsbefund

Daily-Sammlung, unveränderliche Frames, zukünftige Outcome-Auflösung, Weekly-Challenger, Hypothesen-Discovery und spätere regelgebundene Aktivierung sind automatisch verdrahtet. Gültige ML- und Hypothesenbeiträge erreichen Final Evidence, danach genau einmal Strength, Pair Scores, Dominance und Forecasts. Kein manueller ML-Anteil/Hybrid-Regler ist erforderlich; die frühere Migration und ihre Forecast-Fixture bleiben erhalten. Alle drei Runtime-Kill-Switches erlauben die Pipeline, während tatsächlicher Einfluss0 bleibt. Qualitätsverlust, OOD, Quellenfehler, alte Qualifikation oder kollabierende Gates reduzieren/deaktivieren Beiträge; ein noch qualifizierter Champion kann übernommen werden, sonst bleibt der Core. Diese zukünftigen Markt-/Rollback-Ereignisse sind **technisch getestet**, heute nicht künstlich LIVE VERIFIED.

PARTIAL LIVE betrifft ausschließlich Datenabdeckung. Die fehlenden kritischen Yields/Risk/Commodity-Kombinationen verhindern LIVE unabhängig vom Lernstatus. Das neue Research erweitert Daten und testbare Hypothesen, nicht die Core-Gewichtungen oder das Vertrauen ohne Beleg.
