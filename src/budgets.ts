import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { RouterError } from "./errors.js";

const caps = z.object({
  max_concurrent: z.number().int().min(1).max(1000),
  max_requests: z.number().int().min(1), max_reserved_tokens: z.number().int().min(1),
}).strict();
export const budgetSchema = caps.extend({ window_ms: z.number().int().min(1).max(86400000), projects: z.record(z.string().min(1), caps).optional() }).strict();
type Policy = z.infer<typeof budgetSchema>;
const leaseSchema = z.object({ agent: z.string(), concurrency: z.number().int().positive(), project: z.string().optional(),
  state: z.enum(["active", "uncertain"]), attempts: z.number().int().nonnegative(), created_at: z.string(), owner_pid: z.number().int().positive().optional(), owner_session: z.uuid().optional() });
const stateSchema = z.object({ version: z.literal(1), window_started: z.number(), requests: z.number().nonnegative(), tokens: z.number().nonnegative(),
  projects: z.record(z.string(), z.object({ requests: z.number().nonnegative(), tokens: z.number().nonnegative() })),
  leases: z.record(z.string().uuid(), leaseSchema) });
type State = z.infer<typeof stateSchema>;
const denied = (message: string) => new RouterError(message, { code: "BUDGET_LIMIT", retryable: false });

export class SharedBudget {
  private readonly key: string;
  private readonly session = randomUUID();
  constructor(private readonly directory: string, identity: string, private readonly policy: Policy) {
    budgetSchema.parse(policy);
    this.key = createHash("sha256").update(identity).digest("hex");
  }

  async acquire(agent: string, concurrency: number, project?: string) {
    return this.change(state => {
      const projectPolicy = this.projectPolicy(project);
      const leases = Object.values(state.leases);
      if (leases.length >= this.policy.max_concurrent || leases.filter(lease => lease.agent === agent).length >= concurrency ||
        (projectPolicy && leases.filter(lease => lease.project === project).length >= projectPolicy.max_concurrent)) throw denied("Limite de concorrência compartilhada atingido; verifique operações incertas");
      const id = randomUUID();
      state.leases[id] = { agent, concurrency, project, state: "active", attempts: 0, created_at: new Date().toISOString(), owner_pid: process.pid, owner_session: this.session };
      return id;
    });
  }

  async reserveAttempt(id: string, tokens: number) {
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw denied("Reserva de tokens inválida");
    await this.change(state => {
      const lease = state.leases[id];
      if (!lease || lease.state !== "active") throw denied("Reserva de execução ausente ou incerta");
      const policy = this.projectPolicy(lease.project);
      const project = lease.project ? state.projects[lease.project] ?? { requests: 0, tokens: 0 } : undefined;
      if (state.requests + 1 > this.policy.max_requests || state.tokens + tokens > this.policy.max_reserved_tokens ||
        (policy && project && (project.requests + 1 > policy.max_requests || project.tokens + tokens > policy.max_reserved_tokens))) throw denied("Limite de cota compartilhada atingido");
      state.requests++; state.tokens += tokens; lease.attempts++;
      if (project && lease.project) { project.requests++; project.tokens += tokens; state.projects[lease.project] = project; }
    });
  }

  async finish(id: string, uncertain: boolean) {
    await this.change(state => {
      const lease = state.leases[id];
      if (!lease) return;
      if (uncertain && lease.attempts) lease.state = "uncertain";
      else delete state.leases[id];
    });
  }

  async inspect() {
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Diretório de orçamento não é privado");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const state = await this.read();
    const leases = Object.values(state.leases);
    return { window_started: state.window_started, requests_reserved: state.requests, tokens_reserved: state.tokens,
      active: leases.filter(lease => lease.state === "active").length, uncertain: leases.filter(lease => lease.state === "uncertain").length,
      leases: Object.entries(state.leases).map(([id, lease]) => ({ id, agent: lease.agent, project: lease.project, status: lease.state,
        attempts: lease.attempts, created_at: lease.created_at, owner_pid: lease.owner_pid ?? null, owner_session: lease.owner_session ?? null })),
      recovery: "inspect_owner_and_backend_before_manual_reconciliation" };
  }

  private projectPolicy(project?: string) {
    if (!this.policy.projects) return undefined;
    if (!project || !this.policy.projects[project]) throw denied("Projeto ausente ou não autorizado na política de cota");
    return this.policy.projects[project];
  }

  private async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Estado de orçamento deve usar diretório privado 0700; Windows nativo exige validação de ACL não disponível");
  }

  private async read(): Promise<State> {
    let file;
    try { file = await open(resolve(this.directory, this.key + ".json"), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Não foi possível ler o estado de orçamento");
      return { version: 1, window_started: Date.now(), requests: 0, tokens: 0, projects: {}, leases: {} };
    }
    try {
      if ((await file.stat()).size > 2000000) throw new Error("Estado de orçamento excede o limite");
      return stateSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally { await file.close(); }
  }

  private async change<T>(operation: (state: State) => T): Promise<T> {
    await this.init();
    const lockPath = resolve(this.directory, this.key + ".lock");
    let lock;
    for (let attempt = 0; attempt < 500; attempt++) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (!lock) throw denied("Estado de orçamento ocupado; lock exige inspeção, não remoção por idade");
    try {
      const state = await this.read();
      if (Date.now() - state.window_started >= this.policy.window_ms) {
        state.window_started = Date.now(); state.requests = 0; state.tokens = 0; state.projects = {};
      }
      const result = operation(state);
      const temporary = resolve(this.directory, `${this.key}.${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, resolve(this.directory, this.key + ".json"));
      return result;
    } finally { await lock.close(); await unlink(lockPath); }
  }
}
