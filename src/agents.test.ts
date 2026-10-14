import assert from "node:assert/strict";
import test from "node:test";
import { findAgent, loadAgents } from "./agents.js";

test("carrega agentes reais e rejeita identificador desconhecido", async () => {
  const agents = await loadAgents("./config/agents.yaml");
  assert.equal(agents.length, 5);
  assert.equal(findAgent(agents, "philologist").route, "combo-philologist");
  assert.equal(findAgent(agents, "translation_critic").route_strategy, "round_robin");
  assert.ok(findAgent(agents, "translation_critic").fallback_routes.length >= 1);
  assert.throws(() => findAgent(agents, "inexistente"), /Agente desconhecido/);
});
