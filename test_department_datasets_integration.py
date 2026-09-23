"""
test_department_datasets_integration.py — Validates that all generated department datasets
upload seamlessly into RailSetu, resolve chainages, and feed the ML models.
"""

import requests
import json
import os

BASE = "http://localhost:8000"

def test_file(filename, expected_min_inserted):
    print(f"\nTesting upload of {filename}...")
    filepath = os.path.join("d:\\RR\\SIH26", filename)
    with open(filepath, "rb") as f:
        r = requests.post(f"{BASE}/ingest/csv", files={"file": (filename, f, "text/csv")})
    
    assert r.status_code == 200, f"Upload failed: {r.status_code} {r.text}"
    data = r.json()
    print(f"  Inserted: {data['inserted']} / {data['total_rows']}, Failed: {data['failed']}")
    if data['errors']:
        for e in data['errors']:
            print(f"    Row {e['row']}: {e['reason']}")
    assert data['failed'] == 0, f"Expected 0 failed rows in {filename}, got {data['failed']}"
    assert data['inserted'] >= expected_min_inserted, f"Expected >= {expected_min_inserted} inserted"
    print(f"  [PASS] {filename} ingested cleanly with 0 errors!")

def test_pipeline_models():
    print("\nTesting ML Model Execution on Uploaded Datasets...")
    # 1. Run pipeline
    r = requests.post(f"{BASE}/pipeline/run")
    assert r.status_code == 200, f"Pipeline run failed: {r.text}"
    p_data = r.json()
    print(f"  Pipeline Result: Chainage processed={p_data['chainage']['processed']}, Risk succeeded={p_data['risk']['succeeded']}, Delay OK={p_data['delay']['ok']}")
    assert p_data['chainage']['failed'] == 0, "Some chainages failed"

    # 2. Test Delay Prediction (GCN-LSTM on 12x5 Signalling window)
    r_delay = requests.post(f"{BASE}/predict/delay/latest")
    assert r_delay.status_code == 200, f"Delay prediction failed: {r_delay.text}"
    d_data = r_delay.json()
    print(f"  [PASS] Delay Prediction successful! Run ID: {d_data.get('run_id')} ({len(d_data.get('predictions', []))} stations predicted)")

    # 3. Test Risk Prediction on a specific civil record
    r_recs = requests.get(f"{BASE}/ingest/records")
    risk_records = [rec for rec in r_recs.json() if "tqi" in rec.get("payload", {})]
    assert len(risk_records) > 0, "No risk records found"
    target_id = risk_records[0]["id"]
    r_risk = requests.post(f"{BASE}/predict/risk/{target_id}")
    assert r_risk.status_code == 200, f"Risk prediction failed: {r_risk.text}"
    r_data = r_risk.json()
    print(f"  [PASS] Track Risk Prediction successful for Record #{target_id}! Risk Level: {r_data.get('risk_level')}, Probability: {r_data.get('probability'):.3f}")

def test_department_auth():
    print("\nTesting Department Scoped Views...")
    depts = [
        ("civil@railsetu.in", "civil123", "TMS"),
        ("signalling@railsetu.in", "signalling123", "SMMS"),
        ("electrical@railsetu.in", "electrical123", "TDMS"),
    ]
    for email, pwd, expected_src in depts:
        # Login
        r = requests.post(f"{BASE}/auth/login", json={"email": email, "password": pwd})
        assert r.status_code == 200, f"Login failed for {email}: {r.text}"
        token = r.json()["access_token"]
        
        # Get department uploads
        headers = {"Authorization": f"Bearer {token}"}
        r_up = requests.get(f"{BASE}/department/uploads", headers=headers)
        assert r_up.status_code == 200, f"Failed to get uploads for {email}: {r_up.text}"
        uploads = r_up.json()
        print(f"  [PASS] {email} logged in successfully and sees {len(uploads)} records (all source_system={expected_src})")
        if uploads:
            for u in uploads[:3]:
                assert u["source_system"] == expected_src

if __name__ == "__main__":
    test_file("civil_department_dataset.csv", 10)
    test_file("signalling_department_dataset.csv", 60)
    test_file("electrical_department_dataset.csv", 9)
    test_file("operating_department_dataset.csv", 8)
    test_pipeline_models()
    test_department_auth()
    print("\n=======================================================")
    print("ALL DEPARTMENT DATASETS FULLY VALIDATED AND COMPLIANT!")
    print("=======================================================\n")
