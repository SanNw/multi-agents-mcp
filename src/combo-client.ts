import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const projectPolicySchema = z.object({
  models: z.array(z.string().min(1).max(300)).min(1).max(100),
  allow_create: z.boolean().default(false), allow_update: z.boolean().default(false),
  allow_tests: z.boolean().default(false), max_combos: z.number().int().min(1).max(100).default(10),
  max_test_models: z.number().int().min(1).max(16).default(4),
}).strict();
export const managementSchema = z.object({
  adapter: z.enum(["omniroute", "9router"]), base_url: z.url(),
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  projects: z.record(identifier, projectPolicySchema),
  protected_routes: z.array(z.string().min(1).max(300)).default([]),
  consumers: z.array(z.object({ id: identifier, path: z.string().refine(isAbsolute, "Caminho absoluto necessário") }).strict()).max(30).default([]),
}).strict();
export type ManagementConfig = z.infer<typeof managementSchema>;
const modelStep = z.union([z.string().min(1).max(300), z.object({
  kind: z.string().optional(), model: z.string().max(300).optional(),
  provider: z.string().max(120).optional(), providerId: z.string().max(120).optional(),
  comboName: z.string().max(100).optional(),
})]);
export const comboSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(100),
  models: z.array(modelStep).max(100), strategy: z.string().max(100), revision: z.string().optional(),
});
export type Combo = z.infer<typeof comboSchema>;
export type ComboDefinition = { name: string; models: string[]; strategy: "priority" | "backend-default" };

export class ComboClient {
  private readonly base: string;
  constructor(readonly config: ManagementConfig, private readonly key: string) {
    const url = new URL(config.base_url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Endpoint administrativo inválido");
    this.base = url.href.replace(/\/$/, "");
  }

  async list(): Promise<Combo[]> {
    const combos: Combo[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = z.object({ combos: z.array(z.record(z.string(), z.unknown())), total: z.number().int().nonnegative().optional() })
        .parse(await this.request("GET", `/api/combos?limit=100&offset=${offset}`));
      combos.push(...page.combos.map(combo => this.normalize(combo)));
      if (page.total === undefined || combos.length >= page.total) return combos;
      if (page.combos.length !== 100) throw new Error("Paginação administrativa não suportada; inventário incompleto");
    }
    throw new Error("Catálogo de combos excede o limite de inventário");
  }

  async create(combo: ComboDefinition): Promise<Combo> {
    const body = this.config.adapter === "9router" ? { name: combo.name, models: combo.models } : combo;
    return this.normalize(await this.request("POST", "/api/combos", body));
  }

  private normalize(value: unknown): Combo {
    const raw = z.record(z.string(), z.unknown()).parse(value);
    return comboSchema.parse({ ...raw, strategy: this.config.adapter === "9router" ? "backend-default" : raw.strategy,
      revision: createHash("sha256").update(JSON.stringify(raw)).digest("hex") });
  }

  private async request(method: string, path: string, body?: unknown) {
    try {
      const response = await fetch(this.base + path, { method, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${this.key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Resposta vazia");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length;
          if (bytes > 2_000_000) throw new Error("Resposta excede o limite");
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      const status = error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? `: ${error.message}` : "";
      throw new Error(`Falha na API administrativa${status}`);
    }
  }
}

export function memberModels(combo: Combo) {
  return combo.models.map(step => {
    if (typeof step === "string") return step;
    if (step.kind === "combo-ref" || !step.model) throw new Error("Combo aninhado ou modelo sem ID não suportado");
    const provider = step.providerId ?? step.provider;
    return provider && !step.model.startsWith(provider + "/") ? `${provider}/${step.model}` : step.model;
  });
}

export async function consumerReferences(config: ManagementConfig) {
  const references: Array<{ consumer: string; route: string }> = [];
  const unavailable: string[] = [];
  for (const consumer of config.consumers) {
    try {
      const descriptor = await open(consumer.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let file: Buffer;
      try {
        const info = await descriptor.stat();
        if (!info.isFile() || info.size > 1_000_000) throw new Error("Configuração inválida ou excede o limite");
        file = await descriptor.readFile();
      } finally { await descriptor.close(); }
      const inspect = (value: unknown, depth = 0): void => {
        if (depth > 30) throw new Error("Configuração muito profunda");
        if (!value || typeof value !== "object") return;
        for (const [key, entry] of Object.entries(value)) {
          if (["model", "small_model"].includes(key) && typeof entry === "string") references.push({ consumer: consumer.id, route: entry });
          else if (entry && typeof entry === "object") inspect(entry, depth + 1);
        }
      };
      if (file.length > 1_000_000) throw new Error("Configuração excede o limite");
      inspect(JSON.parse(file.toString("utf8")));
    } catch { unavailable.push(consumer.id); }
  }
  return { references, unavailable };
}

export function usesRoute(reference: string, name: string) {
  return reference.toLowerCase() === name.toLowerCase() || reference.toLowerCase().endsWith("/" + name.toLowerCase());
}
