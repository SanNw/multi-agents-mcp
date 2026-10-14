import assert from "node:assert/strict";
import test from "node:test";
import { findAgent, loadAgents } from "./agents.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguredAgents } from "./smart-router.js";

test("carrega somente exemplos genericos", async () => {
  const agents = await loadAgents("./config/agents.example.yaml");
  assert.deepEqual(agents.map(agent => agent.id), ["developer", "reviewer", "assistant"]);
  assert.equal(findAgent(agents, "developer").route, "your-model-id");
  assert.throws(() => findAgent(agents, "inexistente"), /Agente desconhecido/);
});

test("configuração própria funciona sem arquivo técnico adicional", async () => {
  const root = await mkdtemp(join(tmpdir(), "custom-agents-"));
  const original = process.env.AGENTS_CONFIG;
  const technical = process.env.TECHNICAL_AGENTS_CONFIG;
  try {
    const path = join(root, "agents.yaml");
    await writeFile(path, "agents:\n  mine:\n    route: local-model\n    role: custom\n    description: My agent\n");
    process.env.AGENTS_CONFIG = path;
    delete process.env.TECHNICAL_AGENTS_CONFIG;
    assert.deepEqual((await loadConfiguredAgents()).map(agent => agent.id), ["mine"]);
  } finally {
    if (original === undefined) delete process.env.AGENTS_CONFIG; else process.env.AGENTS_CONFIG = original;
    if (technical === undefined) delete process.env.TECHNICAL_AGENTS_CONFIG; else process.env.TECHNICAL_AGENTS_CONFIG = technical;
    await rm(root, { recursive: true, force: true });
  }
});
