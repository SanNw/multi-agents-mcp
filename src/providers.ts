import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { Agent } from "./agents.js";
import { RouterClient, type DelegateOptions } from "./router-client.js";
import { ComboClient, managementSchema } from "./combo-client.js";

const profileSchema = z.object({
  base_url: z.url(), api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  protocol: z.literal("openai-chat-completions").default("openai-chat-completions"),
  streaming: z.boolean().default(true),
  models: z.array(z.string().min(1)).min(1).optional(),
  management: managementSchema.optional(),
}).strict();
const configSchema = z.object({ providers: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), profileSchema) }).strict();

export class ProviderRegistry {
  private readonly profiles = new Map<string, { client: RouterClient; streaming: boolean; models?: string[]; management?: ComboClient }>();

  static async load(env = process.env) {
    const registry = new ProviderRegistry();
    registry.profiles.set("default", { client: new RouterClient(env), streaming: true });
    if (env.MULTIAGENTS_PROVIDERS_CONFIG) {
      const config = configSchema.parse(parse(await readFile(env.MULTIAGENTS_PROVIDERS_CONFIG, "utf8")));
      for (const [id, profile] of Object.entries(config.providers)) {
        if (profile.api_key_env && !env[profile.api_key_env]) throw new Error(`Credencial de ambiente ausente para provider ${id}`);
        if (profile.management && !env[profile.management.api_key_env]) throw new Error(`Credencial administrativa ausente para provider ${id}`);
        registry.profiles.set(id, { client: new RouterClient({ ...env, MULTIAGENTS_BASE_URL: profile.base_url,
          MULTIAGENTS_API_KEY: profile.api_key_env ? env[profile.api_key_env] : "" }), streaming: profile.streaming, models: profile.models,
          management: profile.management ? new ComboClient(profile.management, env[profile.management.api_key_env]!) : undefined });
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

  async delegate(agent: Agent, task: string, context?: string, instructions?: string, outputFormat?: string, options: DelegateOptions = {}) {
    const id = agent.provider ?? "default";
    const profile = this.find(id);
    const stream = options.stream && profile.streaming;
    const result = await profile.client.delegate(agent, task, context, instructions, outputFormat, { ...options, stream: Boolean(stream) });
    return { ...result, provider: id };
  }
}
