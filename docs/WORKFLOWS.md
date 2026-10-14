# Workflows mediados pelo Codex

Envie a create_workflow um plano explicito:

```json
{"task":"Corrigir uma API preservando o contrato","context":"Trechos reais",
 "steps":[
  {"agent":"reviewer","task":"Analise a causa","acceptance":"Hipotese sustentada por codigo"},
  {"agent":"developer","task":"Proponha patch e teste","acceptance":"Codex aplicou e testou a correcao"},
  {"agent":"reviewer","task":"Revise as evidencias","acceptance":"Riscos criticos resolvidos ou registrados"}
 ]}
```

Criar nao executa inferencia. advance_workflow submete uma etapa e retorna.
Consulte o job por get_agent_task; advance_workflow novamente coleta seu
resultado. get_workflow nunca submete ou avanca. O agente retorna JSON estrito:

```json
{"summary":"Proposta fundamentada","actions":[
 {"type":"read_file","path":"src/api.ts"},
 {"type":"propose_patch","path":"src/api.ts","patch":"diff a revisar"},
 {"type":"run_tests","command":["npm","test"]}
]}
```

Acoes sao propostas, nao ferramentas executadas pelo MCP. IDs sao gerados pelo
servidor; o agente nao controla aprovacoes ou resultados. approve_workflow_action
registra aprovacao/rejeicao do Codex. O Codex valida o escopo e a autorizacao,
executa com suas ferramentas e registra record_workflow_action com evidencias.
Resultados identicos sao idempotentes; substituicoes conflitantes sao recusadas.

Quando todas as acoes sao reportadas ou rejeitadas, review_workflow_step aceita
ou rejeita a etapa mediante evidencia. Aceitar prepara a etapa seguinte sem
submete-la. Acoes rejeitadas ou malsucedidas impedem aceitar a etapa.
replan_workflow substitui explicitamente etapas pendentes de um workflow
bloqueado, preservando o plano anterior. Releia arquivos e efeitos reais antes
de replanejar; nao repita efeitos externos automaticamente.

## Limites e recuperacao

- Ate oito etapas e oito inferencias totais, incluindo replanejamentos.
- Ate duas revisoes de plano; nenhuma repeticao automatica de etapa.
- Por inferencia: timeout ate 180 segundos, saida ate 4.000 tokens, retries zero.
- Contexto inicial ate 80.000 caracteres; contexto combinado ate 160.000.
  Limites dos modelos podem ser menores; compatibilidade nao e garantida.
- Falha, degradacao ou JSON invalido bloqueiam o fluxo e preservam o job.
- Checkpoints incluem jobs, propostas, decisoes e evidencias. Nao substituem
  leitura dos arquivos reais. Configure NINEROUTER_WORKFLOWS_DIR e
  NINEROUTER_JOBS_DIR com caminhos privados absolutos. O default de workflows
  fica ao lado do diretorio de jobs.
- Locks exclusivos serializam alteracoes. Quedas abruptas podem deixar .lock;
  nao remova automaticamente. Confirme processos/consumidores antes de recuperar.
- A intencao de submissao e persistida antes de chamar o agente. Queda entre
  submissao e vinculacao do job bloqueia em vez de repetir. Nao ha promessa de
  exactly-once entre arquivos ou de execucao exatamente uma vez de efeitos externos.

O workflow nao altera o provider do Codex, nao cria combos, nao corrige namespaces
Responses e nao resolve indisponibilidade upstream. Inspiracao conceitual:
https://github.com/mantrakp04/manusmcp. Nenhum executor de sua stack foi incorporado.
