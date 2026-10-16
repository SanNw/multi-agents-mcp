import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serializeError } from "./errors.js";
import { outputSchemas, toolErrorSchema } from "./tool-schemas.js";
import { z } from "zod";

test("all registered tools expose an SDK-compatible object output contract", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const names = [...source.matchAll(/server\.registerTool\("([^"]+)"/g)].map(match => match[1]!);
  const server = new McpServer({ name: "schema-test", version: "1" });
  for (const name of names) {
    assert.ok(Object.hasOwn(outputSchemas, name), name);
    const schema = outputSchemas[name as keyof typeof outputSchemas];
    assert.equal(schema.type, "object", name);
    assert.equal(z.toJSONSchema(schema).type, "object", name);
    assert.equal(schema.safeParse({}).success, false, name);
    server.registerTool(name, { outputSchema: schema }, async () => ({ content: [] }));
  }
});

test("serialized failures retain the error contract", () => {
  const failure = { status: "error", error: serializeError(new Error("failed")) };
  assert.deepEqual(toolErrorSchema.parse(failure), failure);
  assert.equal(toolErrorSchema.safeParse({ ...failure, error: { ...failure.error, retryable: "false" } }).success, false);
  assert.equal(toolErrorSchema.safeParse({ status: "error", error: { message: "failed" } }).success, false);
});

test("SDK preserves isError structured failures despite success-only output schemas", async () => {
  const server = new McpServer({ name: "schema-errors", version: "1" });
  const client = new Client({ name: "schema-client", version: "1" });
  const failure = { status: "error", error: serializeError(new Error("probe failure")) };
  server.registerTool("list_models", { outputSchema: outputSchemas.list_models }, async () => ({ isError: true,
    content: [{ type: "text", text: JSON.stringify(failure) }], structuredContent: failure }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "list_models" });
    assert.equal(response.isError, true);
    assert.deepEqual(toolErrorSchema.parse(response.structuredContent), failure);
  } finally { await client.close(); await server.close(); }
});

test("health validates each mode's essential fields", () => {
  assert.equal(outputSchemas.health_check.safeParse({ status: "configured", mode: "shallow", models_source: "configured", model_count: 2 }).success, true);
  assert.equal(outputSchemas.health_check.safeParse({ status: "ok", mode: "shallow" }).success, false);
  assert.equal(outputSchemas.health_check.safeParse({ status: "ok", mode: "inference", checks: [] }).success, true);
  assert.equal(outputSchemas.health_check.safeParse({ status: "ok", mode: "inference", checks: [{ agent: "reviewer", status: "ok" }] }).success, false);
});

test("arrays validate nested identifiers and statuses", () => {
  assert.equal(outputSchemas.list_models.safeParse({ source: "remote", models: [{ id: "model", owned_by: "provider" }] }).success, true);
  assert.equal(outputSchemas.list_models.safeParse({ source: "remote", models: [{ id: 42 }] }).success, false);
  assert.equal(outputSchemas.list_agent_tasks.safeParse({ jobs: [{ job_id: "invalid", status: "running", agent: "developer", created_at: "now", updated_at: "now" }] }).success, false);
  assert.equal(outputSchemas.route_task.safeParse({ agent: "developer", task: "task", manual: false, reasons: [], complexity_score: 1, needs_clarification: false,
    classification: "deterministic", suggested_flow: [42], execution: "proposal" }).success, false);
});

test("workflow action metadata validates without rejecting action payload fields", () => {
  const id = "65dd8e34-55b7-40ec-95bf-2b65ce574fc3";
  const value = { workflow: { id, created_at: "now", updated_at: "now", status: "awaiting_actions", current_step: 0, submissions: 1, replans: [],
    input: { task: "review", steps: [{ agent: "reviewer", task: "review", acceptance: "verified" }] },
    steps: [{ actions: [{ id, type: "read_file", path: "src/index.ts", status: "proposed" }] }] } };
  assert.equal(outputSchemas.get_workflow.safeParse(value).success, true);
  value.workflow.steps[0]!.actions[0]!.status = "unknown";
  assert.equal(outputSchemas.get_workflow.safeParse(value).success, false);
});
