# MULTIAGENTS-MCP

[![CI](https://github.com/SanNw/multi-agents-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SanNw/multi-agents-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/multiagents-mcp)](https://www.npmjs.com/package/multiagents-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Give your MCP client a configurable team of AI agents, persistent jobs, reviewed workflows, and project-specific model combos.**

Use your own models through OpenAI-compatible Chat Completions backends. Keep your main assistant in control while specialized agents analyze code, propose changes, review evidence, or handle editorial tasks.

[English](#english) · [Português brasileiro](#português-brasileiro)

## English

### What can you do with it?

- Ask one agent to investigate a problem and another to review the proposed solution.
- Run independent jobs concurrently within per-agent limits, inspect partial output, and retain results between sessions.
- Turn a larger task into explicit workflow steps with acceptance criteria, review gates, and recorded execution evidence.
- Create a model combo for a project without overwriting routes used by another CLI.
- Test individual models inside an existing combo to identify which respond, fail, or return degraded output.
- Use different configured backends for different agents without changing your MCP client's primary model.

**You define the team.** Agent names, roles, model IDs, providers, fallbacks, and permissions belong to your private configuration. No personal profiles, subscriptions, or author-specific model combos are required.

> Project combo management and individual member probes require **0.5.0 or later**. Older installations can keep their existing inference-only profiles.

### Features

| Capability | What it provides |
| --- | --- |
| Custom agents | Your IDs, instructions, semantic roles, model routes, timeouts, output limits, and per-agent concurrency. |
| Multiple backends | Separate provider profiles and credentials; OpenAI-compatible textual Chat Completions and optional SSE streaming. |
| Task routing | Deterministic selection from task type, complexity, file count, context, and security signals. Explicit `agent` or `@id` selection takes precedence. |
| Persistent jobs | Synchronous calls or queued asynchronous tasks with partial output, checkpoints, history, cancellation, and explicit retries. |
| Resilient inference | Configured fallbacks, round-robin route selection, transient-error handling, circuit breakers, and attempt telemetry. |
| Output checks | Truncation/degradation reporting, optional exact-response checks, minimum output length, and expected Markdown ID coverage. |
| Reviewed workflows | Up to eight explicit steps, acceptance criteria, carried-forward evidence, proposal approval, execution-result recording, and replanning. |
| Project combos | Discover backend combos, plan changes, and create owned versions under explicit project/model permissions. Adapters cover 9Router and OmniRoute API contracts. |
| Protection for other CLIs | Read declared JSON configurations for route references, mark external/shared combos as protected, and replace combos by creating new versions. |
| Individual model probes | Test members directly with a fixed prompt, bounded output, latency/error reporting, and zero MCP retries or fallbacks. |
| Observability | Requested/selected route, backend-reported model, elapsed time, usage when supplied, attempt history, and structured errors. |
| Local deployment | MCP stdio transport, private state, no additional hosted orchestration service, and no changes to the client's main model. |

### Install from npm

Requires Node.js **>=20.11** and a configured backend. In Codex, use:

```toml
[mcp_servers.multiagents-mcp]
command = "npx"
args = ["--yes", "--package=multiagents-mcp@^0.5.0", "multiagents-mcp"]
```

Add the private environment settings shown below, including your agent file, backend URL, credentials, and state directories. The example agent YAML below can be saved directly to your private agent file. Restart or reload the MCP connection after configuration changes.

### Or install from source

Requires Node.js **>=20.11**. CI tests Node 20 and 24.

```bash
git clone https://github.com/SanNw/multi-agents-mcp.git
cd multi-agents-mcp
npm ci
npm run build
```

Copy `config/agents.example.yaml` to a private location. Replace placeholder model IDs with IDs or aliases accepted by your backend. Rename, add, or remove agents freely:

```yaml
agents:
  builder:
    route: your-model-id
    role: software_development
    task_kinds: [development]
    description: Proposes code and tests using the context supplied by the client.
    route_strategy: fallback
  reviewer:
    route: your-review-model-id
    role: architecture_and_review
    task_kinds: [architecture]
    description: Reviews architecture, implementation risks, and test evidence.
```

Supported task kinds are `development`, `architecture`, `documentation`, `translation`, and `philology`. If no specialization matches, routing selects the first configured agent. Complex tasks suggest review/implementation/review only when those roles exist.

Example configuration for Codex; use absolute paths and your actual private values:

```toml
[mcp_servers.multiagents-mcp]
command = "node"
args = ["/absolute/path/to/multi-agents-mcp/dist/index.js"]

[mcp_servers.multiagents-mcp.env]
AGENTS_CONFIG = "/absolute/path/to/private/agents.yaml"
MULTIAGENTS_BASE_URL = "http://127.0.0.1:8000/v1"
MULTIAGENTS_API_KEY = "your-private-key"
MULTIAGENTS_JOBS_DIR = "/absolute/path/to/private/jobs"
MULTIAGENTS_WORKFLOWS_DIR = "/absolute/path/to/private/workflows"
MULTIAGENTS_COMBOS_DIR = "/absolute/path/to/private/combos"
```

Other MCP clients use the same command, arguments, and environment values. The server does not load `.env` automatically. Without `AGENTS_CONFIG`, it loads the generic example: its placeholder routes must be replaced before inference. `TECHNICAL_AGENTS_CONFIG` is an optional explicit second agent file.

For multiple backends, copy `config/providers.example.yaml`, keep the profiles you use, and set `MULTIAGENTS_PROVIDERS_CONFIG` to your private copy. Set each agent's `provider`. Legacy `NINEROUTER_URL` and `NINEROUTER_KEY` remain supported. See [provider configuration](docs/PROVIDERS.md).

### Examples

Ask your MCP client to:

> “List the configured agents, route this architecture review to an appropriate agent, and submit it as an asynchronous job. Show its progress and final findings.”

> “Create a workflow with diagnosis, implementation proposal, and review steps. Require concrete evidence before accepting each step.”

> “List this backend's combos and known CLI references. Plan a separate combo for this project using only permitted models. Keep existing routes unchanged.”

> “Test these members of the existing combo individually. Report which respond, their latency, and any failures. Do not edit the combo.”

The client must translate these requests into the tools below. Agents receive the context supplied by the client; they do not automatically gain filesystem or shell access.

### All 23 MCP tools

| Tool | Purpose |
| --- | --- |
| `list_agents` | Inspect configured roles, routes, and execution policies. |
| `list_providers` | Inspect backend profiles and declared management capabilities. |
| `list_models` | List configured or remotely advertised model IDs with provenance. |
| `health_check` | Inspect a model catalog or explicitly run an inference probe. |
| `route_task` | Select an agent without running inference. |
| `delegate_agent` | Run a short synchronous task. |
| `submit_agent_task` | Queue a persistent asynchronous task. |
| `submit_routed_task` | Route and queue a task with structured state. |
| `get_agent_task` | Inspect partial or final task output and telemetry. |
| `list_agent_tasks` | Inspect recent task history. |
| `cancel_agent_task` | Cancel a task owned by the current process. |
| `retry_agent_task` | Explicitly retry a task that ended without success. |
| `create_workflow` | Persist explicit steps and acceptance criteria. |
| `get_workflow` | Inspect workflow status and evidence. |
| `advance_workflow` | Advance an eligible step or collect its job result. |
| `approve_workflow_action` | Record approval/rejection of a model proposal. |
| `record_workflow_action` | Record what the client actually executed. |
| `review_workflow_step` | Accept/block a step based on supplied evidence. |
| `replan_workflow` | Revise a blocked workflow while preserving its history. |
| `list_combos` | Inspect combos, ownership, protection, and known consumers. |
| `plan_combo` | Persist a validated project-combo proposal without backend writes. |
| `apply_combo_plan` | Create/read back an authorized combo version; reconcile uncertain creation. |
| `test_combo` | Probe selected individual members without changing the combo. |

### Combos without breaking another CLI

Management is disabled unless configured. A private policy specifies project IDs, model allowlists, write/test permissions, and per-call limits. Administrative credentials are explicitly configured separately from inference credentials.

Existing combos are external and protected unless ownership is established through this MCP's persisted records. Optional `consumers` entries read only declared JSON files and extract `model`/`small_model` references. Unreadable files are reported; missing references never prove the absence of consumers.

**Updates create a new uniquely named version.** The server never overwrites/deletes an existing combo, changes global routing settings, rewrites agent files, or switches another CLI's primary model. Use the new version explicitly with `project_id` and `combo_id` on a task or workflow step.

`test_combo` sends each selected member a fixed control prompt, sequentially, with up to **64 output tokens**, a **20-second request limit**, and **zero MCP retries/fallbacks**. It requires `allow_tests`, a model allowlist, and a configurable maximum member count. Tests consume quota and may cost money; they check response availability, not general model quality. Backend alias/account fallback can still occur.

Full configuration and recovery details: [project combos and probes](docs/COMBOS.md).

### Execution and security boundaries

The local client supplies source/context, applies patches, executes commands, and checks real results. Delegated models produce proposals. Workflow approval does not grant operating-system permissions or execute a proposed command.

Combo tools are a separate, narrow administrative capability: configured management requests can create new combos, while `test_combo` can consume inference quota. No arbitrary shell or backend-database editor is provided.

Catalog access is not proof of successful inference, model quality, subscription access, or price. Generic Chat Completions compatibility does not imply native Anthropic/Gemini/Responses support or administrative API support. State may contain private prompts and evidence; keep it outside public repositories. This server assumes a trusted local MCP client, not multi-tenant isolation.

See [security](SECURITY.md), [workflow details](docs/WORKFLOWS.md), and the [security assessment](docs/SECURITY_ASSESSMENT.md).

### Development and packaging

```bash
npm test
npm run release:prepare
npm pack --dry-run --ignore-scripts
```

Release preparation stages an explicit allowlist for review; it does not publish. Private agents, credentials, jobs, workflows, combo plans, snapshots, and runtime data stay out of the public package.

---

## Português brasileiro

### Para que serve?

O MULTIAGENTS-MCP permite que seu cliente MCP trabalhe com **uma equipe de agentes configurada por você**, mantendo tarefas persistentes, fluxos com revisão e combos de modelos por projeto.

Você pode distribuir diagnóstico, proposta de implementação e revisão entre agentes diferentes; acompanhar trabalhos longos; exigir evidências antes de avançar; e escolher modelos de backends distintos sem trocar o modelo principal do seu assistente.

Os nomes, papéis, modelos, provedores, fallbacks e permissões são seus. Não há dependência de perfis pessoais do autor.

> A gestão de combos e os testes individuais exigem a versão **0.5.0 ou superior**. Configurações anteriores de inferência continuam compatíveis.

### Funcionalidades

| Recurso | Utilidade |
| --- | --- |
| Agentes personalizados | Defina IDs, instruções, especializações, rotas, limites e concorrência. |
| Múltiplos backends | Separe provedores e credenciais; use Chat Completions compatível com OpenAI e streaming SSE opcional. |
| Roteamento de tarefas | Selecione agentes por tipo, complexidade e contexto, ou indique explicitamente `agent`/`@id`. |
| Jobs persistentes | Execute tarefas síncronas ou assíncronas, acompanhe saída parcial e preserve checkpoints, resultados e histórico. |
| Resiliência | Configure fallbacks, round-robin, tratamento de erros transitórios e circuit breakers. |
| Verificação de saída | Identifique truncamento, respostas degradadas e falhas de cobertura de IDs ou texto esperado. |
| Workflows revisados | Organize até oito etapas explícitas com critérios de aceitação, revisão, evidências e replanejamento. |
| Combos por projeto | Descubra combos, planeje criações e gere versões próprias usando os contratos de API do 9Router e OmniRoute. |
| Proteção de outras CLIs | Identifique referências em arquivos declarados e preserve combos externos e versões anteriores. |
| Testes individuais | Verifique cada modelo de um combo, com resposta, latência, erro e uso informado pelo backend. |
| Observabilidade | Confira rota solicitada/selecionada, modelo reportado, tentativas e consumo quando disponível. |
| Execução local | Use MCP stdio com estado privado, sem serviço adicional de orquestração hospedado. |

### Como começar

1. Instale Node.js >=20.11. Use a configuração com `npx` mostrada na instalação pelo npm ou clone o repositório e execute `npm ci` e `npm run build`.
2. Copie `config/agents.example.yaml` para um arquivo privado, troque os placeholders por IDs reais e defina seus agentes.
3. Configure o cliente MCP com `node`, o caminho absoluto de `dist/index.js` e as variáveis mostradas na configuração em inglês.
4. Defina diretórios privados para jobs, workflows e combos. O servidor não carrega `.env` automaticamente.
5. Para vários backends, configure `MULTIAGENTS_PROVIDERS_CONFIG` e associe cada agente ao seu `provider`.

Na instalação pelo npm, use `npx` como comando do cliente; na instalação pelo código-fonte, use `node` com o caminho de `dist/index.js`. Recarregue a conexão MCP depois de alterar a configuração.

Nenhum nome de agente é obrigatório. Há especializações de desenvolvimento, arquitetura, documentação, tradução e filologia, mas você escolhe quais utilizar. O agente recebe os trechos fornecidos pelo cliente; não ganha acesso automático ao seu computador.

### Exemplos de uso

> “Peça um diagnóstico a um agente e uma revisão independente a outro. Mostre as divergências antes de propor alterações.”

> “Organize diagnóstico, proposta de correção e revisão em um workflow. Só avance quando houver evidências.”

> “Veja os combos e as referências de outras CLIs. Planeje um combo separado para este projeto com meus modelos permitidos.”

> “Teste individualmente os modelos deste combo e mostre quais responderam e quais falharam, sem modificá-lo.”

### Ferramentas disponíveis

- **Descoberta:** `list_agents`, `list_providers`, `list_models`, `health_check`.
- **Delegação e jobs:** `route_task`, `delegate_agent`, `submit_agent_task`, `submit_routed_task`, `get_agent_task`, `list_agent_tasks`, `cancel_agent_task`, `retry_agent_task`.
- **Workflows:** `create_workflow`, `get_workflow`, `advance_workflow`, `approve_workflow_action`, `record_workflow_action`, `review_workflow_step`, `replan_workflow`.
- **Combos e testes:** `list_combos`, `plan_combo`, `apply_combo_plan`, `test_combo`.

### Proteção de rotas e testes

A gestão exige habilitação explícita no arquivo privado. Você determina projetos, modelos autorizados e permissões de criação, atualização e teste. Credenciais administrativas são separadas das de inferência.

Combos externos são protegidos. A descoberta de consumidores lê apenas arquivos JSON declarados e extrai referências de modelo. **Uma atualização cria outra versão com nome único:** o combo anterior continua intacto, inclusive para consumidores desconhecidos. Nenhuma configuração de OpenCode ou outra CLI é reescrita.

Para usar uma versão nova, informe `project_id` e `combo_id` na tarefa ou etapa do workflow. Jobs revalidam a seleção antes de executar, inclusive em novas tentativas.

`test_combo` testa membros diretamente, em sequência, com prompt fixo, até 64 tokens de saída e 20 segundos por requisição, sem fallback/repetição pelo MCP. Exige autorização e limite de modelos por chamada. Consome cota e pode gerar custo; mede disponibilidade e resposta de controle, não qualidade geral. O próprio backend ainda pode resolver aliases ou trocar contas.

Configuração, permissões e recuperação: [combos e testes](docs/COMBOS.md).

### Limites importantes

O cliente controla os arquivos e comandos locais; os agentes produzem propostas. Aprovar uma ação no workflow não executa o comando nem concede permissões do sistema.

As ferramentas administrativas de combos executam somente as operações específicas autorizadas na política privada. Acesso ao catálogo não comprova inferência, assinatura, preço ou qualidade. Compatibilidade com Chat Completions não garante outros protocolos ou APIs administrativas.

Mantenha prompts, estado e credenciais fora de repositórios públicos. O servidor foi projetado para um cliente local confiável, não para isolamento entre usuários.

[Provedores](docs/PROVIDERS.md) · [Workflows](docs/WORKFLOWS.md) · [Combos](docs/COMBOS.md) · [Segurança](SECURITY.md)

## License

MIT. See [LICENSE](LICENSE).
