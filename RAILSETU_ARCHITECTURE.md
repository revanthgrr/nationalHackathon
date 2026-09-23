# RailSetu — Complete System Architecture & Design Reference

**Problem Statement:** SIH26027 — Automatic Block Planning & Operational Optimization
**Target Organization:** Ministry of Railways, Government of India
**Team:** Team TrackForce — Smart India Hackathon 2026

This document is the single source of truth for RailSetu's architecture, design
decisions, and current build status. It's written to be understood by a human
teammate or an AI coding agent picking up the project with zero prior context.

---

## 1. What This System Does

Indian Railways' Civil, Signalling, and Electrical departments currently plan
track maintenance independently. Each department applies for a separate track
closure, even when their work is on the same stretch of track — multiplying
train delays and leaving expensive maintenance machinery idle while sections
wait for approval.

RailSetu unifies these into **Joint Integrated Blocks**: one coordinated
closure instead of three, scheduled automatically around real train traffic,
prioritized by predicted failure risk, and reviewed by a human controller
before anything goes live.

---

## 2. Tech Stack (Fixed)

| Layer | Choice |
|---|---|
| Backend | Python + FastAPI |
| ORM | SQLAlchemy |
| Database | PostgreSQL with the **TimescaleDB** extension enabled (one database — TimescaleDB is a Postgres extension, not a separate service) |
| Frontend | React + TypeScript + Tailwind CSS, built with Vite |
| Risk ML | XGBoost + scikit-learn |
| Delay ML | PyTorch (GCN-LSTM) |
| Optimization | Google OR-Tools — specifically the **CP-SAT** solver |
| Model training | **Google Colab** (not in the backend repo) — trained models are exported as files and loaded by the backend for serving only |
| Local infra | Docker Compose (Postgres+TimescaleDB image) |
| Repo layout | `backend/` and `frontend/` as sibling folders |

---

## 3. The Full Pipeline — All 9 Stages

Data flows top to bottom through these stages. Two of them (Risk and Delay
prediction) run in parallel on the same input before rejoining.

```
Railway data (TMS / SMMS / TDMS / COA)
        │
        ▼
[Stage 1] Data Ingestion Layer
        │
        ▼
[Stage 2] Location / Chainage Mapping
        │
        ├──────────────┬──────────────┐
        ▼              ▼
[Stage 3a]        [Stage 3b]
Risk Prediction    Delay Prediction
(XGBoost)          (GCN-LSTM)
        │              │
        └──────┬───────┘
               ▼
[Stage 4] Timetable Analysis (HAC clustering / dailyzing)
               ▼
[Stage 5] CP-SAT Optimization
               ▼
[Stage 6] Joint-Block Bundling (AFMS-VNS)
               ▼
[Stage 7] Field Section Controller (human review)
               ▼
[Stage 8] Accept schedule?
       ┌───────┴───────┐
      Yes              No
       │                │
       ▼                ▼
Schedule executed   Feedback (revised input)
       │                │
       ▼                └──► loops back to Stage 1
[Stage 9] Monitoring &
Rolling-Horizon Re-optimization
       │
       └──► on live disruption, loops back to Stage 5 only
            (not a full restart — completed blocks stay locked)
```

**The two feedback loops are structurally different — this matters:**
- **Reject loop** (Stage 8 "No" → Stage 1): human-triggered, restarts the
  *entire* pipeline with corrected input.
- **Monitoring loop** (Stage 9 → Stage 5): system-triggered, re-solves only
  the *not-yet-executed* portion of the schedule when a live disruption
  (e.g. a train running >15 min late) is detected. Already-executing or
  completed blocks are never touched.

---

## 4. Build Status

| Stage | Status | Notes |
|---|---|---|
| 1. Data Ingestion Layer | ✅ Built & verified | Per-source + CSV upload endpoints; TimescaleDB hypertable |
| 2. Location/Chainage Mapping | ✅ Built & verified | GPS→chainage via Shapely linear referencing; station/mast lookups |
| 3a. Risk Prediction (XGBoost) | ✅ Built & verified | `risk_model_2.json`; thresholds 0.3/0.7; SHAP explainability integrated |
| 3b. Delay Prediction (GCN-LSTM) | ✅ Built & verified | `delay_model.pt`; 12×5 window; `strict=True`; observation_time-aware |
| 4. Timetable Analysis (HAC) | ✅ Built & verified | HAC average-linkage, cosine-cube distance, τ=15min; dailyzing → windows |
| 5. CP-SAT Optimization | ✅ Built & verified | OR-Tools; no-overlap, headway, crew-shift constraints; What-If dry-run mode |
| 6. Joint-Block Bundling (VNS) | ✅ Built & verified | 3 move types; 500m proximity; union-find grouping |
| 7. Field Section Controller | ✅ Built & verified | Enriched blocks with risk/delay/SHAP; accept/reject with reasons |
| 8. Accept/Reject + feedback loop | ✅ Built & verified | Accept→executed+BDMS stub; reject→re-ingest to Stage 1 |
| 9. Monitoring & re-optimization | ✅ Built & verified | 15min threshold (configurable); re-optimizes only non-executed blocks |
| Authentication | ✅ Built | JWT HS256 + bcrypt; two roles: section_controller, department |
| Notifications | ✅ Built | SMTP email + in-app DB table; department-scoped feed |
| SHAP Explainability | ✅ Built | TreeExplainer on XGBoost; per-feature SHAP values via API |
| What-If Sandbox | ✅ Built | `POST /schedule/optimize/preview` — dry-run mode |
| Block Sanction Letters | ✅ Built | HTML letters generated from block/task state |
| Frontend (Admin) | ✅ Built | 8 pages: Overview, Ingestion, Chainage, Risk, Delay, Scheduling, Disruptions, Pipeline |
| Frontend (Department) | ✅ Built | 3 pages: Upload, Notifications, Letters |
| Pipeline Orchestrator | ✅ Built | `POST /pipeline/run` chains Stages 2→3a→3b |

---

## 5. Stages Built So Far — Full Detail

### 5.1 Stage 1 — Data Ingestion Layer

**Purpose:** Receive raw telemetry from 4 different source systems, normalize
into one consistent format, land it safely.

**Source systems:**
- **TMS** (Track Management System) — defect logs, Track Geometry Index (TQI)
- **SMMS** (Signalling Maintenance System) — point machine currents, relay voltage
- **TDMS** (Traction Distribution System) — OHE contact wire wear, arcing telemetry
- **COA** (Control Office Application) — live train GPS, timetables

**Key design decision — one unified table, not four:**
All source systems land in a single `raw_ingestion_records` table with a
`source_system` column, rather than separate tables per source. Each source
has completely different fields, so a flexible **JSONB `payload` column**
holds source-specific data instead of dozens of mostly-NULL columns.

**Schema (`raw_ingestion_records`):**
| Column | Type | Notes |
|---|---|---|
| id | BigInteger | autoincrement |
| source_system | String | TMS / SMMS / TDMS / COA |
| latitude, longitude | Float, nullable | one of 3 location types |
| station_code | String, nullable | one of 3 location types |
| mast_id | String, nullable | one of 3 location types |
| payload | JSONB | source-specific fields |
| chainage_km | Float, nullable | filled by Stage 2 |
| chainage_processed | Boolean, default False | flips True after Stage 2 |
| chainage_error | String, nullable | set if Stage 2 conversion failed |
| ingested_at | Timestamp, server default now() | **partition column** |

**Critical detail — composite primary key:** `(id, ingested_at)`, not `id`
alone. TimescaleDB requires the partitioning column to be part of the
primary key on any hypertable — a single-column `id` PK would make
`create_hypertable()` fail.

**Endpoints:**
- `POST /ingest/tms`, `/ingest/smms`, `/ingest/tdms`, `/ingest/coa` — each
  requires at least one location field (lat+lon together, OR station_code,
  OR mast_id); returns 400 on missing location, 201 on success.
- `GET /ingest/unprocessed` — returns records where `chainage_processed` is
  False. This is the hand-off point Stage 2 polls.

**Infra:** `docker-compose.yml` runs `timescale/timescaledb:latest-pg16`
(one image, Postgres 16 + TimescaleDB pre-installed). Startup lifecycle runs
`CREATE EXTENSION IF NOT EXISTS timescaledb` and `create_hypertable(...)`,
both idempotent — safe on every restart.

### 5.2 Stage 2 — Location / Chainage Mapping

**Purpose:** Convert each record's location (whichever of the 3 types is
present) into one unified **chainage_km** value — a linear kilometre-marker
position along the track — so records from different departments become
spatially comparable.

**Why this matters:** a rail fracture (Civil, reported via GPS), a relay
drift (Signalling, reported via station_code), and OHE wear (Electrical,
reported via mast_id) can only be recognized as "the same spot on the track"
once they're all expressed in the same coordinate system. This is the
prerequisite for joint-block bundling in Stage 6.

**Implementation (`chainage.py`):**
- **Reference track line:** a hardcoded ordered list of `(lat, lon,
  chainage_km)` points, ~20.75 km along the **SC→BBN corridor** (Hyderabad
  region, South Central Railway) — real coordinates, used as a placeholder
  for a full GIS track alignment dataset later.
- **GPS conversion:** builds a Shapely `LineString` from the reference
  points, uses `line.project(point)` to find the true foot-of-perpendicular
  projection onto the track (not a nearest-node snap or straight-line
  distance), then interpolates the chainage value within the correct
  segment.
- **Station/mast conversion:** two hardcoded lookup dicts (`STATION_CHAINAGE_MAP`,
  `MAST_CHAINAGE_MAP`) mapping known codes to chainage_km values.
- **Failure handling:** unknown codes or missing location data never crash
  the process — they return a clear reason string (`unknown_station_code`,
  `unknown_mast_id`, `no_location_data`), stored in the `chainage_error`
  column, and the record stays in the unprocessed queue for correction.

**Endpoints:**
- `POST /chainage/process` — processes all unprocessed records in a batch,
  with **per-record commits** (one bad record can't abort the whole batch).
  Returns `{"processed": N, "failed": M, "failures": [{"id", "reason"}, ...]}`.
- `GET /chainage/lookup?lat=&lon=` (or `station_code=` / `mast_id=`) —
  standalone conversion utility for testing/debugging without touching the DB.

**Verified test results:** GPS projection for a point near Alwal station
landed exactly on the reference waypoint (9.80 km), confirming the
interpolation is mathematically correct, not coincidental.

---

## 6. Stages Not Yet Built — Design Spec

### 6.1 Stage 3a — Risk Prediction (XGBoost)

- **Trained separately in Google Colab**, not in the backend repo. The
  backend only loads and serves the already-trained model.
- **Features (in this exact order):** `tqi`, `gmt`, `age_since_maint`, `temperature`
- **Output:** binary classifier — 14-day failure probability
- **Training data:** currently **synthetic** (no public dataset matches this
  exact tabular structure for Indian Railways) — generated via a rule-based
  probability function with noise. Open idea, not yet implemented: calibrate
  the synthetic failure-rate function against real published CAG audit
  statistics (26% of derailments linked to block deficits; 32%/30% machine
  idling rates) instead of arbitrary weights, to make the "synthetic but
  credible" story stronger for judges.
- **Export format:** XGBoost native JSON (`risk_model.json`), loaded via
  `xgb.Booster().load_model()`.
- **Serving plan:** load once at FastAPI startup (not per-request); `POST
  /predict/risk` returns failure probability + a derived risk_level
  (low/medium/high, thresholds at 0.3/0.7 — tunable placeholders); must
  return HTTP 503 gracefully if the model file isn't present, never crash
  the app.

### 6.2 Stage 3b — Delay Prediction (GCN-LSTM)

- Also trained separately in Colab (PyTorch), backend only serves it.
- **GCN half:** models the rail network as a graph (stations = nodes, track
  links = edges); each node aggregates info from spatial neighbors.
- **LSTM half:** takes the sequence of graph-embedded states over time,
  forecasts future delay/Expected Travel Time.
- **Export:** `torch.save(model.state_dict(), "delay_model.pt")` — the
  backend needs the *same model class definition* available to load the
  weights into.
- Target accuracy per reference material: ~19.5% MAPE (vs ~44% for
  legacy/non-network-aware methods).
- **Data reality:** much harder to source/synthesize convincingly than the
  risk model — needs actual network topology + historical delay
  propagation. If time-constrained, acceptable fallbacks (from least to
  most scoped-down): (a) full GCN-LSTM on a small synthetic graph, (b) plain
  LSTM on a linear station sequence (no graph modeling), (c) rule-based
  delay propagation as a stand-in, with GCN-LSTM presented as the target
  architecture.

### 6.3 Stage 4 — Timetable Analysis (HAC Clustering / "Dailyzing")

- **Purpose:** group non-daily trains that run at nearly the same time
  into one "virtual daily" slot, so the timetable compresses from a messy
  7-day pattern into one clean repeating daily pattern — exposing large,
  reliable maintenance windows ("white space") instead of scattered
  day-specific gaps.
- **Algorithm:** Hierarchical Agglomerative Clustering (HAC), **average
  linkage**, via scikit-learn's `AgglomerativeClustering`.
- **Similarity formula:**
  `SimilarityScore(i, j) = cos³( π × (Tᵢ − Tⱼ) / (2 × τ) )`
  where `τ` (tau) is the tolerance window, default **15 minutes**. Score is
  1 at zero time-gap, drops to 0 at the tolerance boundary; cubing the
  cosine sharpens the falloff for cleaner cluster boundaries. Only applied
  between trains sharing the same route.
- **Dailyzing** is the step *after* clustering: each cluster gets collapsed
  into one always-runs virtual train, and everything not covered by a
  virtual train becomes a candidate maintenance window passed to Stage 5.
  HAC clustering decides *what groups together*; dailyzing is *what you do*
  with those groups.

### 6.4 Stage 5 — CP-SAT Optimization

- **Library:** Google OR-Tools, `from ortools.sat.python import cp_model`
  (free, open-source, no API key — this is the correct/standard choice;
  alternatives like PuLP, Pyomo, Gurobi/CPLEX exist but CP-SAT fits
  discrete scheduling problems best and matches the reference blueprint).
- **Formulated as a MILP.** Decision variables: block start/end times, task
  assignments. Hard constraints: no train/maintenance overlap on the same
  chainage range, crew shift limits, safety headways, interlocking rules.
- **Objective:** minimize cumulative predicted train delay (from Stage 3b)
  while prioritizing high failure-risk tasks (from Stage 3a) — a weighted
  combination of both.
- **Nonlinear effects** (e.g. deteriorating maintenance time — delayed
  repairs take longer once finally done) are linearized via the **Big-M
  method** so the solver can handle them.
- Input: candidate windows from Stage 4. Output: exact scheduled blocks,
  solved typically in seconds even at meaningful scale.

### 6.5 Stage 6 — Joint-Block Bundling

- **Purpose:** take CP-SAT's schedule (still one closure per department by
  default) and nest co-located minor tasks inside a larger overlapping
  block, turning e.g. 3 separate closures into 1 coordinated closure.
- **Algorithm (full design):** Adaptive Feedback Multi-Start Variable
  Neighborhood Search (AFMS-VNS) — searches using three move types **Swap**,
  **Insert**, **SpeedChange**, with a Q-learning reinforcement agent
  choosing which move type to try based on Pareto-front density.
- **Hackathon-scoped simplification (as currently planned):** implement the
  VNS search with the three move types, but use a **fixed priority order**
  for choosing between them instead of a learned Q-agent — full RL-based
  operator selection is explicitly deferred as a stretch goal / future work,
  not core scope.
- Co-location detection uses the chainage_km values from Stage 2 — tasks
  within a configurable proximity (e.g. 500m) and overlapping time windows
  are candidates for nesting as "shadow blocks."

### 6.6 Stage 7 — Field Section Controller

- **Not an algorithm — the human checkpoint.** Nothing reaches execution
  without explicit approval here.
- **Backend:** `GET /schedule/pending` (current bundled schedule awaiting
  review), `POST /schedule/{id}/decision` (`accept` or `reject` + reason).
- **Frontend:** a Gantt-chart dashboard showing scheduled blocks vs. train
  paths, with a "What-If" sandbox to test adjustments before approving, and
  SHAP-based explainability showing *why* a task was prioritized (feature
  drivers: failure risk, overdue days, traffic impact) — so the controller
  isn't trusting a black box.

### 6.7 Stage 8 — Accept/Reject Decision Gate

- **Accept →** Schedule executed: logs/pushes the approved payload (BDMS
  API integration is stubbed/logged for the hackathon, not a real external
  integration), triggers a notification.
- **Reject →** Feedback (revised input): the rejection reason is captured
  and **re-inserted into Stage 1's `raw_ingestion_records` table** as a new
  record — a real pipeline restart, not just a status flag — so the full
  pipeline re-runs with the correction.

### 6.8 Stage 9 — Monitoring & Rolling-Horizon Re-optimization

- **Purpose:** handle live disruptions during execution (a train running
  late, a new critical defect) without restarting the whole pipeline.
- **Trigger:** delay > 15 minutes (configurable) or a new critical-priority
  defect — for the hackathon, simulated via a manual `POST
  /monitor/disruption` endpoint (no live sensor feed available).
- **Re-solve scope:** only Stage 5 (CP-SAT) re-runs, and only for
  **not-yet-executed** blocks. Already-executing/completed blocks are
  locked and never touched — this is what makes it a "rolling horizon"
  rather than a full restart.

### 6.9 Notifications

- On schedule execution and on re-optimization, send a notification.
- **Planned implementation:** email via Python's `smtplib`, credentials via
  environment variables (never hardcoded).
- **Structured for extension:** one notification-sending interface/function,
  so swapping in Twilio (SMS) or Firebase (push) later is a small,
  contained change — not scattered calls throughout the codebase.

---

## 7. Key Design Decisions & Rationale (Quick Reference)

| Decision | Why |
|---|---|
| One `raw_ingestion_records` table, not 4 | Each source has different fields; JSONB payload avoids either a sparse rigid schema or constant migrations |
| Composite PK `(id, ingested_at)` | Required by TimescaleDB — the partition column must be part of the primary key on a hypertable |
| Chainage mapping before anything else | Co-location detection (needed for joint-block bundling) is impossible without a shared spatial coordinate system first |
| Models trained in Colab, not the backend | Free GPU access; keeps training experimentation separate from production-serving code |
| Synthetic training data | No public dataset matches the required tabular structure for Indian Railways; standard, defensible practice when disclosed clearly |
| CP-SAT over PuLP/Gurobi/etc. | Free, no license friction, well-suited to discrete scheduling, matches what the reference blueprint specifies |
| Fixed priority order instead of Q-learning for bundling (for now) | Full RL-based operator selection is a legitimate stretch goal, not achievable in hackathon time — explicitly scoped down and documented as such |
| Two distinct feedback loops (reject vs. monitoring) | A rejected schedule needs a full pipeline restart with corrected input; a live disruption only needs the downstream schedule re-solved — conflating them would either be too slow (full restart on every hiccup) or unsafe (partial restart losing a human's correction) |
| Frontend: minimal, professional, light-themed | This is an internal operations tool for a railway authority, not a consumer product — should read as a clean admin dashboard, not a hackathon demo |

---

## 8. Repository Structure

```
/
├── README.md
├── backend/
│   ├── database.py       # Postgres+TimescaleDB connection/session setup
│   ├── models.py         # SQLAlchemy models (raw_ingestion_records, etc.)
│   ├── schemas.py        # Pydantic request/response schemas
│   ├── main.py           # FastAPI app, all route handlers, startup lifecycle
│   ├── chainage.py        # Stage 2 conversion logic (GPS/station/mast → chainage_km)
│   ├── risk_model.py      # (planned) Stage 3a XGBoost loading/serving logic
│   ├── models/            # Trained model files go here (risk_model.json, delay_model.pt)
│   │   └── README.md
│   ├── docker-compose.yml # Local Postgres+TimescaleDB
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── api/           # Typed API client functions
│   │   ├── components/
│   │   ├── pages/          # Ingestion, Chainage Mapping (more pages as stages are built)
│   │   └── types/
│   ├── package.json
│   └── README.md
└── notebooks/ (or wherever Colab notebooks are kept)
    └── railsetu_risk_model.ipynb
```

---

## 9. What "Uniqueness" Actually Means Here

CP-SAT, XGBoost, and PyTorch are all widely-used, commodity tools — that's
expected and fine. The actual differentiation is in **what problem they're
pointed at and how they're combined**:
1. **Joint-block bundling** — most systems solve one department's scheduling
   in isolation; RailSetu's core contribution is recognizing and solving the
   cross-department coordination problem.
2. **The constraint model itself** — encoding real operational rules (safety
   headways, deteriorating maintenance time, crew limits) into CP-SAT is the
   hard, valuable work; the solver itself is a blank tool until that's done.
3. **The upstream prediction pipeline** — CP-SAT solves a much better-informed
   problem because of chainage unification + dual ML prediction + dailyzing
   feeding into it, versus a naive "raw timetable → solver" approach.
4. **Rolling-horizon re-optimization** — most scheduling demos are one-shot;
   this system re-solves live without disturbing in-progress work.
5. **Human-in-the-loop with explainability** — SHAP-backed transparency
   directly addresses real-world adoption trust, not just algorithmic output.

---

*This document should be updated as each new stage is built and verified —
treat it as the living reference for both AI agents (Claude, Antigravity) and
human teammates picking up the project.*
