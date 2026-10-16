# Seguranca

Este MCP envia contexto aos backends configurados. Nao envie credenciais ou
material privado sem autorizacao. Jobs e workflows persistem prompts, propostas
e evidencias: use diretorios privados fora de repositorios publicos. Permissoes
0600/0700 dependem do filesystem; mounts Windows podem nao respeita-las.

O servidor e para um cliente local confiavel, nao um servico multiusuario.
Usa stdio e nao fornece shell, sudo ou executor de arquivos.
Propostas sao dados nao confiaveis. Aprovacao no workflow nao substitui
autorizacao do usuario, sandbox ou permissoes do Codex. O cliente deve validar
workspace, symlinks, caminhos, patches e comandos antes de qualquer execucao.
Resultados registrados sao declaracoes do cliente, nao atestados independentes.
Confirme arquivos e resultados reais antes de aceitar etapas ou repetir efeitos.

Gestao de combos exige credencial administrativa e politica privadas explicitas.
Somente novas versoes sao criadas; nenhum combo existente e sobrescrito ou
apagado. Referencias em outras CLIs sao descobertas apenas em JSONs declarados;
consumidores desconhecidos podem existir. Testes de modelos consomem cota e nao
comprovam qualidade geral. Redirecionamentos administrativos sao bloqueados.
Estado de propriedade e recuperacao fica em .combos com permissoes 0600/0700;
preserve-o. Locks sobreviventes exigem verificacao dos consumidores antes de
qualquer remocao. Nao reutilize automaticamente credenciais de inferencia.

Nao publique .env, .jobs, .workflows, .combos, outputs, backups, logs ou historicos.
O exportador usa allowlist e verificacao defensiva; nao detecta todo segredo
nem substitui revisao humana. Nao reporte credenciais em issues publicas.
Use o canal privado de seguranca do repositorio quando configurado; ate la,
contate o mantenedor por um canal privado conhecido.
