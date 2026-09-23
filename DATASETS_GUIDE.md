# RailSetu — Department Datasets Guide

This directory contains realistic, schema-validated Indian Railways CSV telemetry datasets for **RailSetu** along the **Secunderabad Junction (SC) — Bibinagar (BBN)** mainline corridor (South Central Railway).

All datasets are pre-validated to ingest with **0 errors**, auto-resolve linear track chainages, and feed both the **XGBoost Track Risk Model** and **GCN-LSTM Delay Prediction Model**.

---

## 📁 Generated Datasets Summary

| Dataset File | Department | Source System | Records | Key Telemetry Features | Downstream Effect |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **`civil_department_dataset.csv`** | **Civil** | `TMS` | 10 | `tqi`, `gmt`, `age_since_maint`, `temperature`, `defect_type` | Feeds **XGBoost Track Risk Model**, generates track maintenance tasks & priority blocks |
| **`signalling_department_dataset.csv`** | **Signalling** | `SMMS` | 120 | `delay_minutes`, `signal_aspect`, `axle_counter_status`, `interlocking_health` | Feeds **GCN-LSTM Delay Model** (full 24-step / 2-hour series for SC, MJF, AWL, GHKT, BBN) |
| **`electrical_department_dataset.csv`** | **Electrical** | `TDMS` | 9 | `mast_id` (SC-M-001…BBN-M-001), `contact_wire_wear_mm`, `catenary_tension_kg`, `stagger_mm` | Resolves via **Mast Chainage Map** (0.45 to 19.4 km), tracks OHE wear & power block needs |
| **`operating_department_dataset.csv`** | **Operating** | `COA` | 8 | `latitude`, `longitude`, `train_no`, `speed_kmph`, `loco_id` | Projects GPS fixes directly onto track centerline via **Shapely spatial projection** |
| **`railsetu_master_dataset.csv`** | **Multi-Dept Master** | Combined | 147 | All parameters above in a single unified corridor file | Bulk upload for complete end-to-end corridor demonstration |

---

## 🔑 Demo Department Accounts & Credentials

To test department-specific portals and role scoping, sign in with:

| Department | Email | Password | Allowed Access |
| :--- | :--- | :--- | :--- |
| **Civil** | `civil@railsetu.in` | `civil123` | Upload TMS track data, view Civil notifications & block letters |
| **Signalling** | `signalling@railsetu.in` | `signalling123` | Upload SMMS delay & signal data, view Signalling notifications |
| **Electrical** | `electrical@railsetu.in` | `electrical123` | Upload TDMS OHE data, view Electrical notifications & power blocks |
| **Section Controller** (Admin) | `admin@railsetu.in` | `admin123` | Master Scheduling, Gantt Chart, Conflict Resolution, Corridor Control |

---

## 🚀 How to Upload & Test

### Method 1: Using the Web Interface
1. Sign in to **RailSetu** at `http://localhost:5173/login` using either a Department account or Section Controller.
2. If logged in as a Department user, navigate to **Upload Data**.
3. Choose the corresponding CSV file (`civil_department_dataset.csv` for Civil, `signalling_department_dataset.csv` for Signalling, etc.).
4. Click **Upload and Ingest CSV**.
5. The records will immediately appear in **Recent Department Telemetry Records** with status `Processed` and chainage distances resolved in kilometres!

### Method 2: One-Click Master Telemetry Ingest (Section Controller)
1. Sign in as `admin@railsetu.in`.
2. Go to **Corridor Telemetry Records** / **Data Ingestion** or use `POST http://localhost:8000/ingest/csv` with `railsetu_master_dataset.csv`.
3. Go to **Overview** and click **Run Full Pipeline** (or trigger individual predictions on the **Track Risk** and **Delay Prediction** pages).
4. Both the **XGBoost Risk model** and **GCN-LSTM Delay model** will immediately calculate live predictions across the corridor!

---

## 🛠️ Automated Verification Script

To re-validate all datasets at any time, run:
```bash
python test_department_datasets_integration.py
```
This script tests:
1. Ingestion of each department dataset via the API
2. 0-error validation and chainage resolution
3. GCN-LSTM delay prediction execution on the signalling 12×5 matrix
4. XGBoost risk calculation from civil telemetry
5. Department authentication and role-scoped record access
