# MULTIAGENTS-MCP

[English](#english) | [Portugues do Brasil](#portugues-do-brasil)

## English

### Purpose and Responsibilities

MULTIAGENTS-MCP is a **stdio Model Context Protocol server for specialized AI delegation and persistent, reviewed workflows**. It connects an MCP client such as Codex to gateways implementing OpenAI Chat Completions, including 9Router, OmniRoute, and compatible endpoints.

It organizes model access into roles, routes tasks, tracks asynchronous jobs, and preserves decisions and evidence across steps. It is not an autonomous shell, a model host, or a replacement for Codex.

| Component | Responsibility |
| --- | --- |
| Codex or another MCP client | Reads actual files, selects context, reviews proposals, applies authorized changes, runs commands/tests, and records observed results. |
| MULTIAGENTS-MCP | Loads agent policies and profiles, selects routes, submits inference, persists jobs/workflows, and controls review transitions. |
| Gateway | Resolves model, alias, or combo IDs and forwards authenticated requests to connected providers. |
| Delegated model | Produces analysis, code, documentation, or proposed actions from supplied context. It has no independent access to the client's filesystem or shell. |

For example, Codex can ask Sasuke to diagnose a bug, Naruto to propose a patch, and Sasuke to review the actual test evidence. Codex remains responsible for applying and testing the patch. The MCP never executes model-generated commands.

### Roles and Routing

| Agent | Role |
| --- | --- |
| `naruto` | Software implementation, fixes, and tests. |
| `sasuke` | Architecture, complex debugging, and critical review. |
| `sakura` | Technical assistance, documentation, and supporting tasks. |
| `translator_a`, `translator_b` | Independent translation proposals. |
| `philologist` | Original-language morphology, syntax, terminology, and ambiguities. |
| `translation_critic` | Adversarial review of omissions, additions, and unsupported readings. |
| `portuguese_editor` | Brazilian Portuguese editing while preserving meaning. |

`route_task` considers task type, complexity, files, context, and security signals. An explicit `agent` field or leading `@naruto`, `@sasuke`, or `@sakura` selects a role manually. These prefixes are task text interpreted by the router, not native Codex commands. Editorial tasks retain their separate roles.

The included technical agents use `default` with the original 9Router combo IDs `Naruto`, `Sasuke`, and `Sakura`. Agents and routes are configurable. The MCP does not create combos or change the client's primary provider/model.

### Backend Profiles

Profiles isolate endpoints, API-key environment variables, declared streaming capabilities, catalogs, and circuit state. Agents can use different gateways; fallback routes stay within an agent's profile. A route is an existing backend ID: a model, alias, combo, or automatic route.

For one backend, set `MULTIAGENTS_BASE_URL` and `MULTIAGENTS_API_KEY` in the MCP process environment. Legacy `NINEROUTER_URL` and `NINEROUTER_KEY` remain supported. An explicitly configured generic URL does not inherit the legacy key.

To add OmniRoute without replacing existing 9Router roles, create a private YAML file:

```yaml
providers:
  omniroute:
    base_url: http://127.0.0.1:20129/v1
    api_key_env: OMNIROUTE_API_KEY
    protocol: openai-chat-completions
    streaming: true
```

Set `MULTIAGENTS_PROVIDERS_CONFIG` to that file and provide `OMNIROUTE_API_KEY` to the process. `api_key_env` is the variable name, never the literal secret. Select `provider: omniroute` only in agents intended to use that gateway. Every declared profile requires its credentials at startup.

Inference supports text Chat Completions over HTTP(S), including SSE responses. Native Anthropic, Gemini, and OpenAI Responses adapters are not implemented; use a gateway that normalizes those APIs. **Inference SSE is not MCP transport:** this server communicates with its client over stdio, not an HTTP/SSE MCP endpoint. See [backend profiles](docs/PROVIDERS.md), currently in Portuguese.

### Tool Reference

| Tools | Function |
| --- | --- |
| `health_check`, `list_agents`, `list_providers` | Inspect roles/profiles and check catalogs or selected-agent inference. Catalog access alone does not prove inference availability. |
| `delegate_agent` | Request a delegated response directly. |
| `submit_agent_task`, `get_agent_task` | Submit asynchronous work and inspect persisted status, checkpoints, and results. |
| `cancel_agent_task`, `retry_agent_task` | Cancel a tracked job or explicitly request another attempt. |
| `route_task`, `submit_routed_task`, `list_agent_tasks` | Select a role, submit routed work, and inspect task history. |
| `create_workflow`, `get_workflow`, `advance_workflow` | Define, inspect, and advance a persistent multi-step plan. |
| `approve_workflow_action`, `record_workflow_action` | Record review of proposed actions and the client's actual execution evidence. |
| `review_workflow_step`, `replan_workflow` | Accept/reject an evidenced step or explicitly revise a blocked plan. |

### Workflow Lifecycle

1. Call `create_workflow` with explicit steps, assigned agents, context, and acceptance criteria. Creation does not run inference.
2. `advance_workflow` submits the current step. Poll its job with `get_agent_task`; another advance collects its result. `get_workflow` only reads state.
3. The model returns structured proposals. The client validates each action and records approval or rejection. Approval is a workflow decision, not system permission or user authorization.
4. The client executes permitted actions using its own tools and calls `record_workflow_action` with real results. The MCP never executes the proposed reads, patches, or commands.
5. Review the step against its acceptance criteria. Acceptance prepares the next step without submitting it. Failed/rejected actions prevent acceptance; blocked plans require explicit replanning.

Checkpoints preserve jobs, proposals, decisions, and evidence. Identical action results are idempotent; conflicting replacements are rejected. Recorded evidence is not independent attestation or a substitute for inspecting real files.

Workflows allow up to eight steps/eight total inferences and two plan revisions. Each workflow inference has a maximum 180-second timeout, 4,000 output tokens, and zero retries. Failure, degraded output, or invalid JSON blocks the flow instead of automatically repeating steps. An uncertain interrupted submission blocks rather than being duplicated. There is no exactly-once guarantee for external effects. See the [workflow guide](docs/WORKFLOWS.md), currently in Portuguese.

### Installation and Codex Setup

Requirements: Linux or WSL, Node.js >=20.11, npm, and a reachable compatible backend. Native Windows and macOS are not supported in this version because job ownership uses Linux `/proc` and boot IDs. On Windows, run the MCP in WSL. Agent route IDs must exist in your backend.

```bash
git clone https://github.com/SanNw/multi-agents-mcp.git
cd multi-agents-mcp
npm ci
npm test
npm start
```

`npm test` builds TypeScript through its pretest hook; `npm start` uses `dist/index.js`. Configure the backend environment before starting. The server does not automatically load `.env`. Use a machine with adequate resources for installation; documentation changes do not require rebuilding an existing runtime.

Use the real absolute paths of your checkout and Linux Node executable:

```toml
[mcp_servers.multiagents-mcp]
command = "/usr/bin/node"
args = ["/path/to/multi-agents-mcp/dist/index.js"]
env_vars = ["MULTIAGENTS_BASE_URL", "MULTIAGENTS_API_KEY", "OMNIROUTE_API_KEY"]
startup_timeout_sec = 30
tool_timeout_sec = 660

[mcp_servers.multiagents-mcp.env]
AGENTS_CONFIG = "/path/to/multi-agents-mcp/config/agents.yaml"
TECHNICAL_AGENTS_CONFIG = "/path/to/multi-agents-mcp/config/technical-agents.yaml"
# Optional; enable only when profile credentials are available:
# MULTIAGENTS_PROVIDERS_CONFIG = "/path/to/private/providers.yaml"
MULTIAGENTS_JOBS_DIR = "/path/to/private-state/jobs"
MULTIAGENTS_WORKFLOWS_DIR = "/path/to/private-state/workflows"
```

The existing `9router-agent` registration remains valid; do not duplicate it just to rename it. Desktop and CLI can use different `CODEX_HOME` directories. Inspect the active configuration and reload MCP connections safely after changes. Do not invoke `wsl.exe` from Linux or assume `localhost` reaches a gateway on another host.

### Reliability and Security

Delegation uses bounded retries and circuit breakers. Authentication failures are not retried automatically. Interrupted streams preserve partial output without automatic replay. Missing telemetry stays `null`; reported model names may be aliases. The MCP cannot repair upstream outages or guarantee model quality, quota, cost, or latency.

Jobs/workflows may contain context and model output: keep their directories private and exclude them from publication. Never send confidential material or credentials without authorization. Check connected-provider billing policies before inference. Do not remove stale locks without checking ownership and consumers. Read [SECURITY.md](SECURITY.md).

### Tests and Publication

CI tests Node 20 and 24 without external credentials or upstream inference. Coverage includes role selection, profile isolation, HTTP/SSE, retry/circuit behavior, persistent jobs, workflow transitions, real local stdio MCP integration, and publication filtering.

```bash
npm test
npm run release:prepare
```

Release preparation copies only allowlisted public files into `release/`, creates a SHA-256 manifest, and checks defensively for secrets/personal paths. It excludes Git metadata, jobs, workflows, outputs, and global configurations. Review the result: these checks are not a complete security audit. The npm package uses a separate `files` allowlist for compiled runtime, example configuration, and documentation.

For npm installations, use `npm install -g multiagents-mcp` and configure your MCP client to run `multiagents-mcp`, or use `npx --yes multiagents-mcp@0.4.1`. The package includes compiled JavaScript; consumers do not need TypeScript or a build. Provide backend credentials through the process environment. Default agent files resolve inside the installed package; set absolute private job/workflow directories to avoid storing state in the caller's working directory.

Licensed under [MIT](LICENSE). Conceptually inspired by [ManusMCP](https://github.com/mantrakp04/manusmcp); no executor, framework, or dependency from that stack was incorporated.

---

## Portugues do Brasil

### Funcao e responsabilidades

O MULTIAGENTS-MCP organiza modelos por papeis, encaminha tarefas, acompanha jobs
assincronos e preserva decisoes e evidencias entre etapas. As responsabilidades
sao separadas:

| Componente | Responsabilidade |
| --- | --- |
| Codex ou outro cliente MCP | Le arquivos reais, escolhe contexto, revisa propostas, aplica alteracoes autorizadas e executa comandos/testes. |
| MULTIAGENTS-MCP | Carrega politicas e perfis, seleciona rotas, submete inferencias, persiste jobs/workflows e controla transicoes de revisao. |
| Gateway | Resolve modelos, aliases e combos e encaminha requisicoes autenticadas aos providers. |
| Modelo delegado | Produz analise, codigo, documentacao ou propostas com o contexto recebido, sem acesso proprio ao filesystem ou shell. |

Exemplo: Sasuke diagnostica um bug, Naruto propoe um patch e Sasuke revisa as
evidencias dos testes. O Codex aplica e testa: o MCP nao executa comandos gerados
pelo modelo nem altera o provider principal do cliente.

Servidor MCP stdio para delegacao especializada e workflows com revisao humana.
Compativel com gateways OpenAI Chat Completions: 9Router, OmniRoute e endpoints
equivalentes. Perfis isolam conexoes, chaves e capacidades por agente. O
Codex permanece orquestrador e executor local; os agentes fornecem propostas,
codigo e analises. Nao e um shell autonomo nem um substituto do Codex.

## Requisitos

Linux ou WSL, Node.js >=20.11, npm e acesso a um backend OpenAI-compatible.
Windows nativo e macOS nao sao suportados nesta versao: propriedade de jobs
usa /proc e boot ID Linux. Os combos devem corresponder aos IDs configurados
em config/agents.yaml e config/technical-agents.yaml, ou a seus arquivos personalizados.

```bash
npm ci
npm test
npm run build
# Configure o backend default e sua chave por seu mecanismo privado de ambiente.
# Para backends adicionais, configure o perfil opcional abaixo.
npm start
```

O servidor nao carrega .env automaticamente. No WSL, use a URL acessivel do
host onde seu gateway roda; nao assuma localhost em toda configuracao de rede.

Os agentes tecnicos incluidos usam default (9Router), nos combos Naruto,
Sasuke e Sakura. Para adicionar OmniRoute sem substituir esses combos, crie
seu arquivo privado de perfis e defina MULTIAGENTS_PROVIDERS_CONFIG com seu caminho:

```yaml
providers:
  omniroute:
    base_url: http://127.0.0.1:20129/v1
    api_key_env: OMNIROUTE_API_KEY
    protocol: openai-chat-completions
    streaming: true
```

Forneca OMNIROUTE_API_KEY ao processo sem escrever o segredo no YAML e selecione
provider: omniroute somente nos agentes que devem usar esse gateway.
api_key_env e o nome da variavel, nunca seu valor. O perfil default e preservado
para os agentes editoriais. Para usar somente outro gateway, personalize as
rotas e remova provider dos agentes, que entao usarao default.

## Configurar no Codex

Use os caminhos absolutos reais do seu checkout e do Node Linux:

```toml
[mcp_servers.multiagents-mcp]
command = "/usr/bin/node"
args = ["/path/to/MULTIAGENTS-MCP/dist/index.js"]
env_vars = ["MULTIAGENTS_BASE_URL", "MULTIAGENTS_API_KEY", "OMNIROUTE_API_KEY"]
startup_timeout_sec = 30
tool_timeout_sec = 660

[mcp_servers.multiagents-mcp.env]
AGENTS_CONFIG = "/path/to/MULTIAGENTS-MCP/config/agents.yaml"
TECHNICAL_AGENTS_CONFIG = "/path/to/MULTIAGENTS-MCP/config/technical-agents.yaml"
# Opcional, requer OMNIROUTE_API_KEY no ambiente:
# MULTIAGENTS_PROVIDERS_CONFIG = "/path/to/private/providers.yaml"
MULTIAGENTS_JOBS_DIR = "/path/to/private-state/jobs"
MULTIAGENTS_WORKFLOWS_DIR = "/path/to/private-state/workflows"
```

Nao invoque wsl.exe de dentro de Linux. Desktop e CLI podem carregar CODEX_HOME
diferentes: verifique o processo real e as ferramentas expostas. Recarregue MCPs
ou reabra o cliente apos alterar configuracao, sem encerrar trabalho ativo.
Handshake e catalogo nao comprovam inferencia nem suporte a namespaces Responses.

Variaveis NINEROUTER_* e registro 9router-agent permanecem compativeis com
instalacoes anteriores. [Perfis e backends](docs/PROVIDERS.md) explica conexoes
simultaneas, isolamento de chaves e configuracao de rotas/combo IDs por agente.

## Agentes e ferramentas

| Agente | Funcao |
| --- | --- |
| `naruto` | Implementacao, correcoes e testes. |
| `sasuke` | Arquitetura, depuracao complexa e revisao critica. |
| `sakura` | Assistencia tecnica, documentacao e apoio. |
| `translator_a`, `translator_b` | Propostas independentes de traducao. |
| `philologist` | Morfologia, sintaxe, terminologia e ambiguidades do original. |
| `translation_critic` | Revisao adversarial de omissoes, acrescimos e leituras sem sustentacao. |
| `portuguese_editor` | Revisao em portugues brasileiro preservando significado. |

Naruto atende desenvolvimento; Sasuke, arquitetura/revisao; Sakura, documentacao.
Cinco agentes separados preservam traducao, filologia, critica e edicao.
route_task usa tipo, complexidade, arquivos, contexto e seguranca. Prefixos
@naruto, @sasuke, @sakura ou o campo agent selecionam manualmente; nao sao
comandos nativos da interface. submit_routed_task retorna um job_id.

- Diagnostico: health_check, list_agents, list_providers.
- Delegacao: delegate_agent, submit_agent_task, get_agent_task,
  cancel_agent_task, retry_agent_task.
- Roteamento/historico: route_task, submit_routed_task, list_agent_tasks.
- Workflows: create_workflow, get_workflow, advance_workflow,
  approve_workflow_action, record_workflow_action, review_workflow_step,
  replan_workflow.

[Guia de workflows](docs/WORKFLOWS.md): etapas persistidas, jobs vinculados,
propostas de acoes, aprovacao e revisao antes de avancar. Nao ha execucao local
automatica. Aprovacao no MCP nao substitui permissoes do usuario; resultados
registrados nao sao atestados independentes.

### Ciclo de um workflow

1. `create_workflow` recebe etapas, agentes, contexto e criterios de aceitacao. Criar nao executa inferencia.
2. `advance_workflow` submete a etapa atual; `get_agent_task` consulta o job e outro avanco coleta o resultado. `get_workflow` apenas le o estado.
3. O modelo retorna propostas estruturadas. O cliente verifica cada acao e registra aprovacao ou rejeicao: isso nao concede permissoes do sistema nem substitui autorizacao do usuario.
4. O cliente executa acoes permitidas com suas ferramentas e registra resultados reais em `record_workflow_action`. O MCP nao executa leituras, patches ou comandos propostos.
5. `review_workflow_step` aceita ou rejeita a etapa pelas evidencias. Aceitar prepara a proxima sem submete-la; acoes rejeitadas ou malsucedidas impedem aceitar. Um plano bloqueado exige replanejamento explicito.

Resultados identicos de acoes sao idempotentes; substituicoes conflitantes sao
rejeitadas. Checkpoints nao substituem a leitura dos arquivos reais. Workflows
permitem ate oito etapas/oito inferencias totais e duas revisoes de plano.
Cada inferencia tem timeout maximo de 180 segundos, ate 4.000 tokens e retries
zero. Falha, degradacao ou JSON invalido bloqueiam o fluxo sem repetir etapas.
Submissao interrompida e incerta bloqueia em vez de duplicar. Nao ha garantia de
execucao exatamente uma vez para efeitos externos.

O suporte de inferencia e Chat Completions textual HTTP(S), incluindo SSE.
Adaptadores nativos Anthropic, Gemini e OpenAI Responses nao estao implementados:
use um gateway que normalize essas APIs. Streaming SSE de inferencia nao e o
transporte MCP; este servidor comunica-se com o cliente por stdio.

## Falhas e privacidade

Retries limitados e circuit breaker protegem delegacoes. 401/403 nao sao
repetidos automaticamente. Streaming interrompido preserva saida parcial sem
retry automatico. Workflows limitam etapas, contexto e revisoes, sem repetir
etapas automaticamente. Metricas ausentes sao null; modelo informado pode ser alias.
O MCP nao resolve indisponibilidade upstream nem troca o provider do Codex.

Jobs e workflows sao privados. Leia [SECURITY.md](SECURITY.md).
Nao envie credenciais ou material confidencial sem autorizacao.

## Preparar publicacao

```bash
npm test
npm run build
npm run release:prepare
```

O ultimo comando cria um checkout em release/ por lista explicita, com
manifesto SHA-256 e verificacao defensiva de segredos/caminhos pessoais.
Nao copia .git, historicos, jobs, workflows, outputs ou configuracoes globais.
Revise antes de publicar. A verificacao nao e auditoria completa de seguranca.
O pacote npm usa uma allowlist separada em files para runtime compilado,
configuracoes de exemplo e documentacao.
A CI usa testes sem credenciais ou inferencias externas.

Para instalar pelo npm, use `npm install -g multiagents-mcp` e configure o cliente
MCP para executar `multiagents-mcp`, ou use `npx --yes multiagents-mcp@0.4.1`.
O pacote inclui JavaScript compilado: o consumidor nao precisa compilar nem
instalar TypeScript. Forneca credenciais no ambiente do processo. Os agentes
padrao sao carregados da instalacao; configure caminhos privados absolutos para
jobs/workflows, evitando gravar estado na pasta de onde o comando foi chamado.

Licenca MIT. Inspiracao conceitual: [ManusMCP](https://github.com/mantrakp04/manusmcp).
Nenhum executor, framework ou dependencia de sua stack foi incorporado.
