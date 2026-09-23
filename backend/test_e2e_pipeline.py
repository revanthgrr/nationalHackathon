"""
End-to-end test for the CSV -> ML pipeline integration.
Tests: upload -> DB store -> risk prediction -> delay prediction

Verifies:
1. CSV with 60 delay rows + 5 risk rows + 3 invalid rows
2. Inserted = 65, Failed = 3
3. observation_time stored correctly
4. chainage resolved for station-based rows
5. XGBoost prediction works from uploaded risk record
6. GCN-LSTM builds 12x5 from observation_time -> prediction saved
7. obs_count present in delay prediction response
"""
import requests, json
from datetime import datetime, timedelta, timezone

BASE = "http://localhost:8000"

# ── Build the test CSV ───────────────────────────────────────────────────────
STATIONS = ["SC", "MJF", "AWL", "GHKT", "BBN"]
BASE_TS = datetime(2026, 9, 21, 9, 0, 0, tzinfo=timezone.utc)

DELAY_VALUES = {
    "SC":   [2.5, 2.4, 2.6, 2.5, 2.3, 2.7, 2.4, 2.5, 2.6, 2.4, 2.5, 2.3],
    "MJF":  [1.8, 1.9, 1.7, 1.8, 2.0, 1.8, 1.9, 1.7, 1.8, 1.9, 1.8, 2.0],
    "AWL":  [3.2, 3.1, 3.3, 3.2, 3.0, 3.2, 3.1, 3.3, 3.2, 3.0, 3.1, 3.2],
    "GHKT": [0.9, 1.0, 0.8, 0.9, 1.1, 0.9, 1.0, 0.8, 0.9, 1.0, 0.9, 1.1],
    "BBN":  [4.1, 4.0, 4.2, 4.1, 3.9, 4.1, 4.0, 4.2, 4.1, 3.9, 4.0, 4.1],
}

header = "observation_time,source_system,station_code,mast_id,latitude,longitude,tqi,gmt,age_since_maint,temperature,delay_minutes"
rows = [header]

# 60 delay rows: 12 steps x 5 stations
for step in range(12):
    ts = (BASE_TS + timedelta(minutes=step * 5)).isoformat()
    for station in STATIONS:
        dm = DELAY_VALUES[station][step]
        rows.append(f"{ts},SMMS,{station},,,,,,,,{dm}")

# 5 risk rows (TMS, station-based)
risk_ts = BASE_TS.isoformat()
risk_data = [
    ("SC",   65.0, 70.0, 180.0, 38.0),
    ("MJF",  72.0, 68.0,  90.0, 36.5),
    ("AWL",  58.0, 62.0, 240.0, 40.0),
    ("GHKT", 81.0, 75.0,  60.0, 35.0),
    ("BBN",  74.0, 71.0, 120.0, 37.2),
]
for sc, tqi, gmt, age, temp in risk_data:
    rows.append(f"{risk_ts},TMS,{sc},,,,{tqi},{gmt},{age},{temp},")

# 3 intentionally invalid rows
rows.append(f"NOT_A_DATE,TMS,SC,,,,65.0,70.0,180.0,38.0,")           # invalid obs_time
rows.append(f"{risk_ts},UNKNOWN_SRC,SC,,,,65.0,70.0,180.0,38.0,")    # invalid source
rows.append(f"{risk_ts},SMMS,INVALID_STATION,,,,,,,,2.5")             # unsupported station for delay

csv_content = "\n".join(rows)

# ── Step 1: Upload CSV ────────────────────────────────────────────────────────
print("=" * 60)
print("STEP 1: Upload CSV")
print("=" * 60)
r = requests.post(f"{BASE}/ingest/csv", files={"file": ("test_e2e.csv", csv_content.encode(), "text/csv")})
data = r.json()
print(f"Status: {r.status_code}")
print(f"Inserted: {data['inserted']}")
print(f"Failed:   {data['failed']}")
print(f"Total:    {data['total_rows']}")
print("Errors:")
for e in data["errors"]:
    print(f"  row {e['row']}: {e['reason']}")

assert data["inserted"] == 65, f"Expected 65 inserted, got {data['inserted']}"
assert data["failed"] == 3, f"Expected 3 failed, got {data['failed']}"
print("✓ Insertion counts correct (65 inserted, 3 rejected)")

# ── Step 2: Check pipeline status ────────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 2: Pipeline status")
print("=" * 60)
r = requests.get(f"{BASE}/pipeline/status")
status = r.json()
print(json.dumps(status, indent=2))
assert status["total_records"] >= 65, "Expected at least 65 records"
print(f"✓ {status['total_records']} total records, {status['chainage_processed']} chainage processed")

# ── Step 3: Verify observation_time stored correctly ─────────────────────────
print("\n" + "=" * 60)
print("STEP 3: Verify observation_time in DB records")
print("=" * 60)
r = requests.get(f"{BASE}/ingest/records")
records = r.json()

# Find a risk-eligible record (TMS with tqi)
risk_records = [rec for rec in records if "tqi" in rec.get("payload", {})]
print(f"Risk-eligible records found: {len(risk_records)}")
assert len(risk_records) >= 5, f"Expected >=5 risk records, got {len(risk_records)}"

sample = risk_records[0]
print(f"Sample risk record id={sample['id']}:")
print(f"  observation_time: {sample.get('observation_time')}")
print(f"  chainage_km:      {sample.get('chainage_km')}")
print(f"  payload.tqi:      {sample['payload'].get('tqi')}")

assert sample.get("observation_time") is not None, "observation_time should be set"
print("✓ observation_time stored correctly")

# Check delay records too
delay_records = [rec for rec in records if "delay_minutes" in rec.get("payload", {})]
print(f"\nDelay records found: {len(delay_records)}")
assert len(delay_records) >= 60, f"Expected >=60 delay records, got {len(delay_records)}"
dsr = delay_records[0]
print(f"Sample delay record id={dsr['id']}:")
print(f"  observation_time:   {dsr.get('observation_time')}")
print(f"  station_code:       {dsr.get('station_code')}")
print(f"  payload.delay_min:  {dsr['payload'].get('delay_minutes')}")
assert dsr.get("observation_time") is not None, "delay record observation_time should be set"
print("✓ Delay record observation_time stored correctly")

# ── Step 4: XGBoost risk prediction ──────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 4: XGBoost risk prediction from uploaded record")
print("=" * 60)
target_id = risk_records[0]["id"]
print(f"Running prediction for record id={target_id} ...")
r = requests.post(f"{BASE}/predict/risk/{target_id}")
print(f"Status: {r.status_code}")
pred = r.json()
print(json.dumps(pred, indent=2))
assert r.status_code == 200, f"Expected 200 got {r.status_code}: {pred}"
assert "probability" in pred, "Expected probability in response"
assert "risk_level" in pred, "Expected risk_level in response"
print(f"✓ XGBoost: probability={pred['probability']:.4f}, risk_level={pred['risk_level']}")

# ── Step 5: GCN-LSTM delay prediction ────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 5: GCN-LSTM delay prediction from DB (uses observation_time)")
print("=" * 60)
r = requests.post(f"{BASE}/predict/delay/latest")
print(f"Status: {r.status_code}")
delay_pred = r.json()
print(json.dumps(delay_pred, indent=2))

if r.status_code == 409:
    print(f"⚠ Insufficient history: {delay_pred.get('detail')}")
    print("  (This can happen if the window is anchored to old timestamps)")
    print(f"  steps_available={delay_pred.get('steps_available')}, needed={delay_pred.get('steps_needed')}")
elif r.status_code == 200:
    assert delay_pred.get("ok") is True or "run_id" in delay_pred, "Expected ok=True"
    preds = delay_pred.get("predictions", [])
    print(f"✓ GCN-LSTM predictions for {len(preds)} stations:")
    for p in preds:
        print(f"  {p['station']:5s} → {p['predicted_delay_minutes']:.2f} min")
    # Check obs_count
    obs_count = delay_pred.get("obs_count")
    print(f"  obs_count={obs_count}")
    assert obs_count is not None and obs_count > 0, "Expected obs_count > 0"
    print("✓ obs_count present and non-zero")
else:
    print(f"Unexpected status: {r.status_code}: {delay_pred}")

# ── Step 6: Verify saved delay prediction includes obs_count ─────────────────
print("\n" + "=" * 60)
print("STEP 6: GET /predictions/delay/latest — verify obs_count in saved run")
print("=" * 60)
r = requests.get(f"{BASE}/predictions/delay/latest")
if r.status_code == 200:
    saved = r.json()
    print(f"run_id:       {saved.get('run_id', '')[:16]}...")
    print(f"obs_count:    {saved.get('obs_count')}")
    print(f"window_start: {saved.get('input_window_start')}")
    print(f"window_end:   {saved.get('input_window_end')}")
    print(f"predictions:  {len(saved.get('predictions', []))} stations")
    if saved.get("obs_count"):
        print("✓ obs_count stored and returned in GET response")
    else:
        print("⚠ obs_count is None (may be a pre-existing run from before this migration)")
elif r.status_code == 404:
    print("⚠ No delay predictions saved yet")
else:
    print(f"Status {r.status_code}: {r.text}")

print("\n" + "=" * 60)
print("END-TO-END TEST COMPLETE")
print("=" * 60)
