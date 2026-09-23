// Types derived directly from backend/schemas.py

export interface IngestRequest {
  latitude?: number | null;
  longitude?: number | null;
  station_code?: string | null;
  mast_id?: string | null;
  payload: Record<string, unknown>;
}

/** Matches both IngestResponse and UnprocessedRecord from schemas.py */
export interface IngestionRecord {
  id: number;
  source_system: string;
  ingested_at: string;              // ISO datetime — when DB received the record
  observation_time: string | null;  // ISO datetime — when the telemetry occurred
  latitude: number | null;
  longitude: number | null;
  station_code: string | null;
  mast_id: string | null;
  chainage_km: number | null;
  chainage_error: string | null;
  chainage_processed: boolean;
  payload: Record<string, unknown>;
}

export interface ChainageFailure {
  id: number;
  reason: string;
}

export interface ChainageProcessResponse {
  processed: number;
  failed: number;
  failures: ChainageFailure[];
}

export interface ChainageLookupResponse {
  chainage_km: number | null;
  source: string;   // "gps" | "station_code" | "mast_id"
  error: string | null;
}

export interface HealthResponse {
  status: string;
  database: string;
}

export type SourceSystem = 'tms' | 'smms' | 'tdms' | 'coa';
export type LocationType = 'gps' | 'station' | 'mast';

// ---------------------------------------------------------------------------
// Stage 3a — XGBoost Risk Prediction (manual/test)
// ---------------------------------------------------------------------------

export interface RiskPredictionRequest {
  tqi: number;
  gmt: number;
  age_since_maint: number;
  temperature: number;
}

export interface RiskPredictionResponse {
  probability: number;
  risk_level: 'low' | 'medium' | 'high';
  model_available: boolean;
}

// DB-backed risk prediction (linked to a stored record)
export interface RiskPredictionByRecordResponse {
  prediction_id: number;
  record_id: number;
  tqi: number;
  gmt: number;
  age_since_maint: number;
  temperature: number;
  probability: number;
  risk_level: 'low' | 'medium' | 'high';
  predicted_at: string;
  model_version: string;
}

export interface RiskPredictionRecord {
  id: number;
  record_id: number;
  tqi: number;
  gmt: number;
  age_since_maint: number;
  temperature: number;
  probability: number;
  risk_level: 'low' | 'medium' | 'high';
  predicted_at: string;
  model_version: string;
}

export interface ShapExplanation {
  base_value: number;
  shap_values: Record<string, number>;
  feature_values: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Stage 3b — GCN-LSTM Delay Prediction (manual/test)
// ---------------------------------------------------------------------------

export interface DelayPredictionRequest {
  sequence: number[][];
}

export interface StationDelay {
  station: string;
  predicted_delay_minutes: number;
}

export interface DelayPredictionResponse {
  predictions: StationDelay[];
  model_available: boolean;
}

// DB-backed delay prediction run (grouped result)
export interface DelayPredictionRunResponse {
  run_id: string;
  predicted_at: string;
  input_window_start: string | null;
  input_window_end: string | null;
  obs_count: number | null;   // qualifying observations used to build 12×5 matrix
  predictions: StationDelay[];
}

export interface InsufficientHistoryError {
  reason: 'insufficient_history';
  detail: string;
  steps_available: number;
  steps_needed: number;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineStatusResponse {
  total_records: number;
  chainage_processed: number;
  chainage_failed: number;
  risk_predictions: number;
  delay_runs: number;
  high_risk: number;
  medium_risk: number;
  low_risk: number;
  // Stage 4-9 counts
  train_runs: number;
  maintenance_windows: number;
  pending_tasks: number;
  scheduled_blocks: number;
  executed_blocks: number;
  disruption_events: number;
}

export interface PipelineRunResponse {
  chainage: {
    processed: number;
    failed: number;
    failures: Array<{ id: number; reason: string }>;
  };
  risk: {
    attempted: number;
    succeeded: number;
    skipped_ineligible: number;
    failed: number;
    details: Array<Record<string, unknown>>;
  };
  delay: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stage 4 — Timetable Analysis
// ---------------------------------------------------------------------------

export interface TrainRunRequest {
  route: string;
  scheduled_time: string;  // HH:MM:SS
  day_of_week: number;     // 0=Mon ... 6=Sun
  is_daily?: boolean;
}

export interface TrainRunResponse {
  id: number;
  route: string;
  scheduled_time: string;
  day_of_week: number;
  is_daily: boolean;
  created_at: string;
}

export interface MaintenanceWindowResponse {
  id: number;
  window_start: string;
  window_end: string;
  chainage_range_start: number;
  chainage_range_end: number;
  source_run_id: number | null;
  created_at: string;
}

export interface TimetableAnalyzeRequest {
  tau_minutes?: number;
  min_window_minutes?: number;
}

export interface TimetableAnalyzeResponse {
  clusters_found: number;
  virtual_slots: string[];
  windows_saved: number;
  windows: MaintenanceWindowResponse[];
}

// ---------------------------------------------------------------------------
// Stage 5 — Maintenance Tasks and Scheduling
// ---------------------------------------------------------------------------

export interface MaintenanceTaskRequest {
  chainage_km: number;
  department: 'Civil' | 'Signalling' | 'Electrical';
  estimated_duration_minutes: number;
  priority_weight?: number | null;
}

export interface MaintenanceTaskResponse {
  id: number;
  chainage_km: number;
  department: string;
  estimated_duration_minutes: number;
  priority_weight: number | null;
  status: string;
  created_at: string;
}

export interface ScheduledBlockResponse {
  id: number;
  task_id: number;
  chainage_km: number;
  start_time: string;
  end_time: string;
  status: string;
  parent_block_id: number | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface EnrichedBlockResponse extends ScheduledBlockResponse {
  task: MaintenanceTaskResponse;
  high_risk_nearby: number;
  latest_delay_minutes: number | null;
}

export interface ScheduleOptimizeRequest {
  safety_headway_minutes?: number;
  max_crew_shift_hours?: number;
}

export interface ScheduleOptimizeResponse {
  tasks_scheduled: number;
  tasks_unscheduled: number;
  blocks_created: number;
  blocks: ScheduledBlockResponse[];
}

// ---------------------------------------------------------------------------
// Stage 6 — VNS Bundling
// ---------------------------------------------------------------------------

export interface BundleRequest {
  proximity_threshold_m?: number;
  safety_headway_minutes?: number;
}

export interface BundleResponse {
  bundles_created: number;
  blocks_bundled: number;
  blocks_unchanged: number;
  bundle_groups: Array<{ parent_id: number; child_ids: number[] }>;
}

// ---------------------------------------------------------------------------
// Stage 7 — Field Controller Review
// ---------------------------------------------------------------------------

export interface BlockDecisionRequest {
  decision: 'accept' | 'reject';
  reason?: string;
}

// ---------------------------------------------------------------------------
// Stage 9 — Disruption Monitoring
// ---------------------------------------------------------------------------

export interface DisruptionRequest {
  delay_minutes: number;
  affected_chainage_km: number;
}

export interface DisruptionEventResponse {
  id: number;
  delay_minutes: number;
  affected_chainage_km: number;
  received_at: string;
  triggered_reoptimization: boolean;
}

export interface DisruptionResponse extends DisruptionEventResponse {
  reoptimized: boolean;
  reason?: string;
  reoptimization_result?: ScheduleOptimizeResponse;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  role: 'section_controller' | 'department';
  department_name?: string | null;
  display_name: string;
}

export interface UserProfile {
  id: number;
  email: string;
  role: 'section_controller' | 'department';
  department_name?: string | null;
  display_name: string;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationItem {
  id: number;
  department_name: string;
  event_type: string;
  block_id: number | null;
  message: string;
  created_at: string;
  read_at: string | null;
}

// ---------------------------------------------------------------------------
// SHAP Explainability
// ---------------------------------------------------------------------------

export interface ShapExplanation {
  base_value: number;
  shap_values: Record<string, number>;
  feature_values: Record<string, number>;
}

export interface EnrichedBlockWithShap extends EnrichedBlockResponse {
  shap_explanation: ShapExplanation | null;
}

// ---------------------------------------------------------------------------
// What-If Preview
// ---------------------------------------------------------------------------

export interface PreviewBlock {
  id: number | null;
  task_id: number;
  chainage_km: number;
  start_time: string;
  end_time: string;
  status: string;
  parent_block_id: number | null;
  rejection_reason: string | null;
  created_at: string | null;
}

export interface SchedulePreviewResponse {
  dry_run: boolean;
  tasks_scheduled: number;
  tasks_unscheduled: number;
  blocks_created: number;
  blocks: PreviewBlock[];
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

export interface LetterInfo {
  block_id: number;
  department: string;
  reference: string;
  status: string;
  available: boolean;
}
