import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Agent } from "./agents.js";
import { comboSchema, consumerReferences, memberModels, usesRoute, type Combo, type ComboDefinition } from "./combo-client.js";
import { serializeError } from "./errors.js";
import type { ProviderRegistry } from "./providers.js";

const uuid = z.string().uuid();
export const comboPlanInput = z.object({
  provider: z.string().min(1), project_id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/),
  models: z.array(z.string().min(1).max(300)).min(1).max(16),
  source_combo_id: z.string().min(1).max(200).optional(),
}).strict();
const definitionSchema = z.object({ name: z.string().max(100), models: z.array(z.string()), strategy: z.enum(["priority", "backend-default"]) }).strict();
const planSchema = z.object({
  id: uuid, provider: z.string(), project_id: z.string(), created_at: z.string(),
  endpoint: z.string(), definition: definitionSchema, source: comboSchema.optional(),
  status: z.enum(["proposed", "applying", "uncertain", "applied"]), result: comboSchema.optional(),
}).strict();
type Plan = z.infer<typeof planSchema>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (combo: Combo, definition: ComboDefinition) => combo.name === definition.name && combo.strategy === definition.strategy && JSON.stringify(memberModels(combo)) === JSON.stringify(definition.models);

export class ComboManager {
  constructor(private readonly providers: ProviderRegistry, private readonly directory = process.env.MULTIAGENTS_COMBOS_DIR ?? resolve(dirname(process.env.MULTIAGENTS_JOBS_DIR ?? process.env.NINEROUTER_JOBS_DIR ?? "./.jobs"), ".combos")) {}

  private policy(provider: string, project: string) {
    const client = this.providers.management(provider);
    const policy = client.config.projects[project];
    if (!policy) throw new Error("Projeto não autorizado pela política de combos");
    return { client, policy };
  }

  async list(provider: string, project?: string) {
    const client = this.providers.management(provider);
    if (project) this.policy(provider, project);
    const [combos, plans, consumers] = await Promise.all([client.list(), this.plans(), consumerReferences(client.config)]);
    return { combos: combos.map(combo => {
      const owner = plans.find(plan => plan.provider === provider && plan.status === "applied" && plan.result?.id === combo.id && digest(plan.result) === digest(combo));
      const users = [...new Set(consumers.references.filter(reference => usesRoute(reference.route, combo.name)).map(reference => reference.consumer))];
      return { ...combo, project_id: owner?.project_id ?? null, managed: Boolean(owner),
        protected: !owner || users.length > 0 || client.config.protected_routes.some(route => usesRoute(route, combo.name)), consumers: users };
    }), consumer_scan: { configured: client.config.consumers.length, unavailable: consumers.unavailable, coverage: "explicit_config_files_only" },
    updates: "copy_on_write", external_consumers_may_exist: true };
  }

  async plan(input: z.input<typeof comboPlanInput>): Promise<Plan> {
    const parsed = comboPlanInput.parse(input);
    const { client, policy } = this.policy(parsed.provider, parsed.project_id);
    this.validateModels(parsed.models, policy.models);
    const combos = await client.list();
    let source: Combo | undefined;
    if (parsed.source_combo_id) {
      source = await this.owned(parsed.provider, parsed.project_id, parsed.source_combo_id, combos);
    }
    const id = randomUUID();
    const plan: Plan = { id, provider: parsed.provider, project_id: parsed.project_id, created_at: new Date().toISOString(),
      endpoint: digest({ url: client.config.base_url, adapter: client.config.adapter }), status: "proposed", source,
      definition: { name: `mcp-${parsed.project_id}-${parsed.name}-${id.slice(0, 8)}`, models: parsed.models, strategy: client.config.adapter === "9router" ? "backend-default" : "priority" } };
    await this.validateDestination(plan, combos);
    await this.persist(plan);
    return plan;
  }

  async apply(id: string): Promise<Plan> {
    uuid.parse(id);
    return this.lock(async () => {
      const plan = await this.read(id);
      const { client, policy } = this.policy(plan.provider, plan.project_id);
      if (plan.endpoint !== digest({ url: client.config.base_url, adapter: client.config.adapter })) throw new Error("Endpoint do plano mudou; crie outro plano");
      if (!(plan.source ? policy.allow_update : policy.allow_create)) throw new Error("Escrita não autorizada pela política de combos");
      this.validateModels(plan.definition.models, policy.models);
      const combos = await client.list();
      if (plan.status === "applied") {
        const current = combos.find(combo => combo.id === plan.result?.id);
        if (!current || !same(current, plan.definition)) throw new Error("Combo alterado externamente ou removido");
        return plan;
      }
      if (["applying", "uncertain"].includes(plan.status)) {
        const existing = combos.find(combo => combo.name === plan.definition.name);
        if (!existing || !same(existing, plan.definition)) throw new Error("Criação incerta: reconciliação necessária, sem repetir POST");
        plan.status = "applied"; plan.result = existing; await this.persist(plan); return plan;
      }
      if (plan.source) {
        const current = await this.owned(plan.provider, plan.project_id, plan.source.id, combos);
        if (digest(current) !== digest(plan.source)) throw new Error("Origem mudou desde o planejamento");
      }
      await this.validateDestination(plan, combos);
      const owned = (await this.plans()).filter(candidate => candidate.provider === plan.provider && candidate.project_id === plan.project_id && candidate.status === "applied");
      if (owned.length >= policy.max_combos) throw new Error("Limite de combos do projeto atingido");
      plan.status = "applying"; await this.persist(plan);
      try {
        const created = await client.create(plan.definition);
        const verified = (await client.list()).find(combo => combo.id === created.id);
        if (!verified || !same(verified, plan.definition)) throw new Error("Falha na verificação após criação");
        plan.result = verified; plan.status = "applied";
      } catch { plan.status = "uncertain"; }
      await this.persist(plan);
      return plan;
    });
  }

  async resolveAgent(agent: Agent, project?: string, comboId?: string): Promise<Agent> {
    if (!project && !comboId) return agent;
    if (!project || !comboId) throw new Error("Informe project_id e combo_id juntos");
    const provider = agent.provider ?? "default";
    this.policy(provider, project);
    const combo = await this.owned(provider, project, comboId, await this.providers.management(provider).list());
    return { ...agent, route: combo.name, fallback_routes: [], route_strategy: "fallback" };
  }

  async testCombo(provider: string, project: string, id: string, selected?: string[]) {
    const { client, policy } = this.policy(provider, project);
    if (!policy.allow_tests) throw new Error("Testes não autorizados pela política de combos");
    const combo = (await client.list()).find(candidate => candidate.id === id);
    if (!combo) throw new Error("Combo desconhecido");
    const members = memberModels(combo);
    const models = selected ?? [...new Set(members)];
    this.validateModels(models, policy.models);
    if (models.some(model => !members.includes(model))) throw new Error("Modelo não pertence ao combo");
    if (models.length > policy.max_test_models) throw new Error("Limite de modelos por teste excedido; selecione um subconjunto");
    const catalog = new Set((await this.providers.models(provider)).map(model => model.id));
    const comboNames = new Set((await client.list()).map(item => item.name));
    if (models.some(model => !catalog.has(model) || comboNames.has(model))) throw new Error("Modelo não está no catálogo ou referencia outro combo");
    const results = [];
    for (const model of models) {
      const started = Date.now();
      const agent: Agent = { id: "combo-probe", provider, route: model, role: "probe", description: "Bounded model availability probe",
        fallback_routes: [], route_strategy: "fallback", temperature: 0, timeout_ms: 20000,
        first_byte_timeout_ms: 15000, idle_timeout_ms: 15000, max_output_tokens: 64, retries: 0, concurrency: 1, stream: false };
      try {
        const response = await this.providers.delegate(agent, "Reply exactly: OK", undefined, undefined, "Plain text", {
          timeoutMs: 20000, firstByteTimeoutMs: 15000, maxOutputTokens: 64, retries: 0, expectedText: "OK", minOutputChars: 2 });
        results.push({ model, status: response.status, elapsed_ms: Date.now() - started, response: response.content.slice(0, 500),
          effective_model: response.effective_model, usage: response.usage, reported_model_matches_request: response.effective_model === model });
      } catch (error) {
        results.push({ model, status: "error", elapsed_ms: Date.now() - started, error: serializeError(error) });
      }
    }
    return { combo_id: id, results, mutates_combo: false, retries: 0, max_output_tokens_per_model: 64, quality_evaluation: false };
  }

  private validateModels(models: string[], allowed: string[]) {
    if (!models.length || new Set(models).size !== models.length || models.some(model => !allowed.includes(model))) throw new Error("Modelos duplicados, vazios ou fora da política");
  }

  private async validateDestination(plan: Plan, combos: Combo[]) {
    const client = this.providers.management(plan.provider);
    const consumers = await consumerReferences(client.config);
    const names = [...combos.map(combo => combo.name), ...client.config.protected_routes, ...consumers.references.map(reference => reference.route),
      ...(await this.providers.models(plan.provider)).map(model => model.id)];
    if (names.some(name => usesRoute(name, plan.definition.name))) throw new Error("Nome de combo já utilizado ou protegido");
    const catalog = new Set((await this.providers.models(plan.provider)).map(model => model.id));
    if (plan.definition.models.some(model => !catalog.has(model) || combos.some(combo => combo.name === model))) throw new Error("Modelo ausente do catálogo ou combo aninhado não suportado");
  }

  private async owned(provider: string, project: string, id: string, combos: Combo[]) {
    const owner = (await this.plans()).find(plan => plan.provider === provider && plan.project_id === project && plan.status === "applied" && plan.result?.id === id);
    const combo = combos.find(candidate => candidate.id === id);
    if (!owner || !combo || digest(combo) !== digest(owner.result)) throw new Error("Combo externo, protegido, alterado ou pertencente a outro projeto");
    return combo;
  }

  private async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Diretório de combos deve ser privado e sem symlink");
  }

  private async read(id: string) {
    uuid.parse(id);
    const file = await open(resolve(this.directory, id + ".json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > 100000) throw new Error("Plano excede o limite");
      const plan = planSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (plan.id !== id) throw new Error("Identificador de plano incompatível");
      return plan;
    } finally { await file.close(); }
  }

  private async plans() {
    await this.init();
    const files = (await readdir(this.directory)).filter(name => uuid.safeParse(name.replace(/\.json$/, "")).success && name.endsWith(".json"));
    return Promise.all(files.map(file => this.read(file.slice(0, -5))));
  }

  private async persist(plan: Plan) {
    await this.init();
    const temporary = resolve(this.directory, `${plan.id}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(plan)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, resolve(this.directory, plan.id + ".json"));
  }

  private async lock<T>(operation: () => Promise<T>) {
    await this.init();
    const path = resolve(this.directory, "write.lock");
    const lock = await open(path, "wx", 0o600).catch(() => { throw new Error("Outra operação ou recuperação pendente detém o lock de combos"); });
    try { return await operation(); } finally { await lock.close(); await unlink(path); }
  }
}
