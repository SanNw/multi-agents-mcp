# MULTIAGENTS-MCP

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
private=true impede npm publish acidental; nao impede publicar no GitHub.
A CI usa testes sem credenciais ou inferencias externas.

Licenca MIT. Inspiracao conceitual: [ManusMCP](https://github.com/mantrakp04/manusmcp).
Nenhum executor, framework ou dependencia de sua stack foi incorporado.
