import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
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
  combo_selection?: { project_id: string; combo_id: string };
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
  owner?: { pid: number; host: string; identity: string; session?: string };
  persistence_uncertain?: boolean;
};

type Runner = Pick<RouterClient, "delegate">;

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly history = new Map<string, Job>();
  private readonly unreadable: string[] = [];
  private readonly session = randomUUID();
  private pendingSubmissions = 0;
  private readonly queues = new Map<string, string[]>();
  private readonly active = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly checkpointAt = new Map<string, number>();

  constructor(private readonly runner: Runner, private readonly directory = process.env.MULTIAGENTS_JOBS_DIR ?? process.env.NINEROUTER_JOBS_DIR ?? "./.jobs",
    private readonly validateInput?: (input: JobInput) => Promise<void>,
    private readonly runtime: { platform?: NodeJS.Platform; identity?: (pid: number) => Promise<string | undefined> } = {}) {}

  async init() {
    await mkdir(resolve(this.directory), { recursive: true, mode: 0o700 });
    for (const name of await readdir(resolve(this.directory))) {
      if (!name.endsWith(".json")) continue;
      try {
        if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
        let job: Job;
        try {
          const metadata = JSON.parse(await readFile(resolve(this.directory, `${name}.meta`), "utf8"));
          const body = await stat(resolve(this.directory, name));
          if (metadata.bytes !== body.size || metadata.modified !== body.mtimeMs) throw new Error("Stale metadata");
          job = metadata.job as Job;
        }
        catch { job = JSON.parse(await readFile(resolve(this.directory, name), "utf8")) as Job; }
        if (job.id !== name.slice(0, -5) || !job.input?.agent || !job.status) throw new Error("Invalid job");
        if ((job.status === "queued" || job.status === "running") && job.owner &&
          job.owner.host === hostname() && await this.ownership(job) === "gone") {
          job = JSON.parse(await readFile(resolve(this.directory, name), "utf8")) as Job;
          job.status = "interrupted";
          job.updated_at = new Date().toISOString();
          job.error = serializeError(new Error("Processo encerrado antes da conclusão"));
          await this.persist(job);
        }
        this.history.set(job.id, summarize(job));
      } catch { this.unreadable.push(name.slice(0, -5)); }
    }
  }

  async submit(input: JobInput) {
    const maximum = Number(process.env.MULTIAGENTS_MAX_QUEUED_JOBS ?? 1000);
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("MULTIAGENTS_MAX_QUEUED_JOBS deve ser inteiro positivo");
    const queued = [...this.queues.values()].reduce((count, queue) => count + queue.length, 0);
    if (queued + this.pendingSubmissions >= maximum) throw new Error("Limite da fila de tarefas atingido");
    this.pendingSubmissions++;
    try {
    const now = new Date().toISOString();
    const identity = await (this.runtime.identity ?? processIdentity)(process.pid);
    const job: Job = { id: randomUUID(), status: "queued", created_at: now, updated_at: now, input, partial_content: "",
      owner: { pid: process.pid, host: hostname(), identity: identity ?? `session:${this.session}`, session: this.session } };
    await this.persist(job);
    this.jobs.set(job.id, job);
    const queue = this.queues.get(input.agent.id) ?? [];
    queue.push(job.id);
    this.queues.set(input.agent.id, queue);
    void this.pump(input.agent.id).catch((error) => console.error("job queue failed", serializeError(error)));
    return job;
    } finally { this.pendingSubmissions--; }
  }

  get(id: string) {
    const job = this.jobs.get(id);
    if (job) return job;
    if (!this.history.has(id)) throw new Error(`Tarefa desconhecida: ${id}`);
    return JSON.parse(readFileSync(resolve(this.directory, `${id}.json`), "utf8")) as Job;
  }

  async refresh(id: string) {
    if (this.jobs.get(id)?.persistence_uncertain) return this.get(id);
    if (!this.controllers.has(id) && ![...this.queues.values()].some(queue => queue.includes(id))) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Identificador de tarefa inválido");
      const job = JSON.parse(await readFile(resolve(this.directory, `${id}.json`), "utf8")) as Job;
      this.history.set(id, summarize(job));
      return job;
    }
    return this.get(id);
  }

  list(limit = 20, offset = 0) {
    const entries = new Map(this.history);
    for (const job of this.jobs.values()) entries.set(job.id, summarize(job));
    return [...entries.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(offset, offset + limit);
  }

  async inspect() {
    return { queued: [...this.queues.values()].reduce((count, queue) => count + queue.length, 0), pending_submissions: this.pendingSubmissions,
      active: [...this.active.values()].reduce((count, active) => count + active, 0),
      jobs: await Promise.all(this.list(Number.MAX_SAFE_INTEGER).map(async job => ({ id: job.id, status: job.status,
      ownership: await this.ownership(job), persistence_uncertain: job.persistence_uncertain ?? false }))), unreadable: [...this.unreadable] };
  }

  private async ownership(job: Job): Promise<"local" | "alive" | "gone" | "unknown"> {
    if (!job.owner || job.owner.host !== hostname()) return "unknown";
    if (job.owner.session === this.session) return "local";
    if ((this.runtime.platform ?? process.platform) !== "linux" || job.owner.identity.startsWith("session:")) return "unknown";
    const identity = await (this.runtime.identity ?? processIdentity)(job.owner.pid);
    if (identity) return identity === job.owner.identity ? "alive" : "gone";
    try { process.kill(job.owner.pid, 0); return "unknown"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
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
    if (job.persistence_uncertain) throw new Error("Estado incerto: inspecione a persistência antes de repetir");
    if (!["degraded", "error", "cancelled", "interrupted"].includes(job.status)) throw new Error("Só é possível repetir uma tarefa encerrada sem sucesso");
    return this.submit(job.input);
  }

  private async pump(agentId: string) {
    const queue = this.queues.get(agentId) ?? [];
    const first = queue[0] ? this.jobs.get(queue[0]) : undefined;
    if (!first || (this.active.get(agentId) ?? 0) >= first.input.agent.concurrency) return;
    queue.shift();
    this.active.set(agentId, (this.active.get(agentId) ?? 0) + 1);
    try { await this.run(first); }
    finally {
      this.active.set(agentId, Math.max(0, (this.active.get(agentId) ?? 1) - 1));
      void this.pump(agentId).catch((error) => console.error("job queue failed", serializeError(error)));
    }
  }

  private async run(job: Job) {
    const controller = new AbortController();
    let finalStatus: Job["status"] = "error";
    this.controllers.set(job.id, controller);
    job.status = "running";
    job.updated_at = new Date().toISOString();
    try {
      await this.persist(job);
      if (this.validateInput) await this.validateInput(job.input);
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
      try {
        await this.persist(completed);
        Object.assign(job, completed);
      } catch (error) {
        Object.assign(job, { status: "interrupted", persistence_uncertain: true, error: serializeError(error) });
      } finally {
        this.controllers.delete(job.id);
        this.checkpointAt.delete(job.id);
        this.history.set(job.id, summarize(job));
        if (!job.persistence_uncertain) this.jobs.delete(job.id);
      }
    }
  }

  private async persist(job: Job) {
    const file = resolve(this.directory, `${job.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    const metadata = `${file}.meta`;
    const metadataTemporary = `${metadata}.${randomUUID()}.tmp`;
    const body = await stat(file);
    await writeFile(metadataTemporary, JSON.stringify({ job: summarize(job), bytes: body.size, modified: body.mtimeMs }), { encoding: "utf8", mode: 0o600 });
    await rename(metadataTemporary, metadata);
  }
}

function summarize(job: Job): Job {
  return { ...job, input: { agent: job.input.agent, task: "", routing: job.input.routing }, partial_content: "",
    result: job.result ? { ...job.result, content: "" } : undefined };
}

async function processIdentity(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return `${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${start}`;
  } catch { return undefined; }
}
