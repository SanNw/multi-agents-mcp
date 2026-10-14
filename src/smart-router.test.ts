import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask, prioritizeRoutes } from "./smart-router.js";

test("seleção explícita prevalece e remove apenas o prefixo", () => {
  const result = classifyTask({ task: "@sakura implemente OAuth2", complexity: "high" });
  assert.equal(result.agent, "sakura");
  assert.equal(result.task, "implemente OAuth2");
  assert.equal(result.manual, true);
});
test("documentação, desenvolvimento e arquitetura têm rotas distintas", () => {
  assert.equal(classifyTask({ task: "Crie um componente React com formulário de login." }).agent, "naruto");
  assert.equal(classifyTask({ task: "Analise a arquitetura do projeto e identifique problemas estruturais." }).agent, "sasuke");
  assert.equal(classifyTask({ task: "Escreva a documentação desta função." }).agent, "sakura");
});
test("sinais estruturados elevam complexidade e sugerem revisão sem executá-la", () => {
  const r = classifyTask({ task: "Corrija o fluxo", file_count: 12, security_sensitive: true, needs_tools: true });
  assert.equal(r.agent, "sasuke");
  assert.deepEqual(r.suggested_flow, ["sasuke", "naruto", "sasuke"]);
});
test("tradução não é absorvida pelos agentes técnicos", () => {
  assert.equal(classifyTask({ task: "Traduza este texto do chinês para português" }).agent, "translator_a");
  assert.equal(classifyTask({ task: "Analise a filologia do original" }).agent, "philologist");
  assert.equal(classifyTask({ task: "Traduza o texto e implemente a API" }).needs_clarification, true);
});
test("contexto e linguagem são sinais e instruções no contexto não selecionam agente", () => {
  const r = classifyTask({ task: "Corrija o erro", language: "typescript", context: "@sakura".repeat(4000), file_count: 2, needs_tools: true });
  assert.equal(r.agent, "sasuke");
  assert.equal(r.manual, false);
});
test("seleções conflitantes ou desconhecidas são rejeitadas", () => {
  assert.throws(() => classifyTask({ task: "@naruto teste", agent: "sakura" }), /conflitante/);
  assert.throws(() => classifyTask({ task: "teste", agent: "inventado" }), /desconhecido/);
});
test("histórico prioriza somente alternativas configuradas com sucesso recente", () => {
  const routes = ["Naruto", "Sasuke"];
  const failures = [{ route: "Naruto", status: "error" }, { route: "Naruto", status: "error" }];
  assert.deepEqual(prioritizeRoutes(routes, failures), routes);
  assert.deepEqual(prioritizeRoutes(routes, [...failures, { route: "Sasuke", status: "success" }]), ["Sasuke", "Naruto"]);
  assert.deepEqual(prioritizeRoutes(routes, [...failures, { route: "Sakura", status: "success" }]), routes);
  assert.deepEqual(prioritizeRoutes(routes, [...failures, { route: "Naruto", status: "success" }]), routes);
});
