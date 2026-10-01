"""Independent arithmetic and official-source comparison; never writes a database.

Usage: python scripts/audit-seasonality.py <ECB XML> <Fed H10 ZIP>
Inputs are the original downloaded official documents, not engine-produced prices.
"""
import csv
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

root = Path(__file__).resolve().parent.parent
csv_path = root / "public/data/seasonality/h10-bootstrap.csv"
with csv_path.open() as handle:
    rows = list(csv.DictReader(handle))
ecb_path, fed_path = map(Path, sys.argv[1:3])
ecb = {}
for node in ET.parse(ecb_path).getroot().iter():
    if "time" in node.attrib:
        ecb[node.attrib["time"]] = {"EUR": 1.0, **{
            item.attrib["currency"]: float(item.attrib["rate"]) for item in node}}
with zipfile.ZipFile(fed_path) as archive:
    fed_root = ET.fromstring(archive.read("H10_data.xml"))
ids = {"EUR": "DEXUSEU", "GBP": "DEXUSUK", "AUD": "DEXUSAL", "NZD": "DEXUSNZ",
       "JPY": "DEXJPUS", "CHF": "DEXSZUS", "CAD": "DEXCAUS"}
fed, counts, mismatches = {}, {}, []
for series in fed_root.iter():
    currency = series.attrib.get("CURRENCY")
    if series.tag.endswith("Series") and series.attrib.get("FREQ") == "9" and currency in ids:
        fed[currency] = {n.attrib["TIME_PERIOD"]: float(n.attrib["OBS_VALUE"])
                         for n in series if n.attrib.get("OBS_STATUS") == "A"}
for currency, series in ids.items():
    counts[currency] = 0
    for row in rows:
        raw = row[series]
        if raw in ("", "."):
            continue
        counts[currency] += 1
        official = fed[currency].get(row["observation_date"])
        if official is None or abs(float(raw) - official) > 1e-10:
            mismatches.append({"currency": currency, "date": row["observation_date"],
                               "fred": float(raw), "fed": official})

# Explicit raw-quote formulas are intentionally independent from the TS canonical engine.
formulas = {
    "EURUSD": ("DEXUSEU",), "AUDUSD": ("DEXUSAL",), "USDCHF": ("DEXSZUS",),
    "AUDCAD": ("DEXUSAL", "DEXCAUS"), "GBPCAD": ("DEXUSUK", "DEXCAUS"),
}
checks = []
for pair, legs in formulas.items():
    for year, start, end in [(2010, "10-04", "10-27"), (2016, "06-20", "06-30"),
                             (2020, "03-02", "03-27"), (2025, "10-03", "10-27")]:
        selected = [r for r in rows if f"{year}-{start}" <= r["observation_date"] <= f"{year}-{end}"
                    and all(r[s] not in ("", ".") for s in legs)]
        def price(row):
            value = float(row[legs[0]])
            return value if len(legs) == 1 else value * float(row[legs[1]])
        first, last = selected[0], selected[-1]
        a, b = price(first), price(last)
        start_date, end_date = first["observation_date"], last["observation_date"]
        ea = ecb[start_date][pair[3:]] / ecb[start_date][pair[:3]]
        eb = ecb[end_date][pair[3:]] / ecb[end_date][pair[:3]]
        checks.append({"pair": pair, "year": year, "start": start, "end": end,
                       "startDate": start_date, "endDate": end_date,
                       "sourceStart": {s: float(first[s]) for s in legs},
                       "sourceEnd": {s: float(last[s]) for s in legs},
                       "startPrice": a, "endPrice": b, "return": b / a - 1,
                       "mfe": max(0, max(price(r) / a - 1 for r in selected)),
                       "mae": min(0, min(price(r) / a - 1 for r in selected)),
                       "ecbStart": ea, "ecbEnd": eb, "ecbReturn": eb / ea - 1,
                       "returnDifferenceBps": ((b / a - 1) - (eb / ea - 1)) * 10000,
                       "startDifferenceBps": (a / ea - 1) * 10000,
                       "endDifferenceBps": (b / eb - 1) * 10000})
confirmed = json.loads((root / "public/data/seasonality/h10-verified-large-moves.json").read_text())
assert hashlib.sha256(fed_path.read_bytes()).hexdigest() == confirmed["sha256"], "Use the archived receipt, or review a new official archive explicitly"
for observation in confirmed["observations"]:
    assert fed[observation["currency"]][observation["date"]] == observation["raw"]
print(json.dumps({"fredSha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
                  "fedSha256": hashlib.sha256(fed_path.read_bytes()).hexdigest(),
                  "ecbSha256": hashlib.sha256(ecb_path.read_bytes()).hexdigest(),
                  "fedComparisons": counts, "fedMismatches": mismatches,
                  "verifiedLargeMoves": confirmed["observations"], "checks": checks}))
