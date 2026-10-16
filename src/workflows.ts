import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Agent } from "./agents.js";
import type { JobManager } from "./jobs.js";

const relativePath = z.string().min(1).max(1000).refine(path =>
  !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => ["..", ".git", ".codex", ".npmrc", "id_rsa"].includes(part) || /^\.env(?:\.|$)/.test(part)) && !/^[a-z]:/i.test(path), "Use um caminho relativo ao workspace, sem arquivos privados");
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read_file"), path: relativePath }).strict(),
  z.object({ type: z.literal("propose_patch"), path: relativePath, patch: z.string().min(1).max(20000) }).strict(),
  z.object({ type: z.literal("run_tests"), command: z.array(z.string().min(1).max(1000)).min(1).max(20) }).strict(),
]);
const responseSchema = z.object({ summary: z.string().min(1).max(8000), actions: z.array(actionSchema).max(5) }).strict();
const stepSchema = z.object({ agent: z.string().min(1), task: z.string().min(1).max(20000), acceptance: z.string().min(1).max(2000),
  project_id: z.string().min(1).max(40).optional(), combo_id: z.string().min(1).max(200).optional(),
}).strict().refine(step => Boolean(step.project_id) === Boolean(step.combo_id), "Informe project_id e combo_id juntos");
export const workflowInputSchema = z.object({
  task: z.string().min(1).max(20000), context: z.string().max(80000).default(""),
  steps: z.array(stepSchema).min(1).max(8),
  timeout_ms: z.number().int().min(1000).max(180000).default(60000),
  max_output_tokens: z.number().int().min(1).max(4000).default(2000),
}).strict();
export type WorkflowInput = z.input<typeof workflowInputSchema>;
type Action = z.infer<typeof actionSchema> & {
  id: string; status: "proposed" | "approved" | "rejected" | "reported";
  result?: { success: boolean; evidence: string };
};
export type Workflow = {
  id: string; created_at: string; updated_at: string;
  status: "ready" | "running" | "awaiting_review" | "awaiting_actions" | "blocked" | "completed";
  input: z.output<typeof workflowInputSchema>; current_step: number;
  steps: Array<{ job_id?: string; submission_started?: boolean; summary?: string; actions: Action[]; evidence?: string }>;
  submissions: number;
  replans: Array<{ steps: Workflow["steps"]; reason: string }>;
  error?: string;
};
type Jobs = Pick<JobManager, "submit" | "refresh">;

export class WorkflowManager {
  constructor(private readonly jobs: Jobs, private readonly agents: () => Promise<Agent[]>,
    private readonly directory = process.env.MULTIAGENTS_WORKFLOWS_DIR ?? process.env.NINEROUTER_WORKFLOWS_DIR ?? resolve(dirname(process.env.MULTIAGENTS_JOBS_DIR ?? process.env.NINEROUTER_JOBS_DIR ?? "./.jobs"), ".workflows"),
    private readonly resolveAgent?: (agent: Agent, project?: string, combo?: string) => Promise<Agent>) {}

  async create(input: WorkflowInput) {
    const parsed = workflowInputSchema.parse(input);
    const agents = await this.agents();
    for (const step of parsed.steps) if (!agents.some(agent => agent.id === step.agent)) throw new Error(`Agente desconhecido: ${step.agent}`);
    const now = new Date().toISOString();
    const workflow: Workflow = { id: randomUUID(), created_at: now, updated_at: now, status: "ready", input: parsed,
      current_step: 0, submissions: 0, replans: [], steps: parsed.steps.map(() => ({ actions: [] })) };
    await mkdir(resolve(this.directory), { recursive: true, mode: 0o700 });
    await this.persist(workflow);
    return workflow;
  }

  async get(id: string) {
    z.uuid().parse(id);
    return JSON.parse(await readFile(resolve(this.directory, `${id}.json`), "utf8")) as Workflow;
  }

  async advance(id: string) {
    return this.change(id, async workflow => {
      if (!["ready", "running"].includes(workflow.status)) return;
      const step = workflow.steps[workflow.current_step]!;
      const specification = workflow.input.steps[workflow.current_step]!;
      if (!step.job_id) {
        if (step.submission_started || workflow.submissions >= 8) {
          workflow.status = "blocked"; workflow.error = "Submissão anterior incerta ou orçamento de oito chamadas esgotado; não repetir automaticamente"; return;
        }
        let agent = (await this.agents()).find(candidate => candidate.id === specification.agent);
        if (!agent) throw new Error("Agente da etapa não está mais configurado");
        if (specification.combo_id && !this.resolveAgent) throw new Error("Gestão de combos não disponível neste workflow");
        if (this.resolveAgent) agent = await this.resolveAgent(agent, specification.project_id, specification.combo_id);
        const previous = workflow.steps.slice(0, workflow.current_step).map((item, index) => ({
          step: index, summary: item.summary, evidence: item.evidence,
          action_results: item.actions.map(action => ({ type: action.type, result: action.result, status: action.status })),
        }));
        const context = [workflow.input.context, JSON.stringify({ objective: workflow.input.task, previous, replans: workflow.replans })].join("\n\n");
        if (context.length > 160000) throw new Error("Contexto do workflow excede o limite");
        step.submission_started = true; workflow.submissions++;
        await this.persist(workflow);
        const job = await this.jobs.submit({ agent, task: specification.task, context,
          combo_selection: specification.project_id && specification.combo_id ? { project_id: specification.project_id, combo_id: specification.combo_id } : undefined,
          instructions: `Critério de revisão pelo Codex: ${specification.acceptance}. Não execute ações nem alegue execução. Retorne somente JSON {"summary":"análise/proposta", "actions":[]}. Ações opcionais: read_file com path relativo; propose_patch com path e patch; run_tests com command como array de argumentos. Sem Markdown ou campos adicionais.`,
          options: { timeoutMs: workflow.input.timeout_ms, maxOutputTokens: workflow.input.max_output_tokens, retries: 0 },
          state: { decisions: [specification.acceptance], next_steps: ["Codex verifica ações e resultado antes de avançar"] } });
        step.job_id = job.id; workflow.status = "running";
        return;
      }
      const job = await this.jobs.refresh(step.job_id);
      if (["queued", "running"].includes(job.status)) return;
      if (job.status !== "success" || !job.result) {
        workflow.status = "blocked"; workflow.error = `Etapa interrompida: ${job.status}`; return;
      }
      try {
        const response = responseSchema.parse(JSON.parse(job.result.content));
        step.summary = response.summary;
        step.actions = response.actions.map(action => ({ ...action, id: randomUUID(), status: "proposed" }));
        workflow.status = step.actions.length ? "awaiting_actions" : "awaiting_review";
      } catch {
        workflow.status = "blocked"; workflow.error = "Resposta estruturada inválida; conteúdo preservado no job, sem executar ações";
      }
    });
  }

  async approveAction(id: string, actionId: string, approved: boolean) {
    return this.change(id, async workflow => {
      const action = workflow.steps[workflow.current_step]?.actions.find(item => item.id === actionId);
      if (!action || workflow.status !== "awaiting_actions") throw new Error("Ação não está pendente nesta etapa");
      const decision = approved ? "approved" : "rejected";
      if (action.status === decision) return;
      if (action.status !== "proposed") throw new Error("Decisão já registrada; não sobrescreva uma aprovação");
      action.status = decision;
      this.updateActions(workflow);
    });
  }

  async recordAction(id: string, actionId: string, success: boolean, evidence: string) {
    z.string().min(1).max(8000).parse(evidence);
    return this.change(id, async workflow => {
      const action = workflow.steps[workflow.current_step]?.actions.find(item => item.id === actionId);
      if (!action) throw new Error("Ação desconhecida nesta etapa");
      if (action.status === "reported") {
        if (action.result?.success === success && action.result.evidence === evidence) return;
        throw new Error("Resultado já registrado; não substitua evidências");
      }
      if (action.status !== "approved" || workflow.status !== "awaiting_actions") throw new Error("A ação precisa de aprovação antes de registrar execução pelo Codex");
      action.result = { success, evidence }; action.status = "reported";
      this.updateActions(workflow);
    });
  }

  async review(id: string, accepted: boolean, evidence: string) {
    z.string().min(1).max(8000).parse(evidence);
    return this.change(id, async workflow => {
      if (workflow.status !== "awaiting_review") throw new Error("Etapa ainda não está pronta para revisão");
      const step = workflow.steps[workflow.current_step]!;
      if (accepted && step.actions.some(action => action.status === "rejected" || action.result?.success === false)) throw new Error("Há ações rejeitadas ou malsucedidas; rejeite a etapa e replaneje");
      step.evidence = evidence;
      if (!accepted) { workflow.status = "blocked"; workflow.error = "Etapa rejeitada pelo Codex; replanejamento explícito necessário"; return; }
      workflow.current_step++;
      workflow.status = workflow.current_step === workflow.steps.length ? "completed" : "ready";
    });
  }

  async replan(id: string, steps: z.infer<typeof stepSchema>[], reason: string) {
    z.string().min(1).max(2000).parse(reason);
    z.array(stepSchema).min(1).max(8).parse(steps);
    return this.change(id, async workflow => {
      if (workflow.status !== "blocked" || workflow.replans.length >= 2 || workflow.submissions >= 8) throw new Error("Replanejamento só é permitido em workflow bloqueado, com orçamento e no máximo duas revisões de plano");
      if (workflow.current_step + steps.length > 8) throw new Error("Plano excede oito etapas");
      const agents = await this.agents();
      if (steps.some(step => !agents.some(agent => agent.id === step.agent))) throw new Error("Agente desconhecido no plano");
      workflow.replans.push({ reason, steps: structuredClone(workflow.steps.slice(workflow.current_step)) });
      workflow.input.steps = [...workflow.input.steps.slice(0, workflow.current_step), ...steps];
      workflow.steps = [...workflow.steps.slice(0, workflow.current_step), ...steps.map(() => ({ actions: [] }))];
      delete workflow.error; workflow.status = "ready";
    });
  }

  private updateActions(workflow: Workflow) {
    if (workflow.steps[workflow.current_step]!.actions.every(action => ["reported", "rejected"].includes(action.status))) workflow.status = "awaiting_review";
  }

  private async change(id: string, operation: (workflow: Workflow) => Promise<void>) {
    z.uuid().parse(id);
    const lockPath = resolve(this.directory, `${id}.lock`);
    // Exclusive per-workflow lock prevents duplicate submissions across MCP processes.
    const lock = await open(lockPath, "wx", 0o600);
    try {
      const workflow = await this.get(id);
      await operation(workflow);
      workflow.updated_at = new Date().toISOString();
      await this.persist(workflow);
      return workflow;
    } finally { await lock.close(); await unlink(lockPath); }
  }

  private async persist(workflow: Workflow) {
    const file = resolve(this.directory, `${workflow.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(workflow, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  }
}
