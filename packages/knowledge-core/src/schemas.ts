import { z } from "zod";

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);

export const CaptureEventSchema = z.object({
  event_id: z.string().optional(),
  run_id: z.string().optional(),
  event_type: z.string(),
  url: z.string().optional(),
  ts: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
});

export type CaptureEvent = z.infer<typeof CaptureEventSchema>;

export const AuthStatusSchema = z.enum(["unknown", "ready", "required", "expired", "blocked", "not_required"]);
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const AuthSignalSchema = z.object({
  kind: z.enum(["url", "text", "selector", "cookie", "storage", "request"]),
  name: z.string(),
  matched: z.boolean(),
  confidence: z.number().default(0.5),
  detail: z.string().default(""),
});
export type AuthSignal = z.infer<typeof AuthSignalSchema>;

export const AuthProfileSchema = z.object({
  profile_id: z.string(),
  system_key: z.string(),
  entry_url: z.string().default(""),
  login_url: z.string().default(""),
  browser_partition: z.string().default("persist:autorecipe-default"),
  cookie_scope: z.string().default(""),
  status: AuthStatusSchema.default("unknown"),
  last_verified_at: z.string().default(""),
  verified_url: z.string().default(""),
  signals: z.array(AuthSignalSchema).default([]),
  updated_at: z.string().default(""),
});
export type AuthProfileInput = z.input<typeof AuthProfileSchema>;
export type AuthProfile = z.infer<typeof AuthProfileSchema>;

export const AuthVerificationSchema = z.object({
  profile_id: z.string().default("default"),
  system_key: z.string().default("default"),
  status: AuthStatusSchema,
  verified_at: z.string().default(""),
  verified_url: z.string().default(""),
  reason: z.string().default(""),
  signals: z.array(AuthSignalSchema).default([]),
  sensitive_values_stored: z.literal(false).default(false),
});
export type AuthVerificationInput = z.input<typeof AuthVerificationSchema>;
export type AuthVerification = z.infer<typeof AuthVerificationSchema>;

export const RunContextSchema = z.object({
  run_id: z.string(),
  run_name: z.string().default(""),
  url: z.string(),
  entry_url: z.string().default(""),
  current_url: z.string().default(""),
  system_key: z.string(),
  goal: z.string().default("desktop_client_session"),
  driver: z.string().default("desktop_chromium"),
  capture_mode: z.string().default("desktop_client"),
  tenant_id: z.string().default("default"),
  client_version: z.string().default(""),
  collector_id: z.string().default(""),
  auth_profile: z.string().default(""),
  auth_status: AuthStatusSchema.default("unknown"),
  auth_verified_at: z.string().default(""),
  auth_interrupt_reason: z.string().default(""),
  credential_scope: z.string().default(""),
  capture_env: z.string().default("default"),
  upload_policy: z.record(z.unknown()).default({}),
  target_host: z.string().default(""),
  target_host_suffix: z.string().default(""),
  latest_assets: z.record(z.string()).default({}),
  consolidated: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
});

export type RunContext = z.infer<typeof RunContextSchema>;

export const InteractiveElementSchema = z.object({
  label: z.string(),
  selector: z.string().default(""),
  action_types: z.array(z.string()).default([]),
  region: z.string().default("main_content"),
  confidence: z.number().default(0.7),
  bbox: z.record(z.unknown()).default({}),
  style_fingerprint: z.string().default(""),
  region_bbox: z.record(z.number()).default({}),
  direct_text: z.string().default(""),
});

export type InteractiveElement = z.infer<typeof InteractiveElementSchema>;

export const RegionPartitionSchema = z.object({
  region: z.string(),
  x_pct: z.number(),
  y_pct: z.number(),
  width_pct: z.number(),
  height_pct: z.number(),
  confidence: z.number().default(0.7),
  source: z.string().default("layout_snapshot"),
  selector_hint: z.string().default(""),
  recognition_level: z.string().default("medium"),
  recognized_by: z.array(z.string()).default([]),
  semantic_tags: z.array(z.string()).default([]),
});

export type RegionPartition = z.infer<typeof RegionPartitionSchema>;

export const PercentBboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type PercentBbox = z.infer<typeof PercentBboxSchema>;

export const RequestRecordSchema = z.object({
  signature: z.string(),
  method: z.string(),
  host: z.string().default(""),
  path_template: z.string(),
  sample_url: z.string().default(""),
  page_id: z.string().default(""),
  page_url: z.string().default(""),
  page_urls: z.array(z.string()).default([]),
  query_keys: z.array(z.string()).default([]),
  query_sample: z.record(z.array(z.string())).default({}),
  body_keys: z.array(z.string()).default([]),
  body_sample: z.record(z.array(z.string())).default({}),
  body_key_fingerprint: z.string().default("none"),
  body_format: z.string().default("none"),
  status_code: z.number().default(200),
  occurrence: z.number().default(1),
  latency_p95_ms: z.number().default(0),
  latency_avg_ms: z.number().default(0),
  is_effective: z.boolean().default(true),
  effective_reason: z.string().default("business_api"),
  request_category: z.string().default("business"),
});

export type RequestRecord = z.infer<typeof RequestRecordSchema>;

export const PageAssetRequestSchema = RequestRecordSchema.pick({
  signature: true,
  method: true,
  host: true,
  path_template: true,
  request_category: true,
  occurrence: true,
  latency_avg_ms: true,
  latency_p95_ms: true,
  query_keys: true,
  body_keys: true,
}).extend({
  status_codes: z.array(z.number()).default([]),
});

export const PageStateSliceSchema = z.object({
  state_key: z.string(),
  state_label: z.string(),
  region: z.string().default("main_content"),
  event_type: z.string().default("ui_click"),
  trigger_count: z.number().default(0),
  confidence: z.number().default(0),
  target_hints: z.array(z.string()).default([]),
  bbox: z.record(z.unknown()).default({}),
  request_signatures: z.array(z.string()).default([]),
  request_count: z.number().default(0),
  request_categories: z.array(z.string()).default([]),
  screenshot_refs: z.array(z.record(z.unknown())).default([]),
  evidence_refs: z.array(z.string()).default([]),
  semantic_tags: z.array(z.string()).default([]),
});

export const PageAssetSchema = z.object({
  page_url: z.string(),
  page_id: z.string(),
  entry_url: z.string().default(""),
  page_host: z.string().default(""),
  screenshot_refs: z.array(z.record(z.unknown())).default([]),
  regions: z.array(z.string()).default([]),
  region_partitions: z.array(RegionPartitionSchema).default([]),
  interactives: z.array(InteractiveElementSchema).default([]),
  requests: z.array(PageAssetRequestSchema).default([]),
  request_count: z.number().default(0),
  param_hotspots: z.array(z.string()).default([]),
  state_slices: z.array(PageStateSliceSchema).default([]),
  evidence_refs: z.array(z.string()).default([]),
});

export type PageAsset = z.infer<typeof PageAssetSchema>;

export const PageMapPageSchema = z.object({
  page_url: z.string(),
  page_id: z.string(),
  entry_url: z.string().default(""),
  page_host: z.string().default(""),
  screenshot_refs: z.array(z.record(z.unknown())).default([]),
  regions: z.array(z.string()).default([]),
  region_partitions: z.array(RegionPartitionSchema).default([]),
  heat_zones: z.array(z.object({
    zone_id: z.string(),
    page_id: z.string(),
    region: z.string().default("main_content"),
    center: z.object({
      x_pct: z.number(),
      y_pct: z.number(),
    }),
    bbox_pct: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
    event_count: z.number().default(0),
    action_types: z.array(z.string()).default([]),
    top_labels: z.array(z.string()).default([]),
    element_ids: z.array(z.string()).default([]),
    request_signatures: z.array(z.string()).default([]),
    evidence_refs: z.array(z.string()).default([]),
    confidence: z.number().default(0.6),
  })).default([]),
  request_count: z.number().default(0),
  param_hotspots: z.array(z.string()).default([]),
  state_slices: z.array(PageStateSliceSchema).default([]),
  evidence_refs: z.array(z.string()).default([]),
  page_type: z.enum(["list", "detail", "form", "dashboard", "search", "settings", "login", "other"]).default("other"),
  page_description: z.string().default(""),
});

export type PageMapPage = z.infer<typeof PageMapPageSchema>;

export const NavigationEdgeSchema = z.object({
  edge_id: z.string(),
  direction: z.enum(["enter", "exit", "move"]),
  from_page_id: z.string(),
  to_page_id: z.string(),
  action_id: z.string(),
  label: z.string(),
  element_id: z.string().default(""),
  source_region: z.string().default("main_content"),
  module_id: z.string().default(""),
  evidence_refs: z.array(z.string()).default([]),
  confidence: z.number().default(0.7),
  priority: z.number().default(100),
});

export type NavigationEdge = z.infer<typeof NavigationEdgeSchema>;

export const PageSurfaceSchema = z.object({
  surface_id: z.string(),
  surface_kind: z.enum(["primary_page", "secondary_surface", "child_window_surface"]).default("primary_page"),
  label: z.string().default(""),
  page_id: z.string(),
  page_url: z.string(),
  surface_bbox_in_viewport: PercentBboxSchema.default({ x: 0, y: 0, width: 100, height: 100 }),
  screenshot_refs: z.array(z.record(z.unknown())).default([]),
  heat_zones: z.array(z.object({
    zone_id: z.string(),
    surface_id: z.string(),
    region: z.string().default("main_content"),
    center: z.object({
      x_pct: z.number(),
      y_pct: z.number(),
    }),
    bbox_pct: PercentBboxSchema,
    event_count: z.number().default(0),
    action_types: z.array(z.string()).default([]),
    top_labels: z.array(z.string()).default([]),
    request_signatures: z.array(z.string()).default([]),
    evidence_refs: z.array(z.string()).default([]),
    confidence: z.number().default(0.6),
  })).default([]),
  action_count: z.number().default(0),
  request_count: z.number().default(0),
});

export type PageSurface = z.infer<typeof PageSurfaceSchema>;

export const PageMapArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("page_map").default("page_map"),
  source_system: z.string(),
  source_url: z.string(),
  url_history: z.array(z.string()).default([]),
  pages: z.array(PageMapPageSchema).default([]),
  surfaces: z.array(PageSurfaceSchema).default([]),
  navigation_edges: z.array(NavigationEdgeSchema).default([]),
  confidence: z.number().default(0.7),
});

export type PageMapArtifact = z.infer<typeof PageMapArtifactSchema>;

export const BusinessCatalogActionSchema = z.object({
  action_id: z.string(),
  label: z.string(),
  page_id: z.string(),
  element_id: z.string().default(""),
  request_signatures: z.array(z.string()).default([]),
  evidence_refs: z.array(z.string()).default([]),
});

export type BusinessCatalogAction = z.infer<typeof BusinessCatalogActionSchema>;

export const BusinessCatalogModuleSchema = z.object({
  module_id: z.string(),
  title: z.string(),
  level: z.number().default(1),
  parent_module_id: z.string().default(""),
  source_region: z.string().default("left_nav"),
  pages: z.array(z.string()).default([]),
  element_ids: z.array(z.string()).default([]),
  heat_zone_ids: z.array(z.string()).default([]),
  request_signatures: z.array(z.string()).default([]),
  actions: z.array(BusinessCatalogActionSchema).default([]),
  entry_actions: z.array(NavigationEdgeSchema).default([]),
  exit_actions: z.array(NavigationEdgeSchema).default([]),
  evidence_refs: z.array(z.string()).default([]),
  confidence: z.number().default(0.65),
});

export type BusinessCatalogModule = z.infer<typeof BusinessCatalogModuleSchema>;

export const BusinessCatalogArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("business_catalog").default("business_catalog"),
  source_system: z.string(),
  source_url: z.string(),
  modules: z.array(BusinessCatalogModuleSchema).default([]),
  navigation_edges: z.array(NavigationEdgeSchema).default([]),
  confidence: z.number().default(0.65),
});

export type BusinessCatalogArtifact = z.infer<typeof BusinessCatalogArtifactSchema>;

export const ElementAssetSchema = InteractiveElementSchema.extend({
  element_id: z.string(),
  page_id: z.string(),
  role: z.string().default(""),
  text: z.string().default(""),
  aria_label: z.string().default(""),
  locator_candidates: z.array(z.record(z.unknown())).default([]),
  evidence_refs: z.array(z.string()).default([]),
});

export type ElementAsset = z.infer<typeof ElementAssetSchema>;

export const ElementMapArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("element_map").default("element_map"),
  source_system: z.string(),
  source_url: z.string(),
  elements: z.array(ElementAssetSchema).default([]),
  confidence: z.number().default(0.7),
});

export type ElementMapArtifact = z.infer<typeof ElementMapArtifactSchema>;

export const EvidenceIndexArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("evidence_index").default("evidence_index"),
  system_key: z.string(),
  run_id: z.string(),
  raw_event_count: z.number().default(0),
  events: z.array(z.record(z.unknown())).default([]),
  screenshots: z.array(z.record(z.unknown())).default([]),
});

export type EvidenceIndexArtifact = z.infer<typeof EvidenceIndexArtifactSchema>;

export const RequestCatalogArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("request_catalog").default("request_catalog"),
  source_system: z.string(),
  source_url: z.string(),
  requests: z.array(RequestRecordSchema).default([]),
  grouped_requests: z.array(z.record(z.unknown())).default([]),
  filters: z.record(z.unknown()).default({}),
  summary: z.record(z.unknown()).default({}),
});

export type RequestCatalogArtifact = z.infer<typeof RequestCatalogArtifactSchema>;

export const ActionTraceStepSchema = z.object({
  action_id: z.string(),
  ts: z.string().default(""),
  ts_ms: z.number().default(0),
  page_url: z.string().default(""),
  page_id: z.string(),
  element_id: z.string().default(""),
  region: z.string().default("main_content"),
  label: z.string().default(""),
  event_type: z.string().default("ui_click"),
  request_signatures: z.array(z.string()).default([]),
  x_pct: z.number().default(0),
  y_pct: z.number().default(0),
  w_pct: z.number().default(0),
  h_pct: z.number().default(0),
  surface_id: z.string().default(""),
  surface_kind: z.enum(["primary_page", "secondary_surface", "child_window_surface"]).default("primary_page"),
  surface_label: z.string().default(""),
  surface_bbox: PercentBboxSchema.default({ x: 0, y: 0, width: 0, height: 0 }),
  surface_bbox_in_viewport: PercentBboxSchema.default({ x: 0, y: 0, width: 100, height: 100 }),
  next_page_url: z.string().default(""),
  next_page_id: z.string().default(""),
  evidence_refs: z.array(z.string()).default([]),
});

export type ActionTraceStep = z.infer<typeof ActionTraceStepSchema>;

export const ActionTraceArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("action_trace").default("action_trace"),
  system_key: z.string(),
  run_id: z.string(),
  actions: z.array(ActionTraceStepSchema).default([]),
});

export type ActionTraceArtifact = z.infer<typeof ActionTraceArtifactSchema>;

export const SemanticAnnotationsArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("semantic_annotations").default("semantic_annotations"),
  system_key: z.string(),
  run_id: z.string(),
  model: z.string().default(""),
  annotations: z.array(z.object({
    target_type: z.string().default(""),
    target_id: z.string().default(""),
    business_purpose: z.string().default(""),
    data_entities: z.array(z.string()).default([]),
    model: z.string().default(""),
    confidence: z.number().default(0.5),
    evidence_refs: z.array(z.string()).default([]),
  })).default([]),
});

export type SemanticAnnotationsArtifact = z.infer<typeof SemanticAnnotationsArtifactSchema>;

export const ActionRuleSchema = z.object({
  rule_id: z.string(),
  canonical_action: z.string(),
  entry_page: z.string(),
  current_page: z.string(),
  target_element_id: z.string().default(""),
  effect: z.string().default(""),
  next_page: z.string().default(""),
  risk_level: RiskLevelSchema.default("low"),
  requires_human_gate: z.boolean().default(false),
  preconditions: z.array(z.string()).default([]),
  success_criteria: z.array(z.string()).default([]),
  evidence_refs: z.array(z.string()).default([]),
  confidence: z.number().default(0.6),
});

export type ActionRule = z.infer<typeof ActionRuleSchema>;

export const ActionRulesArtifactSchema = z.object({
  generated_at: z.string(),
  schema_version: z.string().default("v1"),
  producer: z.string().default("autorecipe-ts"),
  artifact_type: z.literal("action_rules").default("action_rules"),
  source_system: z.string(),
  source_url: z.string(),
  actions: z.array(z.record(z.unknown())).default([]),
  rules: z.array(ActionRuleSchema).default([]),
  risk_policy: z.record(z.unknown()).default({}),
});

export type ActionRulesArtifact = z.infer<typeof ActionRulesArtifactSchema>;

export const RecipePackStepSchema = z.object({
  action: z.enum(["click_text", "fill_text", "observe_or_navigate", "drag_text", "key_press", "submit_form"]),
  page: z.string(),
  element_id: z.string().default(""),
  region: z.string().default("main_content"),
  text: z.string().default(""),
  value: z.string().optional(),
  text_mode: z.string().default("exact_text"),
  semantic_action: z.string().default(""),
  target_type: z.string().default("action"),
  locator_candidates: z.array(z.record(z.unknown())).default([]),
  assert_next_page: z.string().default(""),
  success_criteria: z.array(z.string()).default([]),
});

export type RecipePackStep = z.infer<typeof RecipePackStepSchema>;

export const RecipePackSchema = z.object({
  schema_version: z.string().default("v1"),
  artifact_type: z.literal("recipe_pack").default("recipe_pack"),
  system_key: z.string(),
  recipe_id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  entry_pages: z.array(z.string()).default([]),
  steps: z.array(RecipePackStepSchema).default([]),
  playwright_recipe: z.object({
    steps: z.array(RecipePackStepSchema).default([]),
  }).default({ steps: [] }),
  success_criteria: z.array(z.string()).default([]),
  matched_requests: z.array(z.record(z.unknown())).default([]),
  summary: z.record(z.unknown()).default({}),
});

export type RecipePack = z.infer<typeof RecipePackSchema>;

export const SystemCapabilityStepSchema = z.object({
  step_number: z.number(),
  action: z.enum(["navigate", "click", "fill", "submit", "observe"]),
  description: z.string(),
  page_id: z.string().default(""),
  element_label: z.string().default(""),
  element_id: z.string().default(""),
  locator_candidates: z.array(z.record(z.unknown())).default([]),
});

export type SystemCapabilityStep = z.infer<typeof SystemCapabilityStepSchema>;

export const SystemCapabilitySchema = z.object({
  capability_id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  intent_category: z.enum(["search", "navigate", "fill_form", "login", "browse", "configure", "other"]).default("other"),
  steps: z.array(SystemCapabilityStepSchema).default([]),
  pages_involved: z.array(z.string()).default([]),
  key_elements: z.array(z.string()).default([]),
  source_run_ids: z.array(z.string()).default([]),
  observation_count: z.number().default(1),
  confidence: z.number().default(0.6),
});

export type SystemCapability = z.infer<typeof SystemCapabilitySchema>;

export const OperationManualSchema = z.object({
  generated_at: z.string(),
  schema_version: z.literal("v1").default("v1"),
  artifact_type: z.literal("operation_manual").default("operation_manual"),
  system_key: z.string(),
  system_name: z.string(),
  capabilities: z.array(SystemCapabilitySchema).default([]),
  source_run_count: z.number().default(0),
  source_run_ids: z.array(z.string()).default([]),
  confidence: z.number().default(0.5),
});

export type OperationManual = z.infer<typeof OperationManualSchema>;
