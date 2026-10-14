# Backends do MULTIAGENTS-MCP

## Endpoint unico

Configure MULTIAGENTS_BASE_URL e MULTIAGENTS_API_KEY no ambiente. A URL aceita
raiz ou sufixo /v1, preservando prefixos como /api/v1. Suporte atual: HTTP(S),
Chat Completions textual e streaming SSE. Nenhum adaptador Anthropic nativo,
Gemini nativo ou Responses esta implementado: use um gateway que normalize
esses protocolos. Nao confunda suporte generico com certificacao de todo backend.

NINEROUTER_URL e NINEROUTER_KEY continuam aceitos para configuracoes existentes.
Se MULTIAGENTS_BASE_URL estiver definido, a chave antiga NAO e herdada para esse
endpoint. Isso evita enviar credenciais 9Router a outro servico por acidente.

## Perfis simultaneos

Use config/providers.example.yaml como referencia, exclua os perfis que nao
utiliza e aponte MULTIAGENTS_PROVIDERS_CONFIG para seu arquivo privado.
Cada perfil define base_url, api_key_env, protocolo e streaming. Chaves literais
no YAML nao sao aceitas. Nenhuma credencial e registrada em list_providers.
api_key_env recebe o nome da variavel (por exemplo OMNIROUTE_API_KEY), nunca a
chave literal. Todos os perfis declarados exigem suas credenciais ao iniciar;
nao ative um perfil antes de fornecer a variavel ao processo do MCP.

Em seu arquivo de agentes, selecione um perfil por agente:

```yaml
agents:
  developer:
    provider: omniroute
    route: auto/coding
    role: software_development
    description: Produz propostas de codigo revisadas e executadas pelo Codex.
    stream: false
```

Route e um ID do backend: pode ser um combo, alias, auto-route ou modelo.
As rotas nao sao criadas pelo MCP. Fallback_routes ficam no mesmo perfil;
etapas do workflow podem usar agentes de perfis diferentes. Circuitos e chaves
sao isolados por perfil. O provider principal do Codex nao e alterado.

list_providers informa perfis, protocolo, streaming declarado e origem do
catalogo. health_check aceita provider. Catalogo remoto valida acesso a /models,
nao inferencia. O campo models opcional declara IDs para backends sem catalogo;
nesse caso health_check shallow retorna configured, nunca um falso ok remoto.
Para inference, selecione agentes vinculados aos perfis que deseja testar.

## OmniRoute

Projeto: https://github.com/diegosouzapw/OmniRoute. Sua interface OpenAI-compatible
fornece /v1/chat/completions e aliases auto. Uma instalacao nova pode nao ter
provider elegivel; conectar contas e obter uma chave do gateway e separado de
instalar o servidor. Nao importe tokens ou dados do 9Router automaticamente.
auto/coding pode consumir cotas/creditos dos providers conectados; confira
politicas de custo antes de usa-lo. Validacao local de protocolo nao atesta
disponibilidade, permissao de uso ou qualidade dos modelos upstream.

O nome de registro MCP e escolhido pelo cliente. Novas instalacoes podem usar
multiagents-mcp; registros antigos 9router-agent continuam validos e nao precisam
ser duplicados. O servidor anuncia o nome MULTIAGENTS-MCP.
