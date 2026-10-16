# Local operations

This describes the implementation in this checkout. It does not certify a running deployment or imply that an already installed npm version contains these changes. Reload the MCP connection after updating code or private configuration.

## Diagnostics and inspection

Use the `diagnose` tool or `node dist/index.js --diagnose` for an offline report of loaded version, runtime, agent/provider schemas, credential presence, and private state-directory access. It does not create directories, contact a backend, run inference, or reveal credential values and private endpoints. `list_models` and catalog-mode `health_check` are separate network operations; inference-mode health checks explicitly consume quota.

`inspect_state` reports job ownership/known corruption, configured budget reservations, and read-only lock inventories for workflows, combos, and budgets without adopting jobs, deleting locks, or replaying calls. A lock's owner is reported as unknown; its presence or age does not establish a dead owner. Preserve the original state before recovery. Inspect exact job/lock IDs, the actual owner process, services, and backend outcome. An unknown owner or timeout is not permission to kill, retry, adopt, or remove a lock. No automatic recovery mutation or deletion-by-age is provided.

## Optional shared budgets

Configure limits in a private provider profile; inference-only profiles without `limits` remain valid:

```yaml
providers:
  local:
    base_url: http://127.0.0.1:8000/v1
    api_key_env: INFERENCE_KEY
    max_input_chars: 2000000
    max_output_tokens: 65536
    max_response_bytes: 2000000
    limits:
      window_ms: 3600000
      max_concurrent: 2
      max_requests: 100
      max_reserved_tokens: 1000000
      # Optional project restriction: every invocation then needs an allowed project.
      projects:
        my-project:
          max_concurrent: 1
          max_requests: 30
          max_reserved_tokens: 300000
```

Set `MULTIAGENTS_BUDGETS_DIR` to the same private absolute directory in all cooperating MCP processes. It defaults to `.budgets` beside job state. The shared identity includes provider ID and base URL: aliases, different directories, or different endpoint spelling do not form one global quota. All cooperating processes must use the same policy. Calls through profiles without configured limits are not covered.

Configured reservations cover synchronous delegation, job execution, combo probes, and inference health checks at the provider boundary. Each actual attempt reserves one request and **serialized request bytes plus the requested maximum output tokens**. This is a conservative accounting unit, not exact tokenizer usage or money. Usage reported by the backend is separate; reservations are not refunded based on reported usage. Each retry/fallback consumes another reservation. Denied reservations stop that attempt before the external request.

File locks serialize state changes across cooperating processes. Active and uncertain leases count against concurrency. Uncertain operations keep their lease; a time-window rollover resets request/token counters, not these leases. Inspect owner and backend outcome before manual reconciliation. A surviving lock is never removed by TTL. These controls are not a monetary spending guarantee or isolation from other clients that bypass this MCP.

Project caps apply only when configured, and then missing/unknown projects are denied. Combo-bound invocation passes its validated project into accounting. An ordinary configured agent may declare `project_id` in its private agent configuration. Setting the legacy default provider through environment variables alone does not enable a budget; configure an explicit provider profile for this feature.

`MULTIAGENTS_MAX_QUEUED_JOBS` defaults to 1000 and bounds the local process's queued jobs. It is separate from shared request/concurrency limits and is not a shared queue capacity across processes.

## History and client output

Terminal job summaries use reconstructible `.meta` sidecars to avoid loading complete prompts/results at normal startup. Original job JSON remains authoritative. Missing/stale sidecars fall back to reading the original record; older files are not bulk-rewritten on startup. Preserve both originals and metadata during investigation; no history pruning is implicit.

`list_agent_tasks` accepts `limit` (1–100, default 20) and `offset` (default 0). `get_agent_task` accepts `include_content` (default true), character `offset` (default 0), and `limit` (1–100000, default 16000). Follow `next_content_offset` until null to retrieve complete content; `content_truncated` explicitly reports a page boundary. Use `include_content:false` for status only. Stored content is preserved rather than silently shortened to the response page.

Tools advertise output schemas and retain textual plus structured responses. Synchronous delegation emits progress only when the client supplies a `progressToken`; job polling remains available. Progress does not promise a percentage or continue after a synchronous request ends. [Experimental Tasks](TASKS-COMPATIBILITY.md) remain a test-only compatibility spike.

## Platforms and release boundaries

Private-state operations are validated for Linux/WSL. Strong Linux process ownership uses process identity rather than PID existence alone. Unknown identity fails closed. Native Windows ACL privacy and complete Windows/macOS lifecycle behavior are not certified; do not treat POSIX mode bits as a Windows ACL audit.

The optional [release workflow](RELEASING.md) is preparation only until an operator configures the external npm trust and protected GitHub environment. Local fixture tests are not proof of live OIDC publication or backend compatibility.

## Português brasileiro

`diagnose` e `--diagnose` verificam a configuração offline, sem rede, inferência ou exposição de credenciais. `inspect_state` inspeciona propriedade, reservas e inventários de locks de workflows/combos/orçamentos sem recuperar, apagar locks ou repetir operações. A propriedade dos locks permanece desconhecida. Preserve o estado e confirme proprietário e resultado no backend antes de reconciliar falhas incertas.

Orçamentos são opcionais em `providers.<id>.limits`. Processos precisam compartilhar diretório privado, ID/endpoint e política. Reservas contabilizam requisições e bytes serializados de entrada somados ao limite de tokens de saída; não representam uso exato de tokens nem custo monetário. Cada tentativa consome reserva. Operações incertas continuam ocupando concorrência mesmo após mudar a janela. Perfis sem `limits` permanecem sem esses tetos compartilhados.

O histórico preserva os JSONs originais e usa metadados reconstruíveis para carregamento leve. Listagens aceitam paginação; a consulta de conteúdo retorna limites e próximo offset explicitamente. Progresso depende de `progressToken` do cliente. Tasks continuam experimentais nos testes, sem migração da execução.

Linux/WSL é o escopo validado para estado privado. Windows nativo, integração Tasks com clientes reais e publicação OIDC não foram certificados por esses testes locais. Veja também [combos](COMBOS.md) e [procedimento de release](RELEASING.md).
