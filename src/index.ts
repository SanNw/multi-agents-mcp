#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findAgent } from "./agents.js";
import { serializeError } from "./errors.js";
import { JobManager } from "./jobs.js";
import { ProviderRegistry } from "./providers.js";
import { classifyTask, loadConfiguredAgents, prioritizeRoutes } from "./smart-router.js";
import { WorkflowManager, workflowInputSchema } from "./workflows.js";
import { ComboManager, comboPlanInput } from "./combos.js";
import { probeSuiteNames } from "./combo-probes.js";
import { diagnoseConfiguration, inspectStateLocks, serverVersion } from "./diagnostics.js";
import { outputSchemas } from "./tool-schemas.js";

if (process.argv.includes("--diagnose")) {
  process.stdout.write(JSON.stringify(await diagnoseConfiguration(), null, 2) + "\n");
  process.exit(0);
}
const server = new McpServer({ name: "MULTIAGENTS-MCP", version: serverVersion });
const client = await ProviderRegistry.load();
const combos = new ComboManager(client);
const jobs = new JobManager(client, undefined, async input => {
  if (input.combo_selection) await combos.resolveAgent(input.agent, input.combo_selection.project_id, input.combo_selection.combo_id);
});
await jobs.init();
const workflows = new WorkflowManager(jobs, loadConfiguredAgents, undefined, (agent, project, combo) => combos.resolveAgent(agent, project, combo));

const taskInput = {
  agent: z.string().min(1).describe("Identificador retornado por list_agents"),
  task: z.string().min(1).max(2000000),
  context: z.string().max(2000000).optional(),
  instructions: z.string().max(2000000).optional(),
  output_format: z.string().max(2000000).optional(),
  timeout_ms: z.number().int().min(1_000).optional(),
  first_byte_timeout_ms: z.number().int().min(1_000).optional(),
  idle_timeout_ms: z.number().int().min(1_000).optional(),
  max_output_tokens: z.number().int().min(1).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  expected_ids: z.array(z.string().regex(/^S\d{4}$/)).max(2_000).optional().describe("IDs que devem aparecer uma única vez como títulos Markdown na saída"),
  expected_text: z.string().max(20_000).optional().describe("Texto exato esperado, usado em sondas e tarefas de controle"),
  min_output_chars: z.number().int().min(1).optional(),
  project_id: z.string().min(1).max(40).optional(),
  combo_id: z.string().min(1).max(200).optional(),
};

server.registerTool("list_agents", {
  outputSchema: outputSchemas.list_agents,
  title: "Listar agentes do 9Router",
  description: "Lista os subagentes semânticos e suas políticas de execução, sem expor chaves.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const agents = (await loadConfiguredAgents()).map(({ id, provider, role, description, route, fallback_routes, route_strategy, timeout_ms, first_byte_timeout_ms, idle_timeout_ms, max_output_tokens, retries, concurrency }) =>
    ({ id, provider: provider ?? "default", role, description, routes: [route, ...fallback_routes], route_strategy, timeout_ms, first_byte_timeout_ms, idle_timeout_ms, max_output_tokens, retries, concurrency }));
  return result({ agents });
});

server.registerTool("health_check", {
  outputSchema: outputSchemas.health_check,
  title: "Verificar 9Router",
  description: "Em modo shallow verifica /v1/models; em inference executa uma inferência mínima nos agentes selecionados.",
  inputSchema: {
    mode: z.enum(["shallow", "inference"]).default("shallow"),
    agents: z.array(z.string()).optional(),
    provider: z.string().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ mode, agents: requested, provider }) => {
  try {
    const models = await client.models(provider);
    const source = client.list().find(profile => profile.id === (provider ?? "default"))!.models_source;
    if (mode === "shallow") return result({ status: source === "remote" ? "ok" : "configured", mode, models_source: source, model_count: models.length });
    const configured = await loadConfiguredAgents();
    const selected = requested?.length ? requested.map((id) => findAgent(configured, id)) : configured;
    const checks = await Promise.all(selected.map(async (agent) => {
      try {
        const response = await client.delegate(agent, "Responda apenas: OK", undefined, "Não acrescente explicações.", "Texto puro", {
          timeoutMs: 45_000, firstByteTimeoutMs: 20_000, maxOutputTokens: 64, retries: 1, expectedText: "OK", minOutputChars: 2,
        });
        return {
          agent: agent.id, status: response.status === "success" ? "ok" : "degraded",
          selected_route: response.selected_route, effective_model: response.effective_model,
          finish_reason: response.finish_reason, quality: response.quality,
          attempts: response.attempts, elapsed_ms: response.elapsed_ms,
        };
      } catch (error) {
        return { agent: agent.id, status: "error", error: serializeError(error) };
      }
    }));
    return result({ status: checks.every((check) => check.status === "ok") ? "ok" : "degraded", mode, checks });
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("delegate_agent", {
  outputSchema: outputSchemas.delegate_agent,
  title: "Delegar tarefa síncrona",
  description: "Executa uma tarefa curta e aguarda a resposta. Para tarefas longas, use submit_agent_task.",
  inputSchema: taskInput,
  annotations: { readOnlyHint: false, openWorldHint: true },
}, async (input, extra) => {
  try {
    const agent = await combos.resolveAgent(findAgent(await loadConfiguredAgents(), input.agent), input.project_id, input.combo_id);
    const token = extra._meta?.progressToken;
    let progress = 0;
    const notify = async (message: string) => {
      if (token !== undefined && !extra.signal.aborted) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: progress++, message } }).catch(() => undefined);
    };
    await notify("Inferência iniciada; total de trabalho desconhecido.");
    const response = await client.delegate(agent, input.task, input.context, input.instructions, input.output_format, { ...options(input), signal: extra.signal,
      ...(token !== undefined ? { stream: true, onProgress: async () => notify("Novo trecho de resposta recebido; não representa porcentagem de conclusão.") } : {}) });
    await notify("Inferência encerrada.");
    return result(response);
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("submit_agent_task", {
  outputSchema: outputSchemas.submit_agent_task,
  title: "Enviar tarefa assíncrona",
  description: "Enfileira uma tarefa longa, grava checkpoints parciais e retorna imediatamente um job_id.",
  inputSchema: taskInput,
  annotations: { readOnlyHint: false, openWorldHint: true },
}, async (input) => {
  try {
    const agent = await combos.resolveAgent(findAgent(await loadConfiguredAgents(), input.agent), input.project_id, input.combo_id);
    const job = await jobs.submit({ agent, task: input.task, context: input.context, instructions: input.instructions, output_format: input.output_format, options: options(input),
      combo_selection: input.project_id && input.combo_id ? { project_id: input.project_id, combo_id: input.combo_id } : undefined });
    return result(jobView(job, false));
  } catch (error) {
    return failure(error);
  }
});

server.registerTool("get_agent_task", {
  outputSchema: outputSchemas.get_agent_task,
  title: "Consultar tarefa assíncrona",
  description: "Consulta estado, telemetria e conteúdo parcial ou final de uma tarefa.",
  inputSchema: { job_id: z.string().uuid(), include_content: z.boolean().default(true), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100000).default(16000) },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ job_id, include_content, offset, limit }) => {
  try {
    const job = await jobs.refresh(job_id);
    const view = jobView(job, include_content);
    if (!include_content) return result(view);
    const content = job.result?.content ?? job.partial_content;
    const next = offset + limit < content.length ? offset + limit : null;
    return result({ ...view, partial_content: job.result ? "" : content.slice(offset, offset + limit),
      result: job.result ? { ...job.result, content: content.slice(offset, offset + limit) } : undefined,
      content_total_chars: content.length, content_offset: offset, content_truncated: next !== null, next_content_offset: next });
  }
  catch (error) { return failure(error); }
});

server.registerTool("cancel_agent_task", {
  outputSchema: outputSchemas.cancel_agent_task,
  title: "Cancelar tarefa assíncrona",
  description: "Cancela uma tarefa pendente ou em execução sem apagar seus checkpoints.",
  inputSchema: { job_id: z.string().uuid() },
  annotations: { destructiveHint: true, openWorldHint: true },
}, async ({ job_id }) => {
  try { return result(jobView(await jobs.cancel(job_id), true)); }
  catch (error) { return failure(error); }
});

server.registerTool("retry_agent_task", {
  outputSchema: outputSchemas.retry_agent_task,
  title: "Repetir tarefa assíncrona",
  description: "Cria uma nova tentativa a partir de uma tarefa encerrada sem sucesso e preserva o histórico anterior.",
  inputSchema: { job_id: z.string().uuid() },
  annotations: { readOnlyHint: false, openWorldHint: true },
}, async ({ job_id }) => {
  try { return result(jobView(await jobs.retry(job_id), false)); }
  catch (error) { return failure(error); }
});

const routingInput = {
  task: z.string().min(1).max(20000),
  context: z.string().max(200000).optional(),
  agent: z.string().optional(),
  kind: z.enum(["development", "architecture", "documentation", "translation", "philology"]).optional(),
  complexity: z.enum(["low", "medium", "high"]).optional(),
  language: z.string().max(100).optional(),
  file_count: z.number().int().min(0).max(10000).optional(),
  needs_tools: z.boolean().optional(),
  security_sensitive: z.boolean().optional(),
  project_id: z.string().min(1).max(40).optional(),
  combo_id: z.string().min(1).max(200).optional(),
};
const taskState = z.object({
  decisions: z.array(z.string().max(2000)).max(50).default([]),
  files_modified: z.array(z.string().max(1000)).max(100).default([]),
  commands_executed: z.array(z.string().max(2000)).max(50).default([]),
  test_results: z.array(z.string().max(2000)).max(50).default([]),
  errors: z.array(z.string().max(2000)).max(50).default([]),
  next_steps: z.array(z.string().max(2000)).max(50).default([]),
});

server.registerTool("route_task", {
  outputSchema: outputSchemas.route_task,
  description: "Seleciona agente com sinais de tipo, complexidade, arquivos, contexto e preferência explícita. Não executa inferência nem altera arquivos.",
  inputSchema: routingInput,
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async input => {
  try { return result(classifyTask(input, await loadConfiguredAgents())); } catch (error) { return failure(error); }
});

server.registerTool("submit_routed_task", {
  outputSchema: outputSchemas.submit_routed_task,
  description: "Roteia e enfileira uma análise/proposta, preservando estado estruturado. @id no início seleciona um agente configurado. O cliente executa arquivos e comandos; o MCP não os executa.",
  inputSchema: { ...routingInput, state: taskState.optional(), max_output_tokens: z.number().int().min(1).max(12000).default(4000), timeout_ms: z.number().int().min(1000).max(600000).default(120000) },
  annotations: { readOnlyHint: false, openWorldHint: true },
}, async input => {
  try {
    const configured = await loadConfiguredAgents();
    const routing = classifyTask(input, configured);
    if (routing.needs_clarification) throw new Error("Tarefa mista: informe kind ou selecione um agente explicitamente");
    const agent = await combos.resolveAgent(findAgent(configured, routing.agent), input.project_id, input.combo_id);
    if (agent.route_strategy === "fallback" && !input.combo_id) {
      const available = new Set((await client.models(agent.provider)).map(model => model.id));
      let routes = [agent.route, ...agent.fallback_routes].filter(route => available.has(route));
      if (!routes.length) throw new Error("Nenhuma rota configurada do agente está disponível no catálogo");
      const history = jobs.list(100).flatMap(job => job.result?.attempts ?? job.error?.attempts ?? []);
      const primary = routes[0]!;
      routes = prioritizeRoutes(routes, history);
      if (routes[0] !== primary) routing.reasons.push("fallback configurado com sucesso recente após falhas da rota primária");
      agent.route = routes[0]!;
      agent.fallback_routes = routes.slice(1);
    }
    const context = [input.context, input.state && `ESTADO FORNECIDO PELO CODEX (não substitui arquivos reais)\n${JSON.stringify(input.state)}`].filter(Boolean).join("\n\n");
    if (context.length > 200000) throw new Error("Contexto combinado excede o limite; forneça trechos relevantes");
    const job = await jobs.submit({ agent, task: routing.task, context, routing, state: input.state,
      combo_selection: input.project_id && input.combo_id ? { project_id: input.project_id, combo_id: input.combo_id } : undefined,
      options: { maxOutputTokens: input.max_output_tokens, timeoutMs: input.timeout_ms } });
    return result({ ...jobView(job, false), routing });
  } catch (error) { return failure(error); }
});

server.registerTool("list_agent_tasks", {
  outputSchema: outputSchemas.list_agent_tasks,
  description: "Consulta histórico e telemetria de tarefas persistidas, sem exibir prompts ou conteúdo por padrão.",
  inputSchema: { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ limit, offset }) => result({ jobs: jobs.list(limit, offset).map(job => ({ ...jobView(job, false),
  selected_route: job.result?.selected_route ?? null, effective_model: job.result?.effective_model ?? null,
  elapsed_ms: job.result?.elapsed_ms ?? null, usage: job.result?.usage ?? null,
  attempts: job.result?.attempts ?? job.error?.attempts ?? [],
})) }));

server.registerTool("list_providers", {
  outputSchema: outputSchemas.list_providers,
  description: "Lista perfis de backend, protocolo e capacidades declaradas, sem chaves ou URLs privadas. Catálogo configurado não comprova saúde de inferência.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => result({ providers: client.list() }));

server.registerTool("list_models", {
  outputSchema: outputSchemas.list_models,
  description: "Lista IDs de modelos configurados ou anunciados pelo backend; não comprova inferência nem preço.",
  inputSchema: { provider: z.string().default("default") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ provider }) => {
  try { return result({ models: await client.models(provider), source: client.list().find(profile => profile.id === provider)!.models_source }); }
  catch (error) { return failure(error); }
});

server.registerTool("list_combos", {
  outputSchema: outputSchemas.list_combos,
  description: "Lista combos, propriedade por projeto e referências de CLIs em arquivos explicitamente configurados. Combos externos são protegidos; consumidores desconhecidos podem existir.",
  inputSchema: { provider: z.string(), project_id: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ provider, project_id }) => {
  try { return result(await combos.list(provider, project_id)); } catch (error) { return failure(error); }
});

server.registerTool("plan_combo", {
  outputSchema: outputSchemas.plan_combo,
  description: "Planeja criação ou nova versão de combo gerido pelo projeto. Não altera o backend; nunca sobrescreve combos existentes.",
  inputSchema: comboPlanInput.shape,
  annotations: { readOnlyHint: false, openWorldHint: true },
}, async input => {
  try { return result({ plan: await combos.plan(input) }); } catch (error) { return failure(error); }
});

server.registerTool("apply_combo_plan", {
  outputSchema: outputSchemas.apply_combo_plan,
  description: "Cria um combo novo conforme política privada, verifica o resultado e reconcilia respostas incertas sem repetir POST. Não modifica nem apaga combos anteriores.",
  inputSchema: { plan_id: z.string().uuid() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ plan_id }) => {
  try { return result({ plan: await combos.apply(plan_id) }); } catch (error) { return failure(error); }
});

server.registerTool("test_combo", {
  outputSchema: outputSchemas.test_combo,
  description: "Testa membros individuais com suítes fixas e até 64 tokens por requisição, sem fallback ou retries do MCP. Consome cota; exige allow_tests e allowlist privada. Não modifica combos nem avalia qualidade geral.",
  inputSchema: { provider: z.string(), project_id: z.string(), combo_id: z.string().min(1).max(200), models: z.array(z.string().min(1).max(300)).min(1).max(16).optional(), suite: z.enum(probeSuiteNames).default("availability-v1") },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ provider, project_id, combo_id, models, suite }) => {
  try { return result(await combos.testCombo(provider, project_id, combo_id, models, suite)); } catch (error) { return failure(error); }
});

server.registerTool("diagnose", {
  outputSchema: outputSchemas.diagnose,
  description: "Diagnóstico offline da versão carregada, agentes, provedores e diretórios. Não revela segredos, não consulta a rede nem executa inferência.",
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  try { return result(await diagnoseConfiguration()); } catch (error) { return failure(error); }
});

server.registerTool("inspect_state", {
  outputSchema: outputSchemas.inspect_state,
  description: "Inspeciona propriedade dos jobs, corrupção conhecida e reservas de orçamento. Não adota jobs, não remove locks nem reexecuta chamadas.",
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  try { return result({ jobs: await jobs.inspect(), budgets: await client.inspectBudgets(), locks: await inspectStateLocks(), mutated: false }); } catch (error) { return failure(error); }
});

server.registerTool("create_workflow", {
  outputSchema: outputSchemas.create_workflow,
  description: "Cria plano persistido de até oito etapas explícitas. Nenhuma inferência ou ferramenta local é executada ao criar.",
  inputSchema: workflowInputSchema.shape,
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async input => {
  try { return result({ workflow: await workflows.create(input) }); } catch (error) { return failure(error); }
});

server.registerTool("get_workflow", {
  outputSchema: outputSchemas.get_workflow,
  description: "Lê plano, jobs, propostas de ações e evidências persistidas sem avançar ou consumir inferência.",
  inputSchema: { workflow_id: z.uuid() }, annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ workflow_id }) => {
  try { return result({ workflow: await workflows.get(workflow_id) }); } catch (error) { return failure(error); }
});

server.registerTool("advance_workflow", {
  outputSchema: outputSchemas.advance_workflow,
  description: "Submete no máximo uma etapa, ou coleta seu resultado. Para antes de ações/revisão. Respostas são propostas não confiáveis; Codex controla ferramentas locais.",
  inputSchema: { workflow_id: z.uuid() }, annotations: { readOnlyHint: false, openWorldHint: true },
}, async ({ workflow_id }) => {
  try { return result({ workflow: await workflows.advance(workflow_id) }); } catch (error) { return failure(error); }
});

server.registerTool("approve_workflow_action", {
  outputSchema: outputSchemas.approve_workflow_action,
  description: "Registra aprovação/rejeição do Codex para uma proposta. NÃO concede permissões do sistema e NÃO executa a ação; respeite autorizações do usuário.",
  inputSchema: { workflow_id: z.uuid(), action_id: z.uuid(), approved: z.boolean() },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ workflow_id, action_id, approved }) => {
  try { return result({ workflow: await workflows.approveAction(workflow_id, action_id, approved) }); } catch (error) { return failure(error); }
});

server.registerTool("record_workflow_action", {
  outputSchema: outputSchemas.record_workflow_action,
  description: "Registra resultado e evidência de uma ação aprovada que o Codex executou com suas ferramentas. Não executa comandos nem atesta resultados por conta própria.",
  inputSchema: { workflow_id: z.uuid(), action_id: z.uuid(), success: z.boolean(), evidence: z.string().min(1).max(8000) },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ workflow_id, action_id, success, evidence }) => {
  try { return result({ workflow: await workflows.recordAction(workflow_id, action_id, success, evidence) }); } catch (error) { return failure(error); }
});

server.registerTool("review_workflow_step", {
  outputSchema: outputSchemas.review_workflow_step,
  description: "Codex verifica critérios e evidências, aceita ou rejeita a etapa. Aceitar prepara a próxima etapa, mas não a submete automaticamente.",
  inputSchema: { workflow_id: z.uuid(), accepted: z.boolean(), evidence: z.string().min(1).max(8000) },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ workflow_id, accepted, evidence }) => {
  try { return result({ workflow: await workflows.review(workflow_id, accepted, evidence) }); } catch (error) { return failure(error); }
});

server.registerTool("replan_workflow", {
  outputSchema: outputSchemas.replan_workflow,
  description: "Substitui explicitamente etapas pendentes de um workflow bloqueado, preservando o plano anterior. Limite de duas revisões e oito inferências no total; não repete ações locais.",
  inputSchema: { workflow_id: z.uuid(), steps: workflowInputSchema.shape.steps, reason: z.string().min(1).max(2000) },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ workflow_id, steps, reason }) => {
  try { return result({ workflow: await workflows.replan(workflow_id, steps, reason) }); } catch (error) { return failure(error); }
});

function options(input: { timeout_ms?: number; first_byte_timeout_ms?: number; idle_timeout_ms?: number; max_output_tokens?: number; retries?: number; expected_ids?: string[]; expected_text?: string; min_output_chars?: number }) {
  return {
    timeoutMs: input.timeout_ms, firstByteTimeoutMs: input.first_byte_timeout_ms,
    idleTimeoutMs: input.idle_timeout_ms, maxOutputTokens: input.max_output_tokens,
    retries: input.retries, expectedIds: input.expected_ids, expectedText: input.expected_text,
    minOutputChars: input.min_output_chars,
  };
}

function jobView(job: ReturnType<JobManager["get"]>, includeContent: boolean) {
  return {
    job_id: job.id, status: job.status, agent: job.input.agent.id,
    created_at: job.created_at, updated_at: job.updated_at,
    routing: job.input.routing,
    ...(includeContent ? { partial_content: job.partial_content, result: job.result, error: job.error, state: job.input.state } : {}),
  };
}

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function failure(error: unknown) {
  const data = { status: "error", error: serializeError(error) };
  return { ...result(data), isError: true };
}

await server.connect(new StdioServerTransport());
