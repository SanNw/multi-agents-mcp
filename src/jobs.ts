import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname } from "node:os";
import type { Agent } from "./agents.js";
import { serializeError } from "./errors.js";
import type { DelegateOptions, DelegateResult, RouterClient } from "./router-client.js";

export type JobInput = {
  agent: Agent;
  task: string;
  context?: string;
  instructions?: string;
  output_format?: string;
  routing?: Record<string, unknown>;
  state?: Record<string, string[]>;
  options?: Pick<DelegateOptions, "timeoutMs" | "firstByteTimeoutMs" | "idleTimeoutMs" | "maxOutputTokens" | "retries" | "expectedIds" | "expectedText" | "minOutputChars">;
};

export type Job = {
  id: string;
  status: "queued" | "running" | "success" | "degraded" | "error" | "cancelled" | "interrupted";
  created_at: string;
  updated_at: string;
  input: JobInput;
  partial_content: string;
  result?: DelegateResult;
  error?: ReturnType<typeof serializeError>;
  owner?: { pid: number; host: string; identity: string };
};

type Runner = Pick<RouterClient, "delegate">;

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queues = new Map<string, string[]>();
  private readonly active = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly checkpointAt = new Map<string, number>();

  constructor(private readonly runner: Runner, private readonly directory = process.env.MULTIAGENTS_JOBS_DIR ?? process.env.NINEROUTER_JOBS_DIR ?? "./.jobs") {}

  async init() {
    await mkdir(resolve(this.directory), { recursive: true, mode: 0o700 });
    for (const name of await readdir(resolve(this.directory))) {
      if (!name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(resolve(this.directory, name), "utf8")) as Job;
        if ((job.status === "queued" || job.status === "running") && job.owner &&
          job.owner.host === hostname() && await processIdentity(job.owner.pid) !== job.owner.identity) {
          job.status = "interrupted";
          job.updated_at = new Date().toISOString();
          job.error = serializeError(new Error("Processo encerrado antes da conclusão"));
          await this.persist(job);
        }
        this.jobs.set(job.id, job);
      } catch { /* arquivo alheio ou corrompido: não derruba o servidor */ }
    }
  }

  async submit(input: JobInput) {
    const now = new Date().toISOString();
    const identity = await processIdentity(process.pid);
    if (!identity) throw new Error("Não foi possível identificar o processo WSL para preservar a propriedade da tarefa");
    const job: Job = { id: randomUUID(), status: "queued", created_at: now, updated_at: now, input, partial_content: "",
      owner: { pid: process.pid, host: hostname(), identity } };
    this.jobs.set(job.id, job);
    await this.persist(job);
    const queue = this.queues.get(input.agent.id) ?? [];
    queue.push(job.id);
    this.queues.set(input.agent.id, queue);
    void this.pump(input.agent.id).catch((error) => console.error("job queue failed", serializeError(error)));
    return job;
  }

  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Tarefa desconhecida: ${id}`);
    return job;
  }

  async refresh(id: string) {
    if (!this.controllers.has(id) && ![...this.queues.values()].some(queue => queue.includes(id))) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Identificador de tarefa inválido");
      const job = JSON.parse(await readFile(resolve(this.directory, `${id}.json`), "utf8")) as Job;
      this.jobs.set(id, job);
    }
    return this.get(id);
  }

  list(limit = 20) {
    return [...this.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  async cancel(id: string) {
    const job = await this.refresh(id);
    if (["success", "degraded", "error", "cancelled", "interrupted"].includes(job.status)) return job;
    if (!this.controllers.has(id) && !this.queues.get(job.input.agent.id)?.includes(id)) throw new Error("Tarefa pertence a outra sessão; cancele na sessão que a iniciou");
    this.controllers.get(id)?.abort(new Error("cancelled by user"));
    const queue = this.queues.get(job.input.agent.id);
    if (queue) this.queues.set(job.input.agent.id, queue.filter((candidate) => candidate !== id));
    job.status = "cancelled";
    job.updated_at = new Date().toISOString();
    await this.persist(job);
    return job;
  }

  async retry(id: string) {
    const job = await this.refresh(id);
    if (!["degraded", "error", "cancelled", "interrupted"].includes(job.status)) throw new Error("Só é possível repetir uma tarefa encerrada sem sucesso");
    return this.submit(job.input);
  }

  private async pump(agentId: string) {
    const queue = this.queues.get(agentId) ?? [];
    const first = queue[0] ? this.jobs.get(queue[0]) : undefined;
    if (!first || (this.active.get(agentId) ?? 0) >= first.input.agent.concurrency) return;
    queue.shift();
    this.active.set(agentId, (this.active.get(agentId) ?? 0) + 1);
    await this.run(first);
    this.active.set(agentId, Math.max(0, (this.active.get(agentId) ?? 1) - 1));
    void this.pump(agentId).catch((error) => console.error("job queue failed", serializeError(error)));
  }

  private async run(job: Job) {
    const controller = new AbortController();
    let finalStatus: Job["status"] = "error";
    this.controllers.set(job.id, controller);
    job.status = "running";
    job.updated_at = new Date().toISOString();
    await this.persist(job);
    try {
      job.result = await this.runner.delegate(
        job.input.agent, job.input.task, job.input.context, job.input.instructions, job.input.output_format,
        {
          ...job.input.options,
          stream: job.input.agent.stream ?? true,
          signal: controller.signal,
          onProgress: async ({ content }) => {
            job.partial_content = content;
            const now = Date.now();
            if (now - (this.checkpointAt.get(job.id) ?? 0) >= 1_000) {
              this.checkpointAt.set(job.id, now);
              job.updated_at = new Date(now).toISOString();
              await this.persist(job);
            }
          },
        },
      );
      if (!job.partial_content) job.partial_content = job.result.content;
      finalStatus = controller.signal.aborted ? "cancelled" : job.result.status;
    } catch (error) {
      if (controller.signal.aborted) {
        finalStatus = "cancelled";
      } else {
        finalStatus = "error";
        job.error = serializeError(error);
      }
    } finally {
      // Publish terminal status only after its result is durable on disk.
      const completed = { ...job, status: finalStatus, updated_at: new Date().toISOString() };
      await this.persist(completed);
      Object.assign(job, completed);
      this.controllers.delete(job.id);
      this.checkpointAt.delete(job.id);
    }
  }

  private async persist(job: Job) {
    const file = resolve(this.directory, `${job.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }
}

async function processIdentity(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return `${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${start}`;
  } catch { return undefined; }
}
