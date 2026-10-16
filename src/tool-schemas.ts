import { z } from "zod";
import { comboSchema } from "./combo-client.js";
import { actionSchema, workflowInputSchema } from "./workflows.js";
import { probeSuiteNames } from "./combo-probes.js";

const text = z.string();
const count = z.number().int().nonnegative();
const strings = z.array(text);
const attempt = z.object({ attempt: count, started_at: text, elapsed_ms: z.number().nonnegative(), status: z.enum(["success", "degraded", "error"]), route: text,
  effective_model: text.nullable().optional(), finish_reason: text.nullable().optional(), quality_issues: strings.optional(), code: text.optional(), retryable: z.boolean().optional() }).passthrough();
const error = z.object({ name: text, code: text, message: text, phase: z.enum(["connect", "first_byte", "generation", "decode", "unknown"]), retryable: z.boolean(),
  status: count.nullable(), retry_after_ms: z.number().nonnegative().nullable(), request_id: text.nullable(), attempts: z.array(attempt) }).passthrough();
export const toolErrorSchema = z.object({ status: z.literal("error"), error }).passthrough();
const usage = z.object({ input_tokens: count.nullable(), output_tokens: count.nullable(), total_tokens: count.nullable() }).passthrough();
const quality = z.object({ status: z.enum(["ok", "degraded"]), issues: z.array(z.object({ code: text, message: text })), context_chars: count, context_bytes: count,
  context_sha256: text, output_chars: count, expected_ids: strings.optional(), present_ids: strings.optional(), missing_ids: strings.optional(), unexpected_ids: strings.optional() }).passthrough();
const delegation = z.object({ agent: text, requested_route: text, effective_model: text.nullable(), request_id: text, status: z.enum(["success", "degraded"]), content: text,
  selected_route: text, finish_reason: text.nullable(), elapsed_ms: z.number().nonnegative(), attempts: z.array(attempt), quality, usage }).passthrough();
const routing = z.object({ agent: text, task: text, manual: z.boolean(), reasons: strings, complexity_score: z.number(), needs_clarification: z.boolean(),
  classification: z.literal("deterministic"), suggested_flow: strings, execution: text }).passthrough();
const state = z.object({ decisions: strings.optional(), files_modified: strings.optional(), commands_executed: strings.optional(), test_results: strings.optional(), errors: strings.optional(), next_steps: strings.optional() }).passthrough();
const job = z.object({ job_id: z.uuid(), status: z.enum(["queued", "running", "success", "degraded", "error", "cancelled", "interrupted"]), agent: text,
  created_at: text, updated_at: text, routing: routing.optional(), partial_content: text.optional(), result: delegation.optional(), error: error.optional(), state: state.optional(),
  selected_route: text.nullable().optional(), effective_model: text.nullable().optional(), elapsed_ms: z.number().nonnegative().nullable().optional(), usage: usage.nullable().optional(), attempts: z.array(attempt).optional(),
  content_total_chars: count.optional(), content_offset: count.optional(), content_truncated: z.boolean().optional(), next_content_offset: count.nullable().optional() }).passthrough();
const actionFields = { id: z.uuid(), status: z.enum(["proposed", "approved", "rejected", "reported"]), result: z.object({ success: z.boolean(), evidence: text }).optional() };
const action = z.union([actionSchema.options[0].extend(actionFields), actionSchema.options[1].extend(actionFields), actionSchema.options[2].extend(actionFields)]);
const workflowStep = z.object({ actions: z.array(action), job_id: z.uuid().optional(), submission_started: z.boolean().optional(), summary: text.optional(), evidence: text.optional() }).passthrough();
const workflow = z.object({ workflow: z.object({ id: z.uuid(), created_at: text, updated_at: text,
  status: z.enum(["ready", "running", "awaiting_review", "awaiting_actions", "blocked", "completed"]), input: workflowInputSchema, current_step: count,
  steps: z.array(workflowStep), submissions: count, replans: z.array(z.object({ steps: z.array(workflowStep), reason: text })), error: text.optional() }).passthrough() });
const plan = z.object({ plan: z.object({ id: z.uuid(), provider: text, project_id: text, created_at: text, endpoint: text,
  definition: z.object({ name: text, models: strings, strategy: z.enum(["priority", "backend-default"]) }), source: comboSchema.optional(),
  status: z.enum(["proposed", "applying", "uncertain", "applied"]), result: comboSchema.optional() }).passthrough() });
const health = z.object({ status: z.enum(["ok", "configured", "degraded"]), mode: z.enum(["shallow", "inference"]), models_source: z.enum(["configured", "remote"]).optional(), model_count: count.optional(), checks: z.array(z.union([
    z.object({ agent: text, status: z.enum(["ok", "degraded"]), selected_route: text, effective_model: text.nullable(), finish_reason: text.nullable(), quality, attempts: z.array(attempt), elapsed_ms: z.number().nonnegative() }),
    z.object({ agent: text, status: z.literal("error"), error }),
  ])).optional() }).superRefine((value, context) => {
    if (value.mode === "shallow" && (value.models_source === undefined || value.model_count === undefined || value.status === "degraded")) context.addIssue({ code: "custom", message: "Shallow health requires model source/count and ok/configured status" });
    if (value.mode === "inference" && (value.checks === undefined || value.status === "configured")) context.addIssue({ code: "custom", message: "Inference health requires checks and ok/degraded status" });
  });
const probeResult = z.union([
  z.object({ model: text, case_id: text, passed: z.boolean(), status: z.enum(["success", "degraded"]), elapsed_ms: z.number().nonnegative(), response: text,
    effective_model: text.nullable(), usage, reported_model_matches_request: z.boolean() }),
  z.object({ model: text, case_id: text, passed: z.literal(false), status: z.literal("error"), elapsed_ms: z.number().nonnegative(), error }),
]);

export const outputSchemas = {
  diagnose: z.object({ version: text, runtime: z.object({ node: text, platform: text }), checks: z.array(z.object({ id: text, status: z.enum(["ok", "warning", "error"]), message: text })), network: z.literal(false), inference: z.literal(false) }),
  inspect_state: z.object({ jobs: z.object({ jobs: z.array(z.object({ id: z.uuid(), status: job.shape.status, ownership: z.enum(["local", "alive", "gone", "unknown"]), persistence_uncertain: z.boolean().optional() })),
    unreadable: strings, queued: count, pending_submissions: count, active: count }), budgets: z.array(z.object({ provider: text, window_started: z.number(), requests_reserved: count, tokens_reserved: count, active: count, uncertain: count, recovery: text,
      leases: z.array(z.object({ id: z.uuid(), agent: text, project: text.optional(), status: z.enum(["active", "uncertain"]), attempts: count, created_at: text, owner_pid: count.nullable(), owner_session: z.uuid().nullable() })) })), locks: z.array(z.object({ store: text, status: z.enum(["inspected", "absent", "unavailable"]), locks: strings, unrecognized: count, ownership: z.literal("unknown") })), mutated: z.literal(false) }),
  list_agents: z.object({ agents: z.array(z.object({ id: text, provider: text, role: text, description: text, routes: strings, route_strategy: z.enum(["fallback", "round_robin"]),
    timeout_ms: count, first_byte_timeout_ms: count, idle_timeout_ms: count, max_output_tokens: count, retries: count, concurrency: count }).passthrough()) }),
  health_check: health,
  delegate_agent: delegation,
  submit_agent_task: job,
  get_agent_task: job,
  cancel_agent_task: job,
  retry_agent_task: job,
  route_task: routing,
  submit_routed_task: job.extend({ routing }),
  list_agent_tasks: z.object({ jobs: z.array(job) }),
  list_providers: z.object({ providers: z.array(z.object({ id: text, protocol: z.literal("openai-chat-completions"), streaming: z.boolean(), models_source: z.enum(["configured", "remote"]),
    api_key_configured: z.boolean(), management: z.object({ adapter: z.enum(["9router", "omniroute"]), updates: z.literal("copy_on_write"), projects: strings }).nullable() }).passthrough()) }),
  list_models: z.object({ models: z.array(z.object({ id: text, owned_by: text.optional() }).passthrough()), source: z.enum(["configured", "remote"]) }),
  list_combos: z.object({ combos: z.array(comboSchema.extend({ project_id: text.nullable(), managed: z.boolean(), protected: z.boolean(), consumers: strings })),
    consumer_scan: z.object({ configured: count, unavailable: strings, coverage: z.literal("explicit_config_files_only") }), updates: z.literal("copy_on_write"), external_consumers_may_exist: z.literal(true) }),
  plan_combo: plan,
  apply_combo_plan: plan,
  test_combo: z.object({ report_id: z.uuid(), created_at: text, combo_id: text, provider: text, project_id: text, suite: z.enum(probeSuiteNames), results: z.array(probeResult),
    samples_per_model: count, variability: z.literal("not_measured"), physical_model_identity: z.literal("unknown"), mutates_combo: z.literal(false), retries: z.literal(0),
    max_output_tokens_per_request: z.literal(64), max_output_tokens_per_model: count, quality_evaluation: z.literal(false) }),
  create_workflow: workflow,
  get_workflow: workflow,
  advance_workflow: workflow,
  approve_workflow_action: workflow,
  record_workflow_action: workflow,
  review_workflow_step: workflow,
  replan_workflow: workflow,
};
