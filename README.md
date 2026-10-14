# MULTIAGENTS-MCP

A local MCP server for delegating tasks to agents configured by each user, backed by OpenAI-compatible Chat Completions endpoints. Supports synchronous tasks, persistent asynchronous jobs, and reviewed workflows.

The server does not include the author's personal agents, models, combos, or credentials. Agent IDs, model routes, providers, fallbacks, and specializations belong to your configuration. The MCP does not create model aliases or change your MCP client's primary model.

## Install and configure

Requires Node.js >=20.11.

```bash
npm install
npm run build
cp config/agents.example.yaml /absolute/path/to/private/agents.yaml
```

Edit the copied YAML. Replace every `your-model-id` with an actual model or alias available in your backend. Rename, remove, or add agents as needed. The included developer, reviewer, and assistant are examples, not required agent IDs or preconfigured models.

```yaml
agents:
  my-agent:
    route: model-id-from-your-backend
    role: my-specialization
    task_kinds: [development, documentation]
    description: Produces proposals from the context supplied by the client.
    route_strategy: fallback
```

Optional `task_kinds`: development, architecture, documentation, translation, philology. Automatic routing uses these declarations; if none matches, it uses the first configured agent. An explicit `agent` field or leading `@my-agent` selects an existing ID. Unknown IDs are rejected. Complex tasks suggest review/implementation/review only when both specializations exist.

Configure your MCP client with absolute paths:

```toml
[mcp_servers.multiagents-mcp]
command = "node"
args = ["/absolute/path/to/multi-agents-mcp/dist/index.js"]

[mcp_servers.multiagents-mcp.env]
AGENTS_CONFIG = "/absolute/path/to/private/agents.yaml"
MULTIAGENTS_BASE_URL = "http://127.0.0.1:8000/v1"
MULTIAGENTS_API_KEY = "your-private-key"
```

Store real credentials only in private configuration. The server does not load `.env` automatically. Without `AGENTS_CONFIG`, it loads the generic example; its placeholder routes must be configured before inference. It never searches for a second agent file implicitly. `TECHNICAL_AGENTS_CONFIG` remains an optional explicit second file for existing installations.

For multiple backends, copy `config/providers.example.yaml`, keep only profiles you use, supply their credential environment variables, and set `MULTIAGENTS_PROVIDERS_CONFIG`. Assign a `provider` to each agent. See [providers](docs/PROVIDERS.md). Legacy `NINEROUTER_URL` and `NINEROUTER_KEY` remain supported.

## Tools and execution

- `list_agents`, `list_providers`: inspect configured agents and backend profiles.
- `health_check`: check a backend catalog or explicitly request an inference probe.
- `delegate_agent`: wait for a short task.
- `submit_agent_task`, `get_agent_task`, `list_agent_tasks`: submit and inspect persistent jobs.
- `route_task`, `submit_routed_task`: select configured agents using task signals.
- Workflow tools: plan steps, review evidence, approve proposals, and record actual client execution.

The MCP produces proposals. The client supplies relevant source/context, applies changes, executes tools, and records actual results. Model proposals and approvals never grant operating-system permissions. See [workflows](docs/WORKFLOWS.md) and [security](SECURITY.md).

## Validation and publication

```bash
npm test
npm run release:prepare
```

Release preparation stages an explicit allowlist for review. Personal `config/agents.yaml`, `config/technical-agents.yaml`, editorial job inputs, runtime state, and local model-selection notes are excluded from Git/package publication. Keep private files outside the repository when possible. Preparing a release does not publish it.

## Português

O MULTIAGENTS-MCP é um servidor MCP local para delegação de tarefas a agentes definidos por cada usuário. Conecte seu próprio backend compatível com OpenAI Chat Completions e configure seus modelos, aliases, papéis e fallbacks.

Copie `config/agents.example.yaml` para um arquivo privado, substitua `your-model-id` por IDs reais do seu backend e defina `AGENTS_CONFIG` no cliente MCP. Os nomes dos agentes são livres. `task_kinds` declara as especializações usadas pelo roteamento; `@id` ou o campo `agent` seleciona um agente configurado.

Não são distribuídos os perfis pessoais do autor. O MCP não cria combos, não exige agentes de tradução/revisão e não altera o modelo principal do cliente. Configurações pessoais existentes continuam locais e devem ser apontadas explicitamente.

O cliente controla arquivos e comandos; o servidor produz análises e propostas. Catálogo acessível não comprova inferência: use `health_check` em modo inference para uma verificação real, considerando o custo do seu backend.
