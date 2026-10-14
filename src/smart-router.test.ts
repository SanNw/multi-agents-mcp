import assert from "node:assert/strict";
import test from "node:test";
import { loadAgents } from "./agents.js";
import { classifyTask, prioritizeRoutes } from "./smart-router.js";

const configured = await loadAgents("./config/agents.example.yaml");
const classify = (input: Parameters<typeof classifyTask>[0]) => classifyTask(input, configured);

test("prefixos e selecao usam IDs configurados", () => {
  const agents = [{ id: "My-agent", role: "custom" }];
  assert.equal(classifyTask({ task: "@My-agent implemente OAuth2" }, agents).agent, "My-agent");
  assert.equal(classify({ task: "@assistant implemente OAuth2" }).task, "implemente OAuth2");
  assert.throws(() => classify({ task: "@unknown teste" }), /desconhecido/);
  assert.throws(() => classify({ task: "@developer teste", agent: "assistant" }), /conflitante/);
});

test("roteamento usa somente agentes configurados", () => {
  assert.equal(classify({ task: "Crie um componente React" }).agent, "developer");
  assert.equal(classify({ task: "Analise a arquitetura" }).agent, "reviewer");
  assert.equal(classify({ task: "Escreva a documentação" }).agent, "assistant");
  assert.deepEqual(classify({ task: "Corrija", complexity: "high" }).suggested_flow, ["reviewer", "developer", "reviewer"]);
  const custom = [{ id: "mine", role: "custom", task_kinds: ["translation" as const] }];
  assert.equal(classifyTask({ task: "Traduza este texto" }, custom).agent, "mine");
  assert.deepEqual(classifyTask({ task: "Analise arquitetura" }, custom).suggested_flow, ["mine"]);
  assert.throws(() => classifyTask({ task: "teste" }, []), /Nenhum agente/);
});

test("historico prioriza somente alternativas configuradas", () => {
  const routes = ["primary", "fallback"];
  assert.deepEqual(prioritizeRoutes(routes, [{ route: "primary", status: "error" }, { route: "primary", status: "error" }, { route: "fallback", status: "success" }]), ["fallback", "primary"]);
});
