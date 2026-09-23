"""
generate_department_datasets.py — Generates complete, fully populated datasets for RailSetu
where EVERY field (Location, ML Risk features, Delay features, and Electrical OHE features)
is 100% present and populated without missing values.

Features present in EVERY row across all datasets:
  - observation_time   : ISO-8601 timestamp at 5-minute increments
  - source_system      : TMS | SMMS | TDMS | COA
  - station_code       : Canonical station (SC, MJF, AWL, GHKT, BBN)
  - mast_id            : Canonical OHE mast (SC-M-001, MJF-M-001, etc.)
  - latitude           : Verified track centerline latitude
  - longitude          : Verified track centerline longitude
  - tqi                : Track Quality Index (48.0 - 86.5) -> XGBoost Track Risk
  - gmt                : Gross Million Tonnes (40.0 - 85.0) -> XGBoost Track Risk
  - age_since_maint    : Days since last maintenance (35 - 260) -> XGBoost Track Risk
  - temperature        : Ambient/rail temperature (28.5 - 42.0 °C) -> XGBoost Track Risk
  - delay_minutes      : Real-time station delay minutes (0.8 - 4.6 min) -> GCN-LSTM Delay
  - contact_wire_wear_mm: Contact wire wear (1.45 - 3.75 mm)
  - catenary_tension_kg: OHE catenary tension (920 - 1020 kg)
  - stagger_mm         : Contact wire stagger (200 - 235 mm)
  - voltage_kv         : Traction line voltage (24.8 - 25.2 kV)
  - track_condition    : Descriptive track health
  - defect_type        : Track defect categorization
  - signal_aspect      : Signalling aspect (GREEN, DOUBLE_YELLOW, YELLOW)
  - axle_counter_status: Track block occupancy (CLEAR, OCCUPIED)
"""

import csv
import os
from datetime import datetime, timedelta, timezone

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

STATIONS = ["SC", "MJF", "AWL", "GHKT", "BBN"]

# Canonical location, track geometry, and OHE asset mapping per station
STATION_PROFILES = {
    "SC": {
        "lat": 17.4344,
        "lon": 78.5013,
        "mast_id": "SC-M-001",
        "base_tqi": 52.0,
        "base_gmt": 42.0,
        "base_age": 35.0,
        "base_temp": 30.5,
        "base_delay": 2.3,
        "wear_mm": 1.45,
        "tension_kg": 1020,
        "stagger_mm": 200,
        "voltage_kv": 25.1,
        "track_condition": "Good - Baseline",
        "defect_type": "None",
    },
    "MJF": {
        "lat": 17.4553,
        "lon": 78.5301,
        "mast_id": "MJF-M-001",
        "base_tqi": 58.5,
        "base_gmt": 48.0,
        "base_age": 55.0,
        "base_temp": 31.5,
        "base_delay": 1.8,
        "wear_mm": 2.10,
        "tension_kg": 995,
        "stagger_mm": 210,
        "voltage_kv": 24.9,
        "track_condition": "Good - Normal Wear",
        "defect_type": "Minor Sleeper Edge Crack",
    },
    "AWL": {
        "lat": 17.4941,
        "lon": 78.5908,
        "mast_id": "AWL-M-001",
        "base_tqi": 68.0,
        "base_gmt": 64.0,
        "base_age": 125.0,
        "base_temp": 34.8,
        "base_delay": 3.2,
        "wear_mm": 2.70,
        "tension_kg": 970,
        "stagger_mm": 220,
        "voltage_kv": 24.7,
        "track_condition": "Fair - Moderate Wear",
        "defect_type": "Gauge Widening & Weld Fatigue",
    },
    "GHKT": {
        "lat": 17.5307,
        "lon": 78.6499,
        "mast_id": "GHKT-M-001",
        "base_tqi": 81.5,
        "base_gmt": 78.0,
        "base_age": 210.0,
        "base_temp": 39.0,
        "base_delay": 1.0,
        "wear_mm": 3.20,
        "tension_kg": 945,
        "stagger_mm": 228,
        "voltage_kv": 24.5,
        "track_condition": "High Risk - Degradation",
        "defect_type": "Rail Flange Wear & Corrugation",
    },
    "BBN": {
        "lat": 17.5505,
        "lon": 78.6830,
        "mast_id": "BBN-M-001",
        "base_tqi": 85.5,
        "base_gmt": 84.0,
        "base_age": 250.0,
        "base_temp": 41.5,
        "base_delay": 4.1,
        "wear_mm": 3.75,
        "tension_kg": 920,
        "stagger_mm": 235,
        "voltage_kv": 24.3,
        "track_condition": "Critical - Maintenance Block Required",
        "defect_type": "Severe Track Twist & Heavy Rail Wear",
    },
}

BASE_TIME = datetime(2026, 9, 23, 9, 0, 0, tzinfo=timezone.utc)
STEPS = 24  # 24 steps x 5 min = 2 continuous hours (120 rows per department)

CORE_FIELDNAMES = [
    "observation_time",
    "source_system",
    "station_code",
    "mast_id",
    "latitude",
    "longitude",
    "tqi",
    "gmt",
    "age_since_maint",
    "temperature",
    "delay_minutes",
    "contact_wire_wear_mm",
    "catenary_tension_kg",
    "stagger_mm",
    "voltage_kv",
    "track_condition",
    "defect_type",
    "signal_aspect",
    "axle_counter_status",
]

def build_complete_rows(source_system: str, num_steps: int = STEPS) -> list[dict]:
    """Builds complete rows where EVERY field is populated."""
    rows = []
    aspects = ["GREEN", "DOUBLE_YELLOW", "YELLOW", "GREEN", "GREEN", "DOUBLE_YELLOW", "GREEN", "GREEN", "YELLOW", "GREEN", "GREEN", "GREEN"]

    for step in range(num_steps):
        obs_time = (BASE_TIME + timedelta(minutes=step * 5)).isoformat()
        aspect = aspects[step % len(aspects)]

        for sc in STATIONS:
            prof = STATION_PROFILES[sc]

            # Dynamic realistic variations per time step
            temp_var = round(prof["base_temp"] + (step * 0.15) - (0.1 if step % 2 == 0 else 0), 1)
            tqi_var  = round(prof["base_tqi"] + (0.2 if step % 3 == 0 else -0.1), 1)
            gmt_var  = round(prof["base_gmt"] + (0.1 if step % 4 == 0 else 0), 1)
            delay_var = round(max(0.4, prof["base_delay"] + (0.3 if step % 5 == 0 else -0.2 if step % 3 == 0 else 0.1)), 2)
            age_var  = round(prof["base_age"] + (step * 0.05), 1)

            row = {
                "observation_time": obs_time,
                "source_system": source_system,
                "station_code": sc,
                "mast_id": prof["mast_id"],
                "latitude": f"{prof['lat']:.4f}",
                "longitude": f"{prof['lon']:.4f}",
                "tqi": f"{tqi_var:.1f}",
                "gmt": f"{gmt_var:.1f}",
                "age_since_maint": f"{age_var:.1f}",
                "temperature": f"{temp_var:.1f}",
                "delay_minutes": f"{delay_var:.2f}",
                "contact_wire_wear_mm": f"{prof['wear_mm']:.2f}",
                "catenary_tension_kg": f"{prof['tension_kg']}",
                "stagger_mm": f"{prof['stagger_mm']}",
                "voltage_kv": f"{prof['voltage_kv']:.2f}",
                "track_condition": prof["track_condition"],
                "defect_type": prof["defect_type"],
                "signal_aspect": aspect,
                "axle_counter_status": "OCCUPIED" if delay_var > 3.5 else "CLEAR",
            }
            rows.append(row)
    return rows

def generate_all_datasets():
    # 1. Civil Department (TMS) — 100% complete fields
    civil_rows = build_complete_rows("TMS", num_steps=STEPS)
    civil_path = os.path.join(OUTPUT_DIR, "civil_department_dataset.csv")
    with open(civil_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CORE_FIELDNAMES)
        writer.writeheader()
        writer.writerows(civil_rows)
    print(f"[OK] Generated Civil dataset (ALL fields present): {civil_path} ({len(civil_rows)} rows)")

    # 2. Signalling Department (SMMS) — 100% complete fields
    signalling_rows = build_complete_rows("SMMS", num_steps=STEPS)
    signalling_path = os.path.join(OUTPUT_DIR, "signalling_department_dataset.csv")
    with open(signalling_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CORE_FIELDNAMES)
        writer.writeheader()
        writer.writerows(signalling_rows)
    print(f"[OK] Generated Signalling dataset (ALL fields present): {signalling_path} ({len(signalling_rows)} rows)")

    # 3. Electrical Department (TDMS) — 100% complete fields
    electrical_rows = build_complete_rows("TDMS", num_steps=STEPS)
    electrical_path = os.path.join(OUTPUT_DIR, "electrical_department_dataset.csv")
    with open(electrical_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CORE_FIELDNAMES)
        writer.writeheader()
        writer.writerows(electrical_rows)
    print(f"[OK] Generated Electrical dataset (ALL fields present): {electrical_path} ({len(electrical_rows)} rows)")

    # 4. Operating Department (COA) — 100% complete fields
    operating_rows = build_complete_rows("COA", num_steps=STEPS)
    operating_path = os.path.join(OUTPUT_DIR, "operating_department_dataset.csv")
    with open(operating_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CORE_FIELDNAMES)
        writer.writeheader()
        writer.writerows(operating_rows)
    print(f"[OK] Generated Operating dataset (ALL fields present): {operating_path} ({len(operating_rows)} rows)")

    # 5. Master Corridor Dataset — Unified multi-department with ALL fields
    master_path = os.path.join(OUTPUT_DIR, "railsetu_master_dataset.csv")
    # Combine one complete sequence from each department
    master_rows = civil_rows + signalling_rows + electrical_rows + operating_rows
    with open(master_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CORE_FIELDNAMES)
        writer.writeheader()
        writer.writerows(master_rows)
    print(f"[OK] Generated Unified Master dataset (ALL fields present): {master_path} ({len(master_rows)} rows)")

if __name__ == "__main__":
    generate_all_datasets()
