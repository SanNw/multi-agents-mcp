import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const agentSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
  route: z.string().min(1),
  fallback_routes: z.array(z.string().min(1)).default([]),
  route_strategy: z.enum(["fallback", "round_robin"]).default("round_robin"),
  role: z.string().min(1),
  description: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.2),
  timeout_ms: z.number().int().min(1_000).default(600_000),
  first_byte_timeout_ms: z.number().int().min(1_000).default(90_000),
  idle_timeout_ms: z.number().int().min(1_000).default(90_000),
  max_output_tokens: z.number().int().min(1).default(8_000),
  retries: z.number().int().min(0).max(5).default(2),
  concurrency: z.number().int().min(1).max(8).default(1),
  stream: z.boolean().optional(),
});

const configSchema = z.object({
  agents: z.record(z.string(), agentSchema),
});

export type Agent = z.infer<typeof agentSchema> & { id: string };

export const defaultAgentsPath = fileURLToPath(new URL("../config/agents.yaml", import.meta.url));

export async function loadAgents(path = process.env.AGENTS_CONFIG ?? defaultAgentsPath) {
  const config = configSchema.parse(parse(await readFile(resolve(path), "utf8")));
  return Object.entries(config.agents).map(([id, agent]) => ({ id, ...agent }));
}

export function findAgent(agents: Agent[], id: string) {
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Agente desconhecido: ${id}`);
  return agent;
}
