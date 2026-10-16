# Project Combo Management Implementation Plan

> Execution: use the executing-plans skill after scope approval. This document is a proposal, not authorization to modify a live backend.

**Goal:** Let an MCP client propose, create, and update project-specific routing combos using the user's own available models and configured permissions.

**Architecture:** Keep inference and backend administration separate. Add an optional management adapter to provider profiles, starting with OmniRoute; unsupported backends retain inference functionality. The MCP host, not a delegated model, validates and performs administrative calls.

**Tech Stack:** Existing TypeScript, Node.js >=20.11, Zod, fetch, node:test, and private JSON persistence. No new runtime dependency planned.

**Spec:** Approved by the user in this chat, with additional requirements to protect other CLIs and probe individual combo members.

## Implementation checkpoint

- Implemented optional 9Router and OmniRoute management adapters against inspected upstream API contracts.
- All updates use copy-on-write. No existing remote combo is overwritten or deleted; global strategy settings and CLI configurations are untouched.
- Added list_models, list_combos, plan_combo, apply_combo_plan, and test_combo, plus project/owned-combo binding for direct, routed, queued, retried, and workflow tasks.
- Explicit JSON consumer discovery extracts only model references; external combos remain protected even without discovered consumers.
- Individual probes use a fixed prompt, model allowlists, per-call limits, no MCP fallback/retry, and separate inference credentials.
- 49 tests passed on Node 20 and Node 24, including real MCP protocol tests with controlled HTTP backends, uncertain POST reconciliation, concurrent apply, symlink/redirect rejection, policy enforcement, and queued-job revalidation.
- Live backend mutations and quota-consuming probes were not run. A read-only request to the installed OmniRoute management endpoint returned 401; no authentication settings or existing combos were changed. Installed-version compatibility must be confirmed with the operator's management credentials.
- Manual plan approval calls were intentionally omitted: write/test permissions come solely from explicit private operator policy. The model cannot grant itself permission through an approval flag.

## Confirmed findings

- Inspected checkout: commit 31057c7, package version 0.4.2.
- src/index.ts registers delegation, routing, jobs, providers, and workflow tools, but no combo-management tools.
- src/router-client.ts uses /v1/models and /v1/chat/completions. src/providers.ts has no management adapter, management credential, or combo schema.
- src/workflows.ts supports read_file, propose_patch, and run_tests proposals. Its approval mechanism does not currently authorize or execute backend administration.
- OmniRoute upstream exposes GET/POST /api/combos and GET/PUT/PATCH /api/combos/{id}. Management authentication is separate from ordinary inference permissions.
- Upstream schemas include version-dependent model steps and strategies. OpenAI compatibility alone does not imply compatibility with these administrative endpoints.
- 9Router compatibility has not been verified. Do not advertise or activate a 9Router adapter by copying OmniRoute payloads.
- No administrative calls, live inference probes, or combo changes were performed in this investigation.

## Sources and limits

- https://github.com/diegosouzapw/OmniRoute/blob/main/src/app/api/combos/route.ts
- https://github.com/diegosouzapw/OmniRoute/blob/main/src/app/api/combos/%5Bid%5D/route.ts
- https://github.com/diegosouzapw/OmniRoute/blob/main/src/lib/api/requireManagementAuth.ts
- https://github.com/diegosouzapw/OmniRoute/blob/main/src/shared/validation/schemas/combo.ts
- https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/frameworks/MCP-SERVER.md

These are upstream evidence, not proof of the schema/authentication supported by the user's installed version. Pin a tested backend version before declaring support. OmniRoute also has its own MCP for some combo operations; inspect its actual tools before duplicating an already available operation.

## Global constraints

- No personal agent names, provider credentials, model IDs, or combos in public defaults.
- Existing inference-only profiles and delegation APIs continue to work unchanged.
- Management is disabled unless explicitly configured by the user. No tools accept arbitrary management URLs, credentials, or filesystem paths from a model.
- The client may select models autonomously only within an operator-configured policy; task text and model output cannot expand that policy.
- No automatic subscription, account connection, key creation, billing change, backend upgrade, or primary Codex model change.
- MVP excludes combo deletion, nested combos, arbitrary system prompts inside combos, and backend-specific advanced strategies.
- Use APIs, not direct backend database edits. Do not infer access, cost, tool support, or quality merely from model names or catalog presence.

## Proposed interface

| Tool | Purpose |
| --- | --- |
| list_models(provider) | Return configured/remote model IDs with provenance; unknown capabilities and costs remain unknown. |
| list_combos(provider, project_id?) | Read backend combos and distinguish locally managed project combos from external ones. |
| plan_combo(provider, project_id, operation, name, models, strategy, expected_revision?) | Validate and persist a concrete proposal with a diff, policy decision, and snapshot for updates. No backend write. |
| apply_combo_plan(plan_id) | Revalidate policy and current backend state, apply an authorized plan, reconcile uncertainty, and read back the result. |

Extend list_providers with explicit management capability information. get_combo can be added only if list output proves insufficient; avoid unnecessary tools.

For manual mode, the host supplies approval through a dedicated approval call/channel. An approved=true argument in a model-generated proposal is never sufficient. The backend permission and operator configuration remain the authority. For automatic mode, apply_combo_plan is allowed without per-call human confirmation only within the preconfigured policy.

## Configuration and autonomy

Add an optional management section in private provider profiles: adapter kind, explicit administrative base URL, credential environment variable, and project policy. Never reuse inference credentials implicitly. Keep secrets out of tool responses, plans, snapshots, and audit logs. Deny redirects that would forward credentials to another origin; preserve configured path prefixes and encode resource IDs.

Minimum policy: configured project IDs, allowed model IDs, allowed strategies, maximum combos per project, create/update permissions, and manual or policy-based authorization. Only change combos created and recorded by this MCP under that project's namespace. Editing an existing user combo requires separate explicit scope; leave it out of MVP.

Project names do not isolate the backend: combos may be globally visible and consumed by other clients. Namespace plus ownership records prevents accidental edits, but is not a backend access-control boundary. No guarantee of project-level API isolation unless the backend provides it.

Do not silently enforce a monetary promise the backend cannot substantiate. An allowlist is enforceable; a free-only rule needs trustworthy backend/operator metadata and must reject unknown pricing. Optional real probes consume quota and require separate authorization/budget.

## Task 1: Management capabilities and read-only discovery

**Files:** Modify src/providers.ts, src/index.ts, config/providers.example.yaml, docs/PROVIDERS.md; create src/combo-client.ts and src/combo-client.test.ts; extend src/providers.test.ts.

- [ ] Confirm installed backend schema, authentication, and native MCP capabilities with bounded read-only inspection. Record a supported version contract. If another backend is unsupported, report unsupported rather than guessing routes.
- [ ] Add strict optional management configuration and a small OmniRoute adapter with list/read operations. Keep transport separate from RouterClient's inference credential.
- [ ] Expose model discovery and combo listing with honest configured/remote/verified provenance and supported strategy metadata.
- [ ] Test disabled management, unknown adapters, configured path prefixes, encoded IDs, pagination, authentication failures, timeouts, credential redaction, cross-origin redirects, and inference-profile compatibility.

**Acceptance:** A user with their own provider profile can inspect models and combos; an inference-only profile makes no management requests.

## Task 2: Project-scoped proposals, creation, and updates

**Files:** Create src/combos.ts and src/combos.test.ts; extend src/combo-client.ts, src/index.ts, src/providers.ts; add src/combos-mcp.test.ts.

- [ ] Persist plans and ownership/audit records privately, with atomic writes and the existing private-state conventions. Record project, provider, exact desired state, prior snapshot, policy decision, and operation status, without credentials or project source content.
- [ ] Reject empty/duplicate model lists, unauthorized models/projects/strategies, name collisions, unsupported model-step shapes, and attempts to modify external combos. Validate references against the selected backend rather than assuming every advertised model is usable.
- [ ] Implement create and update only, with reviewable diffs. Policy-authorized automatic execution may manage only this MCP's project-owned combos.
- [ ] For updates, re-read and compare the expected revision/hash. Use backend conditional writes if supported. Without atomic compare-and-set, disclose the race limitation and restrict automatic updates; a local lock does not serialize dashboard or other-client writes.
- [ ] Do not blindly retry a timed-out POST/PUT. Mark uncertain state and reconcile by stored operation identity, name, and readback. A naming collision with different contents is a conflict, not proof of success.
- [ ] Read back successful writes. On failure, preserve evidence and previous snapshots; restoration must verify there was no later external modification. No unconditional rollback that overwrites concurrent work.
- [ ] Test create/update success, repeated application, process restart, policy rejection, unchanged plans after approval, simultaneous requests, external edits, uncertain writes, readback mismatch, and no secret leakage through the real MCP protocol.

**Acceptance:** Reapplying a plan does not duplicate a combo; unsupported or unauthorized operations have no write side effects; a failed or uncertain operation is never reported as verified success.

## Task 3: Use a project combo in delegation

**Files:** Modify src/index.ts, src/jobs.ts, src/providers.ts, src/smart-router.ts and relevant tests; update README.md and docs/WORKFLOWS.md.

- [ ] Add optional project/managed-combo selection to direct, asynchronous, and routed delegation through shared resolution. Verify provider, project ownership, policy, and current existence before submission.
- [ ] Snapshot the selected route in the job, so later combo-policy decisions do not silently rewrite historical records. Explain that backend combo edits can still alter subsequent upstream routing.
- [ ] Do not modify global agents.yaml automatically. A configured agent retains its role/instructions; the selected combo changes only the authorized route for this invocation.
- [ ] Propagate explicit project/route binding through workflow steps using the existing job submission path. No inference probe or combo creation is triggered merely by creating a workflow.
- [ ] Test custom user agent IDs, same IDs across projects, cross-provider/project rejection, async persistence, and unchanged behavior when project combo fields are omitted.

**Acceptance:** A client can discover its models, plan/apply a project combo, and use it for an actual delegated task without changing another project's routes or the client's primary model.

## Task 4: Documentation, packaging, and release verification

**Files:** README.md, docs/PROVIDERS.md, docs/WORKFLOWS.md, SECURITY.md, scripts/prepare-release.mjs, scripts/package.test.mjs; version fields only when a release is authorized.

- [ ] Document inference vs management permissions, policy-based autonomy, unsupported backends, globally visible combo scope, cost/availability uncertainty, conflict behavior, and recovery.
- [ ] Update the publication allowlist for new source/test files and keep private project policies/state/snapshots out of npm and Git. The existing source inclusion already covers new .ts files; verify rather than add redundant rules.
- [ ] Run focused tests, npm test, npm run release:prepare, and npm pack --dry-run. Run CI on Node 20 and 24.
- [ ] With explicit live-test authorization, create a temporary project-owned combo, read it back, invoke it with a bounded prompt, and verify the reported route/result. Any cleanup uses exact IDs and separate deletion authorization; preserve the validation evidence.
- [ ] Publish only after scope and implementation approval; verify commit, CI, package contents, and registry metadata.

**Release criterion:** No advertised backend support without a version-tested adapter, no personal defaults, and no completion claim based only on an HTTP 200 or model catalog listing.

## Recommendation

Implement read-only discovery plus plan/apply for simple OmniRoute combos first. Allow opt-in automatic creation inside a configured project policy. Add safe updates and invocation binding before calling the feature complete. Treat 9Router as a separate adapter after its real API contract is verified. Keep advanced strategies, deletion, benchmarks, and optimization loops out of this first release.
