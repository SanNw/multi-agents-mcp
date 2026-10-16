import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Workflow } from "./workflows.js";
import { outputSchemas } from "./tool-schemas.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("diagnose CLI runs offline without inference or administrative credentials", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve("dist/index.js"), "--diagnose"], { env: {
    PATH: process.env.PATH, AGENTS_CONFIG: resolve("config/agents.example.yaml"),
    MULTIAGENTS_BASE_URL: "http://127.0.0.1:1", MULTIAGENTS_API_KEY: "", NINEROUTER_KEY: "",
  }, timeout: 5000 });
  assert.equal(stderr, "");
  const report = outputSchemas.diagnose.parse(JSON.parse(stdout));
  assert.equal(report.network, false);
  assert.equal(report.inference, false);
  assert.ok(report.checks.some(check => check.id === "agents" && check.status === "ok"));
});

test("MCP real: workflow ligado a jobs, aprovacao, resultado e contexto entre etapas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-mcp-workflow-"));
  const requests: string[] = [];
  const upstream = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(body);
    response.setHeader("content-type", "application/json");
    const actions = requests.length === 1 ? [{ type: "run_tests", command: ["node", "--version"] }] : [];
    response.end(JSON.stringify({ model: "fixture", choices: [{ message: { content: JSON.stringify({ summary: "Resultado simulado para validar protocolo", actions }) }, finish_reason: "stop" }], usage: { total_tokens: 3 } }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as AddressInfo;
  const providersPath = join(directory, "providers.yaml");
  await writeFile(providersPath, JSON.stringify({ providers: { omniroute: {
    base_url: `http://127.0.0.1:${port}`, api_key_env: "OMNIROUTE_API_KEY",
    protocol: "openai-chat-completions", streaming: false,
  } } }));
  const client = new Client({ name: "workflow-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env: {
    ...process.env as Record<string, string>, NINEROUTER_URL: `http://127.0.0.1:${port}`, NINEROUTER_KEY: "fixture",
    MULTIAGENTS_BASE_URL: `http://127.0.0.1:${port}`, MULTIAGENTS_API_KEY: "fixture",
    MULTIAGENTS_PROVIDERS_CONFIG: providersPath, OMNIROUTE_API_KEY: "fixture",
    AGENTS_CONFIG: resolve("config/agents.example.yaml"), TECHNICAL_AGENTS_CONFIG: "",
    NINEROUTER_JOBS_DIR: join(directory, "jobs"), NINEROUTER_WORKFLOWS_DIR: join(directory, "workflows"),
    MULTIAGENTS_JOBS_DIR: join(directory, "jobs"), MULTIAGENTS_WORKFLOWS_DIR: join(directory, "workflows"),
  } });
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError ?? false, false);
    return result.structuredContent as { workflow: Workflow };
  }
  async function collect(id: string) {
    for (let i = 0; i < 100; i++) {
      const current = (await call("advance_workflow", { workflow_id: id })).workflow;
      if (current.status !== "running") return current;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("timeout no teste local");
  }
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 25);
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, "object", tool.name);
      assert.ok(Object.hasOwn(outputSchemas, tool.name), tool.name);
    }
    for (const name of ["list_models", "list_combos", "plan_combo", "apply_combo_plan", "test_combo"]) assert(tools.some(tool => tool.name === name));
    const created = (await call("create_workflow", { task: "Teste de protocolo", steps: [
      { agent: "assistant", task: "Prepare", acceptance: "Resultado validado" },
      { agent: "assistant", task: "Revise", acceptance: "Evidencias preservadas" },
    ] })).workflow;
    const first = await collect(created.id); assert.equal(first.status, "awaiting_actions");
    const action = first.steps[0]!.actions[0]!;
    await call("approve_workflow_action", { workflow_id: created.id, action_id: action.id, approved: true });
    await call("record_workflow_action", { workflow_id: created.id, action_id: action.id, success: true, evidence: "fixture-result-only" });
    await call("review_workflow_step", { workflow_id: created.id, accepted: true, evidence: "fixture revisado" });
    assert.equal((await collect(created.id)).status, "awaiting_review");
    assert.match(requests[1]!, /fixture-result-only/);
    assert.equal((await call("review_workflow_step", { workflow_id: created.id, accepted: true, evidence: "fim" })).workflow.status, "completed");
    assert.equal(requests.length, 2);
    const diagnostic = await client.callTool({ name: "diagnose", arguments: {} });
    assert.equal(diagnostic.isError ?? false, false);
    assert.equal(outputSchemas.diagnose.safeParse(diagnostic.structuredContent).success, true);
    assert.equal(requests.length, 2);
    const inspected = await client.callTool({ name: "inspect_state", arguments: {} });
    assert.equal(inspected.isError ?? false, false);
    assert.equal(outputSchemas.inspect_state.safeParse(inspected.structuredContent).success, true);
    const notifications: Array<{ progress: number; total?: number; message?: string }> = [];
    const delegated = await client.callTool({ name: "delegate_agent", arguments: { agent: "assistant", task: "Check progress" } }, undefined,
      { onprogress: notification => notifications.push(notification) });
    assert.equal(delegated.isError ?? false, false);
    assert.ok(notifications.length >= 2);
    assert.ok(notifications.every((notification, index) => notification.total === undefined && (index === 0 || notification.progress > notifications[index - 1]!.progress)));
    const ordinary = await client.callTool({ name: "delegate_agent", arguments: { agent: "assistant", task: "Without progress token" } });
    assert.equal(ordinary.isError ?? false, false);
    const firstPage = await client.callTool({ name: "list_agent_tasks", arguments: { limit: 1, offset: 0 } });
    const secondPage = await client.callTool({ name: "list_agent_tasks", arguments: { limit: 1, offset: 1 } });
    const firstJobs = firstPage.structuredContent as { jobs: Array<{ job_id: string }> };
    const secondJobs = secondPage.structuredContent as { jobs: Array<{ job_id: string }> };
    assert.equal(firstJobs.jobs.length, 1);
    assert.equal(secondJobs.jobs.length, 1);
    assert.notEqual(firstJobs.jobs[0]!.job_id, secondJobs.jobs[0]!.job_id);
    const jobId = firstJobs.jobs[0]!.job_id;
    const fragment = await client.callTool({ name: "get_agent_task", arguments: { job_id: jobId, offset: 0, limit: 5 } });
    assert.equal(fragment.isError ?? false, false);
    const part = fragment.structuredContent as { result: { content: string }; next_content_offset: number; content_total_chars: number; content_truncated: boolean };
    assert.equal(part.result.content.length, 5);
    assert.equal(part.next_content_offset, 5);
    assert.equal(part.content_truncated, true);
    const remainder = await client.callTool({ name: "get_agent_task", arguments: { job_id: jobId, offset: 5, limit: 100000 } });
    const tail = remainder.structuredContent as { result: { content: string }; next_content_offset: null; content_truncated: boolean };
    assert.equal(tail.next_content_offset, null);
    assert.equal(tail.content_truncated, false);
    assert.equal((part.result.content + tail.result.content).length, part.content_total_chars);
  } finally {
    await client.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
