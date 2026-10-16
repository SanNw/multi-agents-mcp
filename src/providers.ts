import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { Agent } from "./agents.js";
import { RouterClient, type DelegateOptions } from "./router-client.js";
import { ComboClient, managementSchema } from "./combo-client.js";
import { SharedBudget, budgetSchema } from "./budgets.js";
import { resolve, dirname } from "node:path";
import { RouterError } from "./errors.js";

const profileSchema = z.object({
  base_url: z.url(), api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  protocol: z.literal("openai-chat-completions").default("openai-chat-completions"),
  streaming: z.boolean().default(true),
  models: z.array(z.string().min(1)).min(1).optional(),
  management: managementSchema.optional(),
  limits: budgetSchema.optional(),
  max_input_chars: z.number().int().min(1).max(10000000).default(2000000),
  max_output_tokens: z.number().int().min(1).max(1000000).default(65536),
  max_response_bytes: z.number().int().min(1).max(100000000).default(2000000),
}).strict();
export const providerConfigSchema = z.object({ providers: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), profileSchema) }).strict();

export class ProviderRegistry {
  private readonly profiles = new Map<string, { client: RouterClient; streaming: boolean; models?: string[]; management?: ComboClient; budget?: SharedBudget;
    maxInput?: number; maxOutput?: number; maxResponse?: number }>();

  static async load(env = process.env) {
    const registry = new ProviderRegistry();
    registry.profiles.set("default", { client: new RouterClient(env), streaming: true });
    if (env.MULTIAGENTS_PROVIDERS_CONFIG) {
      const config = providerConfigSchema.parse(parse(await readFile(env.MULTIAGENTS_PROVIDERS_CONFIG, "utf8")));
      for (const [id, profile] of Object.entries(config.providers)) {
        if (profile.api_key_env && !env[profile.api_key_env]) throw new Error(`Credencial de ambiente ausente para provider ${id}`);
        if (profile.management && !env[profile.management.api_key_env]) throw new Error(`Credencial administrativa ausente para provider ${id}`);
        registry.profiles.set(id, { client: new RouterClient({ ...env, MULTIAGENTS_BASE_URL: profile.base_url,
          MULTIAGENTS_API_KEY: profile.api_key_env ? env[profile.api_key_env] : "" }), streaming: profile.streaming, models: profile.models,
          management: profile.management ? new ComboClient(profile.management, env[profile.management.api_key_env]!) : undefined,
          budget: profile.limits ? new SharedBudget(env.MULTIAGENTS_BUDGETS_DIR ?? resolve(dirname(env.MULTIAGENTS_JOBS_DIR ?? env.NINEROUTER_JOBS_DIR ?? "./.jobs"), ".budgets"), `${id}:${profile.base_url}`, profile.limits) : undefined,
          maxInput: profile.max_input_chars, maxOutput: profile.max_output_tokens, maxResponse: profile.max_response_bytes });
      }
    }
    return registry;
  }

  private find(id = "default") {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Provider desconhecido: ${id}`);
    return profile;
  }

  list() {
    return [...this.profiles].map(([id, profile]) => ({ id, protocol: "openai-chat-completions", streaming: profile.streaming,
      models_source: profile.models ? "configured" : "remote", api_key_configured: Boolean(profile.client.apiKey),
      shared_limits: Boolean(profile.budget),
      management: profile.management ? { adapter: profile.management.config.adapter, updates: "copy_on_write", projects: Object.keys(profile.management.config.projects) } : null }));
  }

  async models(id = "default") {
    const profile = this.find(id);
    return profile.models ? profile.models.map(id => ({ id })) : profile.client.models();
  }

  management(id: string) {
    const client = this.find(id).management;
    if (!client) throw new Error("Gestão de combos desativada para este provider");
    return client;
  }

  async inspectBudgets() {
    const results = [];
    for (const [provider, profile] of this.profiles) if (profile.budget) results.push({ provider, ...await profile.budget.inspect() });
    return results;
  }

  async delegate(agent: Agent, task: string, context?: string, instructions?: string, outputFormat?: string, options: DelegateOptions = {}) {
    const id = agent.provider ?? "default";
    const profile = this.find(id);
    const stream = options.stream && profile.streaming;
    const inputChars = [agent.description, task, context, instructions, outputFormat].reduce<number>((total, value) => total + (value?.length ?? 0), 0);
    const maxOutput = options.maxOutputTokens ?? agent.max_output_tokens;
    if (inputChars > (profile.maxInput ?? 2000000) || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > (profile.maxOutput ?? 65536)) throw new RouterError("Entrada ou limite de saída excede a política do provider", { code: "INPUT_LIMIT", retryable: false });
    const lease = await profile.budget?.acquire(agent.id, agent.concurrency, agent.project_id);
    let uncertain = false;
    try {
      const result = await profile.client.delegate(agent, task, context, instructions, outputFormat, { ...options, stream: Boolean(stream),
        maxResponseBytes: profile.maxResponse ?? 2000000,
        beforeAttempt: profile.budget && lease ? async (bytes, tokens) => { await profile.budget!.reserveAttempt(lease, bytes + tokens); } : undefined });
      uncertain = result.attempts.some(attempt => attempt.status === "error" && !/^HTTP_/.test(attempt.code ?? ""));
      return { ...result, provider: id };
    } catch (error) {
      const priorUnknown = error instanceof RouterError && error.attempts?.some(attempt => {
        const entry = attempt as { status?: string; code?: string };
        return entry.status === "error" && !/^HTTP_/.test(entry.code ?? "") && !["BUDGET_LIMIT", "INPUT_LIMIT", "CIRCUIT_OPEN"].includes(entry.code ?? "");
      });
      uncertain = Boolean(priorUnknown) || !(error instanceof RouterError && (error.status !== undefined || ["BUDGET_LIMIT", "INPUT_LIMIT", "CIRCUIT_OPEN"].includes(error.code)));
      throw error;
    } finally { if (profile.budget && lease) await profile.budget.finish(lease, uncertain); }
  }
}
