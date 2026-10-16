# Project combos and model probes

Combo management is optional and disabled unless configured. Existing inference-only profiles continue to work. The MCP uses each user's own models and credentials.

## Private configuration

```yaml
providers:
  local:
    base_url: http://127.0.0.1:20128/v1
    api_key_env: INFERENCE_KEY
    management:
      adapter: 9router
      base_url: http://127.0.0.1:20128
      api_key_env: MANAGEMENT_KEY
      protected_routes: [shared-cli-route]
      consumers:
        - id: other-cli
          path: /absolute/path/to/private/cli.json
      projects:
        my-project:
          models: [your-first-model-id, your-second-model-id]
          allow_create: false
          allow_update: false
          allow_tests: false
          max_combos: 10
          max_test_models: 4
```

Enable permissions deliberately in this private file. The model cannot grant itself permissions through a tool argument. Administrative credentials are referenced by environment-variable name, never inherited from inference credentials. Only Bearer authentication is currently supported: an installation requiring dashboard cookies or another scheme fails closed. The MCP never logs in, disables authentication, or upgrades backends.

Adapters target the upstream GET/POST `/api/combos` contracts. `omniroute` creates `priority` combos. `9router` sends only name and model IDs and reports `backend-default`, without changing global strategy settings. Advanced strategies, nested combos, and deletion are not exposed. Controlled HTTP fixtures verify these contracts, not every installed version.

## Protect other CLIs

`list_combos` returns ownership, project IDs, protected status, and known consumer labels. Every combo without a matching creation record is external and protected. A familiar name or namespace does not prove ownership.

Only explicitly configured regular JSON files are read. The scanner extracts `model` and `small_model` strings, including nested agent definitions, and matches plain routes and `provider/route` references. Full configuration contents, paths, and credentials are not returned. JSONC, malformed/missing/oversized files and symlinks appear under `consumer_scan.unavailable`. No automatic home-directory or other-user scan occurs.

`protected_routes` supplements discovery. Unknown consumers may exist; an empty reference list never proves a combo is unused. Backend combos can be globally visible. Namespaces establish MCP ownership conventions, not backend access isolation.

## Tools and invocation binding

1. `list_models` and `list_combos` inspect the selected provider. A catalog does not prove model availability or price.
2. `plan_combo` accepts provider, project ID, a short name, and allowed member IDs. It persists a concrete proposal without writing to the backend.
3. `apply_combo_plan` requires the relevant private permission, creates a unique project-owned route, and reads back the result.
4. Passing an owned `source_combo_id` to `plan_combo` creates a replacement version. The original is checked but never overwritten or deleted.
5. `delegate_agent`, `submit_agent_task`, and `submit_routed_task` accept `project_id` and `combo_id` together. Workflow steps accept the same pair. Only an unchanged combo owned by that project may be selected. The agent keeps its instructions; its route changes for that invocation, without MCP fallbacks to the original routes.

No tool edits agents.yaml, CLI primary/small models, global aliases, or backend settings. All updates are copy-on-write, protecting even consumers the scanner cannot discover.

Apply uses an exclusive interprocess file lock. A surviving lock after a crash requires operator recovery: inspect the exact lock and running consumers before removal. A timed-out POST becomes uncertain; reapplication reconciles by unique name and expected definition without another POST. Missing/conflicting results stop reconciliation. Successful reapplication verifies and returns the existing result.

State defaults to `.combos` beside job state. Set `MULTIAGENTS_COMBOS_DIR` to a private absolute directory for stable installations. The directory requires mode 0700; files use 0600. Preserve state for ownership and recovery. Previous versions remain and count against project limits; cleanup is a separate operator decision.

## Individual member probes

```json
{"provider":"local","project_id":"my-project","combo_id":"backend-combo-id","models":["your-first-model-id"]}
```

Pass this to `test_combo`. Omit `models` to test all distinct members within `max_test_models`; explicit subsets must belong to the combo. Every ID must be allowed by project policy and present in the configured/remote catalog. External combos can be tested without adoption or modification.

The probe sends a fixed `Reply exactly: OK` prompt to each model directly and sequentially: zero MCP retries/fallbacks, 20-second request limit, at most 64 output tokens per member. It reports success/degraded/error, response, latency, reported effective model, and usage when supplied. A failing member does not prevent testing subsequent selected members. Project source and arbitrary user prompts are never sent by this tool.

Requests consume quota and may cost money. Limits are per invocation, not a daily or monetary budget. `allow_tests` is false by default. Backend aliases/account fallback may still apply; `reported_model_matches_request` compares identifiers, not physical identity. This is an availability/control-prompt test, not a benchmark of reasoning, tools, multimodal support, or individual account connections.

## Português

Habilite a gestão somente no arquivo privado do usuário. `consumers` identifica rotas de outras CLIs sem expor seus arquivos completos; todos os combos externos ficam protegidos. Atualizações criam uma nova versão sem sobrescrever o combo anterior ou alterar configurações de CLIs.

`test_combo` testa os modelos individualmente, inclusive de combos externos. Exige permissão, IDs autorizados e limites por chamada. Os testes consomem cota e medem disponibilidade, não qualidade geral. Para usar uma nova versão, a tarefa ou etapa do workflow informa explicitamente projeto e combo.

## Upstream contracts

- https://github.com/decolua/9router/blob/master/src/app/api/combos/route.js
- https://github.com/decolua/9router/blob/master/src/lib/db/repos/combosRepo.js
- https://github.com/diegosouzapw/OmniRoute/blob/main/src/app/api/combos/route.ts
- https://github.com/diegosouzapw/OmniRoute/blob/main/src/lib/api/requireManagementAuth.ts
