# MULTIAGENTS-MCP — plano de confiabilidade e usabilidade

> Para execução futura: usar a skill executing-plans, implementar uma entrega por vez e verificar os critérios antes de avançar. A pesquisa e este documento não autorizam execução de mudanças em serviços ativos, testes pagos ou publicação.

**Objetivo:** melhorar segurança operacional, consumo de recursos e experiência de uso sem transformar um MCP local em uma plataforma pesada.

**Base inspecionada:** versão 0.5.0, commit f432b6bc026918d53ca3f58b0a511560513085d9. Pesquisa iniciada em 15/10/2026 e consolidada em 16/10/2026. Revalidar versões, APIs e estado do checkout na execução.

**Arquitetura:** preservar TypeScript, MCP stdio, configuração privada por usuário e os gerenciadores existentes. Corrigir primeiro limites, persistência e contratos. Não introduzir banco de dados, daemon, painel web ou migração de SDK sem necessidade comprovada.

**Escopo original da pesquisa:** leitura direcionada e planejamento. A execução local foi autorizada posteriormente em 16/10/2026; o registro abaixo distingue implementação, testes sintéticos e condições externas ainda pendentes.

## Execução local — 16/10/2026

| Entrega | Resultado implementado e evidência | Limite / pendência |
| --- | --- | --- |
| A1 | Identidade Linux preservada, sessão conservadora sem `/proc`, liberação de fila após falhas de persistência e inspeção sem mutação de jobs/locks/reservas; testes de jobs e MCP | Windows/macOS nativos não certificados; nenhuma remoção ou recuperação automática de locks |
| A2 | Revisão `canonical-v1`, compatibilidade legada conservadora e fixtures administrativas paginadas dos dois adaptadores | Campos desconhecidos do legado podem exigir reconciliação manual; sem teste em backend real |
| A3 | Reservas persistentes antes de cada tentativa, concorrência compartilhada, cota por provider/projeto, limites de entrada/resposta e fila local; disputa entre processos e falha incerta cobertas | Opcional; exige a mesma política/diretório/identidade nas sessões. Unidades reservadas não são cobrança monetária nem tokens exatos. Fila não é global |
| B1 | Metadados reconstruíveis, corpos sob demanda, listagens e conteúdo paginados; benchmark reproduzível em `scripts/benchmark-history.mjs` | Legado sem metadados ainda exige leitura inicial dos corpos; nenhuma limpeza de histórico |
| B2 | Ferramenta `diagnose` e CLI `--diagnose`, offline e sem credenciais/caminhos privados no relatório | Não certifica inferência, autorização remota ou runtime de outro processo |
| B3 | `outputSchema` nas 25 ferramentas, envelopes de erro testados separadamente com `isError`, progresso negociado e polling preservado | SDK 1.31 exige objeto no schema publicado; erros não são apresentados como sucesso |
| C1 | Suítes fixas `availability-v1`, `text-v1`, `json-v1`, `instructions-v1`, verificadores determinísticos e relatórios privados isolados | Ferramentas não testadas sem contrato confiável; uma amostra por caso, sem benchmark de qualidade/variabilidade |
| C2 | Workflow manual preparado, tag/SHA/CI, Node 24, OIDC restrito e verificação de integridade; testes estáticos e allowlist de pacote | Cadastro externo do trusted publisher, ambiente protegido e primeira publicação dependem de autorização do operador; não executados |
| C3 | Spike isolado de negociação Tasks no SDK 1.31, cliente sem suporte e cancelamento em testes | Integração com JobManager adiada: cancelar TaskStore não cancela inferência; capacidades dos clientes reais não confirmadas. Sem migração de SDK |

**Medição B1:** Node 20.20.2, Linux x64, processos isolados com GC explícito, cache aquecido e uma amostra. Em 400 jobs sintéticos de 256 KiB (~100 MiB de originais), bootstrap legado de 492,49 ms contra 168,46 ms com metadados; heap retido ~4,09 MB em ambos e RSS de 61,87 MB contra 55,76 MB. Não é medição do WSL inteiro nem comparação estatística. Evidência local preservada em `release/history-benchmark.json`.

**Verificação final:** build aprovado; **81/81 testes no Node 20.20.2 e 81/81 no Node 24.21.0**, com concorrência de dois arquivos de teste. Incluem fixtures HTTP, transporte MCP real, subprocessos, persistência, quotas e empacotamento offline. Logs preservados em `release/validation-node20.log` e `release/validation-node24.log`. Corrigida uma corrida no cleanup de fixture para aguardar a fila ociosa; o teste de pacote não depende mais de consultas de rede do npm. `git diff --check` sem erros. Os checklists seguintes são os critérios originais de referência, não uma declaração de validação externa.

**Preservação:** nenhum combo real, configuração de CLI, credencial ou runtime instalado foi alterado. Sem commit, push ou publicação implícita. O estado privado não entra na distribuição pública. A única limpeza foi de fixture temporária comprovadamente criada pelos testes, após inventário e verificação de consumidores.

## Evidências e classificação

As observações abaixo vêm da leitura do código, não de uma auditoria completa ou de exploração de vulnerabilidades.

| Observação confirmada | Implicação a verificar | Prioridade |
| --- | --- | --- |
| JobManager mantém filas e contadores de concorrência em Maps do processo | Duas sessões MCP não compartilham o mesmo limite efetivo | P0 |
| test_combo limita modelos por chamada, mas não tem orçamento persistente entre chamadas | Repetições autorizadas podem consumir cota sem um teto agregado | P0 |
| A identidade de processos dos jobs depende de /proc e boot_id | Submissão assíncrona não é portável nativamente para Windows/macOS | P0 |
| Hashes de revisão usam JSON.stringify do objeto recebido | A ordem das chaves ou campos voláteis pode causar detecção indevida de alteração | P0 |
| O bootstrap lê os JSONs de todos os jobs e mantém os objetos completos na memória | Histórico grande pode aumentar RAM e tempo de inicialização | P1 |
| Há structuredContent, mas não outputSchema nas ferramentas | Clientes não recebem contratos de saída declarados por ferramenta | P1 |
| Resultados são serializados em texto e structuredContent; get_agent_task inclui conteúdo por padrão | Saídas grandes podem aumentar contexto e tráfego | P1 |
| Há callbacks internos de progresso, mas não integração com progressToken no registro das ferramentas | Clientes precisam consultar jobs para acompanhar o trabalho | P1 |
| O CI roda em Ubuntu com Node 20 e 24; não publica no npm | Portabilidade não está coberta; publicação depende de autenticação manual | P1/P2 |

Não atribuir o consumo total de memória do WSL ao MCP: medir o processo e o histórico usado, distinguindo RSS/PSS, cache e outros serviços.

## Fontes primárias pesquisadas

1. [Ferramentas MCP: outputSchema, structuredContent e resource links](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Base para contratos de saída e recuperação de resultados extensos. Não confundir saída estruturada do servidor com geração estruturada do modelo.
2. [Progresso MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress). Notificações dependem do token fornecido pelo cliente; não se deve inventar progresso percentual nem continuar notificando uma requisição comum já encerrada.
3. [Tasks na especificação 2025-11-25](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/utilities/tasks.mdx) e [extensão Tasks](https://github.com/modelcontextprotocol/ext-tasks). Compatibilidade depende da revisão do protocolo e das capacidades negociadas; a implementação experimental de uma revisão não equivale ao contrato de outra.
4. [SDK TypeScript — documentação e separação entre v1 e v2](https://github.com/modelcontextprotocol/typescript-sdk). O projeto usa @modelcontextprotocol/sdk 1.31.0; a documentação main pode descrever outra geração. Verificar exemplos contra a dependência instalada e a branch v1.x antes de copiar APIs.
5. [Boas práticas de segurança MCP](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices). Referência para fronteiras de confiança; o projeto é stdio local e não deve receber OAuth/HTTP multiusuário como consequência automática desta pesquisa.
6. [Node.js: process.kill e sinal 0](https://nodejs.org/api/process.html#processkillpid-signal). Pode verificar existência de um processo em diferentes plataformas, mas não comprova identidade, propriedade ou ausência de reutilização do PID.
7. [RFC 8785 — JSON Canonicalization Scheme](https://datatracker.ietf.org/doc/html/rfc8785). Referência para evitar hashes dependentes da ordem das propriedades. Não alegar conformidade integral com JCS apenas por ordenar algumas chaves.
8. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/). Publicação por OIDC pode substituir tokens duradouros e logins manuais. A documentação consultada exige npm >=11.5.1 e Node >=22.14.0; revalidar os requisitos antes da implementação.

## Restrições permanentes

- Preservar perfis pessoais, credenciais, históricos, snapshots e o estado dos usuários. Nenhum modelo ou combo pessoal vira padrão público.
- Manter combos externos protegidos e atualizações por criação de nova versão. Não tocar em modelos principal/auxiliar de outras CLIs, aliases ou estratégias globais.
- Não executar testes de inferência reais como parte de diagnóstico padrão. Custos, envio de contexto e chamadas externas exigem autorização e política compatíveis.
- Limites e aprovações são controlados pelo operador; texto do modelo e metadados de ferramentas não concedem permissões.
- Não apagar histórico ou locks por idade. Recuperação deve preservar evidências e verificar consumidores.
- Manter as interfaces existentes compatíveis ou documentar/migrar explicitamente qualquer quebra. Arquivos antigos não podem ser regravados em massa no bootstrap.

## Entrega A — manutenção e segurança operacional

### A1. Propriedade de processos, persistência e recuperação

**Arquivos:** src/jobs.ts, src/workflows.ts, src/combos.ts e respectivos testes; .github/workflows/ci.yml e documentação de plataformas.

- [ ] Reproduzir em testes a ausência de /proc, reinício, PID reutilizado, processo vivo, estado antigo/corrompido e lock sobrevivente.
- [ ] Preservar a verificação forte de identidade no Linux. Nas demais plataformas, usar identificação de sessão/proprietário e mecanismos adequados; existência de PID isoladamente deve resultar em estado desconhecido, não em autorização para cancelar, retomar ou remover locks.
- [ ] Definir o comportamento de permissões de estado no Windows. Bits POSIX não substituem verificação de privacidade/ACL; não simplesmente retirar a validação 0700 para fazer o teste passar.
- [ ] Garantir que falha de persistência libere contadores/controladores ou marque o estado como incerto, sem travar a fila ou repetir inferência automaticamente. Usar finally no ponto responsável pela liberação.
- [ ] Oferecer primeiro inspeção de recuperação, sem mutação. Uma recuperação posterior deve ter alvo exato, snapshot e confirmação de ausência de consumidores; nunca autoapagar locks por TTL.
- [ ] Ampliar o CI para Windows/macOS quando o contrato estiver implementado; até lá, documentar o escopo Linux/WSL confirmado e as limitações nativas.

**Aceitação:** nenhum processo vivo é adotado/cancelado por engano; uma falha de escrita não paralisa jobs independentes; recuperação não repete efeitos incertos; sistemas declarados como suportados passam em testes próprios.

### A2. Revisões estáveis e compatibilidade dos backends

**Arquivos:** src/combo-client.ts, src/combos.ts, src/combos.test.ts; possível novo src/combo-client.test.ts; docs/COMBOS.md.

- [ ] Reproduzir respostas semanticamente iguais com ordens de chave diferentes, alterações reais em modelos/configuração e metadados voláteis.
- [ ] Definir explicitamente a projeção relevante para revisão e canonicalizá-la. Excluir somente campos comprovadamente voláteis; alterações em configuração relevante precisam invalidar a revisão.
- [ ] Versionar o formato da revisão e reconhecer registros 0.5.0. Não perder a propriedade dos combos já registrados nem reescrever seus arquivos sem necessidade.
- [ ] Fixar fixtures dos contratos 9Router e OmniRoute com paginação, autenticação inválida e formatos de modelos suportados. Declarar unsupported quando o contrato não for reconhecido.
- [ ] Preservar readback, reconciliação sem novo POST e criação de nova versão. Nenhum PUT/PATCH/DELETE sobre combo existente.

**Aceitação:** ordem de propriedades não produz falso conflito; alterações reais continuam bloqueadas; estado legado permanece utilizável e nenhum consumidor externo é alterado.

### A3. Limites compartilhados de execução e cota

**Arquivos:** src/providers.ts, src/jobs.ts, src/combos.ts, src/index.ts e testes multiprocesso; eventual módulo pequeno src/budgets.ts somente se for necessário compartilhar a mesma regra.

- [ ] Definir limites por provider/projeto: concorrência, fila, requisições e tokens reservados por janela. Contabilizar provas individuais, health_check em modo inference e delegações pertinentes, evitando caminhos que escapem do limite.
- [ ] Usar reservas atômicas compartilhadas entre processos, com identificação da operação e reconciliação após falhas. Um contador Map ou teto por chamada não é um orçamento global.
- [ ] Reservar antes do efeito externo. Operações incertas não liberam a mesma reserva para repetição automática; definir fechamento quando usage vier ausente.
- [ ] Distinguir contagem exata, estimativa de tokens e custo desconhecido. Um orçamento monetário rígido só é prometido quando houver preço e contabilização confiáveis; não inferir gratuidade por nome de modelo.
- [ ] Acrescentar limites de entrada/saída nos caminhos síncronos e no armazenamento, sem cortar textos silenciosamente. Preservar os fluxos editoriais de documentos grandes por configuração explícita e processamento em lotes.
- [ ] Testar duas sessões concorrentes disputando a última reserva, retry, crash, usage ausente e tentativa de ampliar a política por argumento de ferramenta.

**Aceitação:** duas sessões não ultrapassam o limite agregado definido; nenhuma chamada sai depois de uma reserva negada; falhas e incerteza não geram reexecução gratuita.

## Entrega B — memória, diagnóstico e experiência do cliente

### B1. Histórico leve e respostas limitadas

**Arquivos:** src/jobs.ts, src/index.ts, testes de jobs/MCP e README.md.

- [ ] Medir bootstrap e memória com fixtures de histórico pequeno e grande, sem usar conversas privadas. Registrar versões e método de medição.
- [ ] Separar metadados de conteúdo pesado e carregar resultado completo sob demanda. Evitar manter todos os prompts/saídas de jobs encerrados nos Maps do processo.
- [ ] Paginar listagens e resultados longos com limites explícitos. Manter o conteúdo integral em estado privado, acessível por ID e, se útil ao cliente, resource links MCP; nunca aceitar caminho arbitrário informado pelo modelo.
- [ ] Evitar repetir saída final e conteúdo parcial desnecessariamente. Manter a representação textual de compatibilidade onde exigida/recomendada pelo contrato, mas retornar apenas o conteúdo solicitado.
- [ ] Tratar índices como reconstruíveis, mantendo o estado original como fonte de recuperação. Não introduzir SQLite antes de provar que a solução com arquivos deixou de atender.

**Aceitação:** carregar/listar histórico não lê todos os corpos completos; tamanho das respostas é limitado e conteúdo integral continua recuperável, sem limpeza automática.

### B2. Diagnóstico seguro de configuração

**Arquivos:** src/index.ts, src/providers.ts, src/agents.ts e testes; módulo src/diagnostics.ts somente se a responsabilidade justificar.

- [ ] Produzir diagnóstico somente leitura de versão carregada, capacidades, schema de configuração, referências de agentes/providers, credenciais presentes ou ausentes e acesso aos diretórios privados.
- [ ] Separar verificação offline, consulta remota de catálogo e prova de inferência. Rede e consumo de cota precisam ser explícitos.
- [ ] Não revelar valores de credenciais, arquivos completos, endpoints privados ou caminhos sensíveis por padrão. Exibir IDs/labels e ações corretivas objetivas.
- [ ] Informar quando o runtime antigo exige reload; não migrar silenciosamente a configuração ou duplicar o registro MCP.
- [ ] Cobrir os casos de instalação por npx, diretório de chamada diferente, variáveis ausentes e configurações de versões anteriores.

**Aceitação:** um usuário identifica por que uma ferramenta não aparece ou um agente não funciona sem compartilhar segredos e sem disparar inferência.

### B3. Contratos de saída e progresso MCP

**Arquivos:** src/index.ts, src/jobs.ts, testes de protocolo e, se necessário, schemas de resultado extraídos para um arquivo focado.

- [ ] Definir outputSchema por ferramenta, incluindo os envelopes de erro existentes. Validar structuredContent com a API do SDK instalado; não copiar exemplos exclusivos do SDK v2.
- [ ] Manter campos e semântica utilizados pelos clientes atuais; testar sucesso, resultado parcial, degradação, conflito e erro de domínio.
- [ ] Conectar callbacks de progresso a progressToken somente quando fornecido e válido. Usar contadores monotônicos e mensagens úteis, sem inventar percentual/total.
- [ ] Em requisições comuns, encerrar notificações quando a chamada terminar. Jobs desacoplados continuam consultáveis; notificações além desse ponto exigem negociação de Tasks ou outro mecanismo suportado.
- [ ] Testar clientes com e sem progresso e manter polling funcional.

**Aceitação:** tools/list anuncia schemas corretos, nenhum erro viola o próprio contrato e a ausência de suporte do cliente não quebra execução.

## Entrega C — evolução opcional após a manutenção

### C1. Comparações úteis de modelos, sem falsa promessa de qualidade

**Arquivos:** src/combos.ts, testes e docs/COMBOS.md; persistência de relatórios isolada do ledger de propriedade.

- [ ] Preservar o probe rápido de disponibilidade. Acrescentar suítes opcionais e versionadas para JSON válido, seguimento de instruções e ferramentas, apenas quando o backend declarar/sustentar essas capacidades.
- [ ] Usar verificadores determinísticos e casos sintéticos, com quantidade de amostras e limites explícitos. Não comparar um modelo a partir de um único OK nem usar outro LLM como juiz obrigatório.
- [ ] Persistir relatório privado com horário, rota solicitada/reportada, versão da suíte, latência, uso e falhas. Não alterar combos automaticamente em consequência de uma pontuação.
- [ ] Reutilizar os limites da entrega A3. Contexto real de projeto fica fora das suítes padrão.

**Aceitação:** relatório separa disponibilidade, correção no caso de teste, variabilidade e dados desconhecidos; comparação não amplia permissões ou custos autorizados.

### C2. Publicação npm por OIDC

**Arquivos:** nova .github/workflows/publish.yml, documentação de release e testes do empacotamento.

- [ ] Com autorização específica, cadastrar no npm o trusted publisher correspondente ao repositório e workflow corretos. Essa configuração externa é uma etapa do operador, não uma permissão que o YAML concede sozinho.
- [ ] Usar runner hospedado compatível e toolchain de publicação conforme requisitos atuais do npm. Isso não exige elevar automaticamente a versão mínima do runtime do pacote.
- [ ] Restringir a release a tag/versionamento conferidos e CI aprovado. Conceder id-token: write somente ao job que publica; fixar actions por SHA e revisar proveniência.
- [ ] Publicar o artefato previamente testado, conferir conteúdo/README, integridade e dist-tags. Não publicar a cada push da main.
- [ ] Preservar a publicação manual via Edge como recuperação, sem armazenar credenciais no repositório.

**Aceitação:** uma release autorizada é publicada a partir do workflow declarado e verificada no registro sem token duradouro no repositório.

### C3. Tasks nativas: experimento limitado, não migração imediata

**Arquivos:** protótipo/testes de protocolo separados; src/index.ts e src/jobs.ts somente após validar o desenho.

- [ ] Registrar as revisões de protocolo e capacidades dos clientes reais e verificar o suporte do SDK 1.31.0. As Tasks experimentais dessa geração e extensões mais novas não devem ser tratadas como intercambiáveis.
- [ ] Prototipar um adaptador sobre JobManager sem duplicar fila, estado ou efeitos. Manter get/list/cancel atuais como compatibilidade.
- [ ] Testar negociação, cancelamento, recuperação e clientes sem suporte. TTL de protocolo não autoriza excluir histórico operacional.
- [ ] Decidir se há ganho concreto antes de atualizar major do SDK. Caso não haja, manter os jobs existentes.

**Aceitação:** clientes compatíveis usam Tasks e clientes antigos continuam funcionando; nenhuma inferência é duplicada para representar a mesma tarefa.

## Ordem recomendada para retomar

1. Primeira sessão: A1 e A2, reproduções focadas e correções pequenas; diagnóstico B2 se houver tempo e independência.
2. Segunda entrega: A3, porque exige decisão concreta sobre limites e reservas compartilhadas.
3. Terceira entrega: B1 e B3, com medições antes/depois e contratos compatíveis.
4. Depois: C1 e C2 conforme necessidade; C3 apenas após comprovar suporte dos clientes.

Não são estimativas de duração ou compromisso de executar tudo em dois dias. Cada entrega deve terminar testada e revisável, sem esperar todas as demais.

## Critérios gerais de conclusão futura

- Testes de regressão do comportamento 0.5.0 e novos cenários focados, com verificação de empacotamento.
- Nenhum combo externo, configuração de CLI, segredo ou estado privado incorporado à distribuição pública.
- README em inglês seguido de português brasileiro revisado, distinguindo implementado, opcional e não suportado.
- Migração de estado documentada, reversível e testada; nenhuma limpeza automática de dados do usuário.
- Commit/push/publicação somente no escopo autorizado na execução; conferir SHA, CI, árvore local e registro npm antes de declarar sucesso.
- Atualizar este plano com evidências reais, limitações e decisões. Não transformar resultados hipotéticos da pesquisa em recursos anunciados.

## Fora do escopo inicial

Dashboard, serviço remoto multiusuário, shell autônomo, instalação de modelos, criação de contas, marketplace, otimização automática de combos de outras CLIs, varredura de todas as configurações da máquina, limpeza por idade e migração preventiva para SQLite ou SDK v2.
