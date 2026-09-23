# RailSetu — Automatic Block Planning & Operational Optimization

Smart India Hackathon 2026 — SIH26027
Ministry of Railways, Government of India — Team CodeSmiths

## Overview

RailSetu is a complete 9-stage pipeline for railway infrastructure maintenance
management, built for South Central Railway (Secunderabad Division). Raw
telemetry from four source systems (TMS, SMMS, TDMS, COA) is ingested,
location-resolved to linear chainage markers, risk/delay predicted via
XGBoost and GCN-LSTM models, and optimally scheduled using CP-SAT constraint
programming with VNS bundling.

**Key capabilities:**
- **9-stage pipeline**: Ingestion → Chainage → Risk → Delay → Timetable → CP-SAT → VNS → Review → Monitoring
- **Two ML models**: XGBoost risk prediction with SHAP explainability; GCN-LSTM delay prediction
- **CP-SAT scheduling**: OR-Tools constraint solver with safety headways, crew shifts, and What-If sandbox
- **Two-role frontend**: Section Controller (admin) and Department views with JWT authentication
- **In-app notifications**: Department-scoped notification feed + SMTP email
- **Block sanction letters**: Auto-generated HTML letters for executed blocks
- **Disruption monitoring**: Rolling-horizon re-optimisation with configurable threshold

## Repository Layout

```
SIH26/
├── backend/                Python + FastAPI + SQLAlchemy backend
│   ├── main.py             FastAPI app (all 9 stages + auth + notifications)
│   ├── auth.py             JWT authentication & role-based authorization
│   ├── chainage.py         Shapely GPS → chainage conversion
│   ├── risk_model.py       XGBoost risk prediction + SHAP
│   ├── delay_model.py      GCN-LSTM delay prediction
│   ├── scheduler.py        CP-SAT optimization (Stage 5)
│   ├── bundler.py          VNS joint-block bundling (Stage 6)
│   ├── timetable_service.py  HAC clustering (Stage 4)
│   ├── notifications.py    Email + in-app notification service
│   ├── letters.py          Block sanction letter generator
│   ├── pipeline.py         Pipeline orchestrator (Stages 2→3a→3b)
│   ├── models.py           SQLAlchemy ORM models
│   ├── schemas.py          Pydantic request/response schemas
│   ├── database.py         Engine + session setup
│   ├── seed_users.py       Demo account provisioning
│   ├── services/           DB-driven ML service layer
│   ├── tests/              Pytest test suite
│   ├── models/             Trained model files
│   ├── requirements.txt    Python dependencies
│   └── docker-compose.yml  TimescaleDB container
└── frontend/               React 19 + TypeScript + Tailwind + Vite
    └── src/
        ├── api/client.ts   Typed API client with JWT support
        ├── contexts/       Auth context provider
        ├── pages/          Admin (8 pages) + Department (3 pages) + Login
        ├── components/     Shared UI components
        └── types/          TypeScript type definitions
```

## Quick Start

### Backend
```bash
cd backend
docker compose up -d              # TimescaleDB on :5432
pip install -r requirements.txt
uvicorn main:app --reload         # API on :8000
python seed_users.py              # Create demo accounts
# Swagger UI: http://localhost:8000/docs
```

### Frontend
```bash
cd frontend
npm install
npm run dev                       # Dashboard on :5173
```

### Demo Accounts
| Role | Email | Password |
|---|---|---|
| Section Controller (Admin) | admin@railsetu.in | admin123 |
| Civil Department | civil@railsetu.in | civil123 |
| Signalling Department | signalling@railsetu.in | signalling123 |
| Electrical Department | electrical@railsetu.in | electrical123 |

## Architecture

See [RAILFLOW_ARCHITECTURE.md](RAILFLOW_ARCHITECTURE.md) for the complete
system architecture, design decisions, and technical specifications.
