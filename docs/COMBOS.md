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

State defaults to `.combos` beside job state. Set `MULTIAGENTS_COMBOS_DIR` to a private absolute directory for stable installations. The directory requires mode 0700; files use 0600. Preserve state for ownership and recovery. Previous versions remain and count against project limits; cleanup is a separate operator decision. Linux/WSL is the confirmed private-state scope; POSIX mode checks do not certify native Windows ACL privacy.

Revisions now use `canonical-v1:` with recursively ordered keys and all raw backend fields. Property order does not cause conflicts, while configuration changes do. No timestamp is excluded without backend evidence establishing volatility. Legacy 0.5.0 raw hashes remain accepted when the original raw hash matches or its complete fields can be reconstructed exactly. Unknown legacy fields/order that cannot be reconstructed fail closed; they are not silently adopted. Reading legacy records does not rewrite the ledger.

## Individual member probes

```json
{"provider":"local","project_id":"my-project","combo_id":"backend-combo-id","models":["your-first-model-id"]}
```

Pass this to `test_combo`. Omit `models` to test all distinct members within `max_test_models`; explicit subsets must belong to the combo. Every ID must be allowed by project policy and present in the configured/remote catalog. External combos can be tested without adoption or modification.

The default `availability-v1` probe sends a fixed `Reply exactly: OK` prompt to each model directly and sequentially: zero MCP retries/fallbacks, 20-second request limit, at most 64 output tokens per request. Optional `suite` values select versioned synthetic cases:

| Suite | Cases per model | Deterministic check |
| --- | --- | --- |
| `availability-v1` | 1 | Exact `OK` response. |
| `text-v1` | 1 | Exact requested literal. |
| `json-v1` | 1 | Parse JSON and verify the exact property/value. |
| `instructions-v1` | 2 | Ordered output and a constrained numeric answer. |

These suites test textual responses; JSON mode/native structured-output support is not implied. Tool-calling cases are deferred because no trusted backend capability declaration is implemented. Each result reports its case, deterministic pass/fail, success/degraded/error status, response, latency, reported model, and usage when supplied. A failing case does not stop subsequent cases. Reports include suite version, timestamp, sample count and explicit unknown variability/physical model identity; they make no general quality guarantee. Project source and arbitrary user prompts are never sent.

Private reports are stored in the `reports/` subdirectory, isolated from the ownership plan ledger. Reports never trigger combo changes. Preserve them as evidence; publication excludes private runtime directories.

Requests consume quota and may cost money. `max_test_models` and the allowlist remain enforced for every suite; `instructions-v1` uses up to 128 output tokens across two requests per model. `allow_tests` is false by default. Optional provider `limits` add shared attempt/request/token reservations across cooperating processes; without them only per-call probe bounds apply. These are not monetary budgets. See [operations](OPERATIONS.md). Backend aliases/account fallback may still apply; `reported_model_matches_request` compares identifiers, not physical identity. One synthetic run does not measure model variability or general reasoning, tool, multimodal, or account quality.

## Português

Habilite a gestão somente no arquivo privado do usuário. `consumers` identifica rotas de outras CLIs sem expor seus arquivos completos; todos os combos externos ficam protegidos. Atualizações criam uma nova versão sem sobrescrever o combo anterior ou alterar configurações de CLIs.

`test_combo` testa os modelos individualmente, inclusive de combos externos. Exige permissão, IDs autorizados e limites por chamada. Mantém `availability-v1` como padrão e oferece `text-v1`, `json-v1` e `instructions-v1`; cada caso usa até 64 tokens e 20 segundos, sem repetição ou fallback pelo MCP. A suíte de instruções executa dois casos por modelo. Relatórios privados ficam em `reports/`, fora do ledger de propriedade, e não alteram combos automaticamente. Os resultados sintéticos não garantem qualidade geral nem medem variabilidade. Testes de ferramentas permanecem adiados por falta de declaração confiável de capacidade.

Revisões `canonical-v1` preservam todos os campos relevantes recebidos e ignoram somente a ordem das propriedades. Estado 0.5.0 continua utilizável quando o hash original confere ou é reconstruível com segurança; registros não são regravados em massa. Configuração desconhecida ou alterada impede adoção. Para usar uma versão, informe projeto e combo juntos. Orçamentos compartilhados são opcionais e precisam estar configurados no provider; veja [operação e recuperação](OPERATIONS.md).

## Upstream contracts

- https://github.com/decolua/9router/blob/master/src/app/api/combos/route.js
- https://github.com/decolua/9router/blob/master/src/lib/db/repos/combosRepo.js
- https://github.com/diegosouzapw/OmniRoute/blob/main/src/app/api/combos/route.ts
- https://github.com/diegosouzapw/OmniRoute/blob/main/src/lib/api/requireManagementAuth.ts
