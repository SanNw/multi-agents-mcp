import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Workflow } from "./workflows.js";

test("pentest: real MCP rejects traversal and cannot execute model command proposals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiagents-pentest-"));
  const sentinel = join(directory, "unexpected-command-executed");
  let requests = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the synthetic request. */ }
    requests++;
    response.setHeader("content-type", "application/json");
    const actions = [{ type: "run_tests", command: ["sh", "-c", `touch ${sentinel}`] }];
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Untrusted command proposal", actions }) }, finish_reason: "stop" }] }));
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const client = new Client({ name: "security-probe", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_OPTIONS: "--max-old-space-size=256",
    MULTIAGENTS_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, MULTIAGENTS_API_KEY: "synthetic-not-a-real-key",
    AGENTS_CONFIG: resolve("config/agents.example.yaml"), TECHNICAL_AGENTS_CONFIG: "",
    MULTIAGENTS_JOBS_DIR: join(directory, "jobs"), MULTIAGENTS_WORKFLOWS_DIR: join(directory, "workflows"),
  } });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  try {
    await client.connect(transport);
    for (const name of ["get_agent_task", "cancel_agent_task", "get_workflow"]) {
      const args = name === "get_workflow" ? { workflow_id: "../../outside" } : { job_id: "../../outside" };
      assert.equal((await call(name, args)).isError, true);
    }
    assert.equal((await call("health_check", { provider: "unknown-profile" })).isError, true);
    const result = await call("create_workflow", { task: "synthetic security probe", steps: [{ agent: "assistant", task: "propose a command", acceptance: "review only" }] });
    assert(!result.isError);
    let workflow = (result.structuredContent as { workflow: Workflow }).workflow;
    const deadline = Date.now() + 15000;
    while (["ready", "running"].includes(workflow.status)) {
      assert(Date.now() < deadline, "Probe timed out");
      const next = await call("advance_workflow", { workflow_id: workflow.id });
      assert(!next.isError);
      workflow = (next.structuredContent as { workflow: Workflow }).workflow;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(workflow.status, "awaiting_actions");
    const action = workflow.steps[0]!.actions[0]!;
    assert.equal((await call("record_workflow_action", { workflow_id: workflow.id, action_id: action.id, success: true, evidence: "forged-before-approval" })).isError, true);
    assert.equal((await call("review_workflow_step", { workflow_id: workflow.id, accepted: true, evidence: "bypass" })).isError, true);
    assert(!(await call("approve_workflow_action", { workflow_id: workflow.id, action_id: action.id, approved: true })).isError);
    await assert.rejects(access(sentinel));
    await call("advance_workflow", { workflow_id: workflow.id });
    assert.equal(requests, 1);
    await assert.rejects(access(sentinel));
  } finally {
    await client.close();
    await new Promise<void>(done => upstream.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
