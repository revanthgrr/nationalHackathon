/**
 * api/client.ts — Typed wrapper around the RailSetu backend API.
 *
 * Base URL is read from VITE_API_BASE_URL environment variable,
 * defaulting to http://localhost:8000.
 */

import type {
  BlockDecisionRequest,
  BundleRequest,
  BundleResponse,
  ChainageLookupResponse,
  ChainageProcessResponse,
  DelayPredictionRequest,
  DelayPredictionResponse,
  DelayPredictionRunResponse,
  DisruptionEventResponse,
  DisruptionRequest,
  DisruptionResponse,
  EnrichedBlockResponse,
  EnrichedBlockWithShap,
  IngestionRecord,
  IngestRequest,
  LetterInfo,
  LoginRequest,
  LoginResponse,
  MaintenanceTaskRequest,
  MaintenanceTaskResponse,
  MaintenanceWindowResponse,
  NotificationItem,
  PipelineRunResponse,
  PipelineStatusResponse,
  RiskPredictionByRecordResponse,
  RiskPredictionRecord,
  RiskPredictionRequest,
  RiskPredictionResponse,
  ScheduledBlockResponse,
  ScheduleOptimizeRequest,
  ScheduleOptimizeResponse,
  SchedulePreviewResponse,
  ShapExplanation,
  SourceSystem,
  TimetableAnalyzeRequest,
  TimetableAnalyzeResponse,
  TrainRunRequest,
  TrainRunResponse,
  UserProfile,
} from '../types/api';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000';

// ---------------------------------------------------------------------------
// Auth token management
// ---------------------------------------------------------------------------

let _authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  _authToken = token;
  if (token) {
    localStorage.setItem('railsetu_token', token);
  } else {
    localStorage.removeItem('railsetu_token');
  }
}

export function getAuthToken(): string | null {
  if (_authToken) return _authToken;
  _authToken = localStorage.getItem('railsetu_token');
  return _authToken;
}

export function clearAuthToken(): void {
  _authToken = null;
  localStorage.removeItem('railsetu_token');
  localStorage.removeItem('railsetu_user');
}

// ---------------------------------------------------------------------------
// Internal fetch helper — always throws an enriched Error on non-2xx
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch (err) {
    throw new Error('Cannot reach the backend. Is the server running on ' + BASE_URL + '?');
  }

  if (!res.ok) {
    let detail: string = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? body?.error ?? JSON.stringify(body);
    } catch {
      detail = res.statusText || detail;
    }
    throw new Error(detail);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Ingestion endpoints
// ---------------------------------------------------------------------------

/** POST /ingest/{source} — ingest a single record */
export function postIngest(source: SourceSystem, data: IngestRequest): Promise<IngestionRecord> {
  return apiFetch<IngestionRecord>(`/ingest/${source}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** GET /ingest/unprocessed — records where chainage_processed = false */
export function getUnprocessed(): Promise<IngestionRecord[]> {
  return apiFetch<IngestionRecord[]>('/ingest/unprocessed');
}

/** GET /ingest/records — ALL records (processed + unprocessed), newest first */
export function getAllRecords(): Promise<IngestionRecord[]> {
  return apiFetch<IngestionRecord[]>('/ingest/records');
}

// ---------------------------------------------------------------------------
// Chainage endpoints
// ---------------------------------------------------------------------------

/** POST /chainage/process — batch-resolve chainage_km for all unprocessed records */
export function postChainageProcess(): Promise<ChainageProcessResponse> {
  return apiFetch<ChainageProcessResponse>('/chainage/process', { method: 'POST' });
}

export interface LookupParams {
  lat?: number;
  lon?: number;
  station_code?: string;
  mast_id?: string;
}

/** GET /chainage/lookup — ad-hoc single-location chainage resolution */
export function getChainageLookup(params: LookupParams): Promise<ChainageLookupResponse> {
  const qs = new URLSearchParams();
  if (params.lat     != null) qs.set('lat', String(params.lat));
  if (params.lon     != null) qs.set('lon', String(params.lon));
  if (params.station_code)    qs.set('station_code', params.station_code);
  if (params.mast_id)         qs.set('mast_id', params.mast_id);
  return apiFetch<ChainageLookupResponse>(`/chainage/lookup?${qs.toString()}`);
}

// ---------------------------------------------------------------------------
// Stage 3 — manual / test prediction endpoints (no DB linkage)
// ---------------------------------------------------------------------------

/** POST /predict/risk — manual XGBoost test (4 typed inputs) */
export function postRiskPrediction(req: RiskPredictionRequest): Promise<RiskPredictionResponse> {
  return apiFetch<RiskPredictionResponse>('/predict/risk', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** POST /predict/delay — manual GCN-LSTM test (12×5 grid) */
export function postDelayPrediction(req: DelayPredictionRequest): Promise<DelayPredictionResponse> {
  return apiFetch<DelayPredictionResponse>('/predict/delay', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

// ---------------------------------------------------------------------------
// Stage 3a — DB-backed risk prediction
// ---------------------------------------------------------------------------

/** POST /predict/risk/{record_id} — run XGBoost on a stored DB record */
export function postRiskForRecord(recordId: number): Promise<RiskPredictionByRecordResponse> {
  return apiFetch<RiskPredictionByRecordResponse>(`/predict/risk/${recordId}`, {
    method: 'POST',
  });
}

/** GET /predictions/risk — list all saved risk predictions */
export function getRiskPredictions(limit = 100, skip = 0): Promise<RiskPredictionRecord[]> {
  return apiFetch<RiskPredictionRecord[]>(`/predictions/risk?limit=${limit}&skip=${skip}`);
}

/** GET /predictions/risk/by-record/{record_id} — predictions for one ingestion record */
export function getRiskPredictionsForRecord(recordId: number): Promise<RiskPredictionRecord[]> {
  return apiFetch<RiskPredictionRecord[]>(`/predictions/risk/by-record/${recordId}`);
}


// ---------------------------------------------------------------------------
// Stage 3b — DB-backed delay prediction
// ---------------------------------------------------------------------------

/** POST /predict/delay/latest — build 12×5 from DB, run GCN-LSTM, persist */
export async function postDelayFromDB(): Promise<DelayPredictionRunResponse | { error: 'insufficient_history'; detail: string; steps_available: number; steps_needed: number }> {
  const res = await fetch(`${BASE_URL}/predict/delay/latest`, { method: 'POST' });
  if (res.status === 409) {
    // Structured insufficient_history response
    const body = await res.json();
    return { error: 'insufficient_history', ...body };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** GET /predictions/delay/latest — most recent saved delay run */
export async function getDelayLatest(): Promise<DelayPredictionRunResponse | null> {
  const res = await fetch(`${BASE_URL}/predictions/delay/latest`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** GET /predictions/delay — list recent delay runs */
export function getDelayPredictions(limit = 20): Promise<DelayPredictionRunResponse[]> {
  return apiFetch<DelayPredictionRunResponse[]>(`/predictions/delay?limit=${limit}`);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** GET /pipeline/status — live counts from all pipeline tables */
export function getPipelineStatus(): Promise<PipelineStatusResponse> {
  return apiFetch<PipelineStatusResponse>('/pipeline/status');
}

/** POST /pipeline/run — Stage 2 → 3a → 3b orchestration */
export function postPipelineRun(): Promise<PipelineRunResponse> {
  return apiFetch<PipelineRunResponse>('/pipeline/run', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Delete / Reset
// ---------------------------------------------------------------------------

/** DELETE /ingest/records/{id} — delete one ingestion record + its risk predictions */
export function deleteRecord(recordId: number): Promise<{ deleted: boolean; record_id: number }> {
  return apiFetch(`/ingest/records/${recordId}`, { method: 'DELETE' });
}

/** DELETE /admin/reset — wipe all data from every pipeline table */
export function resetAllData(): Promise<{
  deleted: {
    raw_ingestion_records: number;
    risk_predictions: number;
    delay_predictions: number;
    scheduled_blocks?: number;
    maintenance_tasks?: number;
    disruption_events?: number;
    notifications?: number;
  };
}> {
  return apiFetch('/admin/reset', { method: 'DELETE' });
}

/** DELETE /schedule/reset — wipe all scheduled blocks, tasks, disruptions, and notifications */
export function resetScheduleData(): Promise<{
  deleted: {
    scheduled_blocks: number;
    maintenance_tasks: number;
    disruption_events: number;
    notifications: number;
  };
}> {
  return apiFetch('/schedule/reset', { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// CSV Upload
// ---------------------------------------------------------------------------

export interface CsvUploadResult {
  inserted: number;
  failed: number;
  total_rows: number;
  filename: string;
  errors: Array<{ row: number; reason: string }>;
}

/** POST /ingest/csv — upload a CSV file and bulk-insert all valid rows */
export async function uploadCSV(file: File): Promise<CsvUploadResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE_URL}/ingest/csv`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Stage 4 — Timetable Analysis
// ---------------------------------------------------------------------------

/** POST /timetable/trains — store a train run schedule entry */
export function postTrainRun(req: TrainRunRequest): Promise<TrainRunResponse> {
  return apiFetch<TrainRunResponse>('/timetable/trains', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** GET /timetable/trains — list all stored train runs */
export function getTrainRuns(): Promise<TrainRunResponse[]> {
  return apiFetch<TrainRunResponse[]>('/timetable/trains');
}

/** POST /timetable/analyze — cluster train runs and compute maintenance windows */
export function postTimetableAnalyze(req?: TimetableAnalyzeRequest): Promise<TimetableAnalyzeResponse> {
  return apiFetch<TimetableAnalyzeResponse>('/timetable/analyze', {
    method: 'POST',
    body: JSON.stringify(req ?? {}),
  });
}

/** GET /timetable/windows — list all computed maintenance windows */
export function getTimetableWindows(): Promise<MaintenanceWindowResponse[]> {
  return apiFetch<MaintenanceWindowResponse[]>('/timetable/windows');
}

// ---------------------------------------------------------------------------
// Stage 5 — Maintenance Tasks and CP-SAT Scheduling
// ---------------------------------------------------------------------------

/** POST /tasks — create a maintenance task */
export function postMaintenanceTask(req: MaintenanceTaskRequest): Promise<MaintenanceTaskResponse> {
  return apiFetch<MaintenanceTaskResponse>('/tasks', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** GET /tasks — list maintenance tasks, optionally filtered by status */
export function getMaintenanceTasks(status?: string): Promise<MaintenanceTaskResponse[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<MaintenanceTaskResponse[]>(`/tasks${qs}`);
}

/** POST /schedule/optimize — run CP-SAT optimisation */
export function postScheduleOptimize(req?: ScheduleOptimizeRequest): Promise<ScheduleOptimizeResponse> {
  return apiFetch<ScheduleOptimizeResponse>('/schedule/optimize', {
    method: 'POST',
    body: JSON.stringify(req ?? {}),
  });
}

/** GET /schedule/blocks — list all scheduled blocks */
export function getScheduledBlocks(): Promise<ScheduledBlockResponse[]> {
  return apiFetch<ScheduledBlockResponse[]>('/schedule/blocks');
}

// ---------------------------------------------------------------------------
// Stage 6 — VNS Joint-Block Bundling
// ---------------------------------------------------------------------------

/** POST /schedule/bundle — bundle proximate scheduled blocks */
export function postScheduleBundle(req?: BundleRequest): Promise<BundleResponse> {
  return apiFetch<BundleResponse>('/schedule/bundle', {
    method: 'POST',
    body: JSON.stringify(req ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Stage 7 — Field Controller Review
// ---------------------------------------------------------------------------

/** GET /schedule/pending — enriched list of pending/bundled blocks */
export function getPendingBlocks(): Promise<EnrichedBlockResponse[]> {
  return apiFetch<EnrichedBlockResponse[]>('/schedule/pending');
}

/** POST /schedule/{id}/decision — accept or reject a block */
export function postBlockDecision(blockId: number, req: BlockDecisionRequest): Promise<ScheduledBlockResponse> {
  return apiFetch<ScheduledBlockResponse>(`/schedule/${blockId}/decision`, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

// ---------------------------------------------------------------------------
// Stage 9 — Disruption Monitoring
// ---------------------------------------------------------------------------

/** POST /monitor/disruption — report a disruption event */
export function postDisruption(req: DisruptionRequest): Promise<DisruptionResponse> {
  return apiFetch<DisruptionResponse>('/monitor/disruption', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** GET /monitor/disruptions — list all disruption events */
export function getDisruptions(): Promise<DisruptionEventResponse[]> {
  return apiFetch<DisruptionEventResponse[]>('/monitor/disruptions');
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** POST /auth/login — authenticate and receive JWT */
export function login(req: LoginRequest): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** GET /auth/me — get current user profile */
export function getMe(): Promise<UserProfile> {
  return apiFetch<UserProfile>('/auth/me');
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** GET /notifications — list notifications (role-scoped) */
export function getNotifications(unreadOnly = false): Promise<NotificationItem[]> {
  const params = unreadOnly ? '?unread_only=true' : '';
  return apiFetch<NotificationItem[]>(`/notifications${params}`);
}

/** POST /notifications/{id}/read — mark notification as read */
export function markNotificationRead(id: number): Promise<NotificationItem> {
  return apiFetch<NotificationItem>(`/notifications/${id}/read`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// SHAP Explainability
// ---------------------------------------------------------------------------

/** GET /predict/risk/{id}/shap — SHAP explanation for a risk prediction */
export function getRiskShap(predictionId: number): Promise<ShapExplanation> {
  return apiFetch<ShapExplanation>(`/predict/risk/${predictionId}/shap`);
}

/** POST /predict/risk-shap — compute real-time SHAP for arbitrary feature vector */
export function computeRiskShap(req: RiskPredictionRequest): Promise<ShapExplanation> {
  return apiFetch<ShapExplanation>('/predict/risk-shap', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

/** GET /schedule/pending/enriched — blocks with SHAP */
export function getPendingBlocksWithShap(): Promise<EnrichedBlockWithShap[]> {
  return apiFetch<EnrichedBlockWithShap[]>('/schedule/pending/enriched');
}

// ---------------------------------------------------------------------------
// What-If Preview
// ---------------------------------------------------------------------------

/** POST /schedule/optimize/preview — dry-run schedule preview */
export function postSchedulePreview(req?: ScheduleOptimizeRequest): Promise<SchedulePreviewResponse> {
  return apiFetch<SchedulePreviewResponse>('/schedule/optimize/preview', {
    method: 'POST',
    body: JSON.stringify(req ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

/** GET /department/letters — list available letters */
export function getLetters(): Promise<LetterInfo[]> {
  return apiFetch<LetterInfo[]>('/department/letters');
}

/** Get the URL for a letter download (opens in browser) */
export function getLetterUrl(blockId: number): string {
  return `${BASE_URL}/department/letters/${blockId}`;
}

// ---------------------------------------------------------------------------
// Department
// ---------------------------------------------------------------------------

/** GET /department/uploads — list department-scoped uploads */
export function getDepartmentUploads(): Promise<IngestionRecord[]> {
  return apiFetch<IngestionRecord[]>('/department/uploads');
}
