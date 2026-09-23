# RailSetu — Frontend

Operations dashboard for the RailSetu railway maintenance pipeline (Stages 1 & 2).

Built with: **Vite 5 + React 18 + TypeScript + Tailwind CSS 3**

## Setup

```bash
cd frontend
npm install
npm run dev        # starts dev server at http://localhost:5173
```

## Environment

By default the frontend expects the backend at `http://localhost:8000`.

To override:

```bash
cp .env.example .env.local
# edit VITE_API_BASE_URL in .env.local
```

## Backend requirement

The backend must be running before using the app:

```bash
cd ../backend
docker compose up -d          # start TimescaleDB
uvicorn main:app --reload     # start FastAPI on :8000
```

## Pages

| Page | URL path | What it does |
|---|---|---|
| Ingestion | `/` (default) | Submit records, view unprocessed queue |
| Chainage Mapping | click sidebar | Process batch, lookup tool, full records table |

## Folder structure

```
src/
├── api/           API client (typed fetch wrappers)
├── components/    Shared UI components
├── pages/         Page-level components
└── types/         TypeScript interfaces matching backend schemas.py
```
