import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobManager } from "./jobs.js";
import { actionSchema, WorkflowManager, workflowInputSchema } from "./workflows.js";
import { serializeError } from "./errors.js";
import { loadConfiguredAgents } from "./smart-router.js";

test("security: traversal and private-file proposals are rejected", () => {
  for (const path of ["../outside", "/etc/passwd", "C:\\secret", "a/../../x", ".env", "a/.env.local", ".git/config", ".codex/config.toml", ".npmrc", "id_rsa"]) {
    assert.equal(actionSchema.safeParse({ type: "read_file", path }).success, false, path);
    assert.equal(actionSchema.safeParse({ type: "propose_patch", path, patch: "x" }).success, false, path);
  }
  assert(actionSchema.safeParse({ type: "read_file", path: "src/example.ts" }).success);
  assert.equal(actionSchema.safeParse({ type: "execute", command: ["sh"] }).success, false);
  assert.equal(actionSchema.safeParse({ type: "read_file", path: "src/x", approved: true }).success, false);
});

test("security: workflow budgets and extra approval fields cannot be injected", () => {
  const step = { agent: "assistant", task: "review", acceptance: "evidence" };
  for (const input of [{ task: "x", steps: Array(9).fill(step) }, { task: "x", steps: [step], timeout_ms: 180001 },
    { task: "x", steps: [step], max_output_tokens: 4001 }, { task: "x", steps: [step], approved: true }]) {
    assert.equal(workflowInputSchema.safeParse(input).success, false);
  }
});

test("security: job state is private and traversal cannot read outside state", async () => {
  const root = await mkdtemp(join(tmpdir(), "multiagents-security-"));
  const old = process.umask(0o022);
  try {
    const manager = new JobManager({ async delegate() { throw new Error("unused fixture"); } }, join(root, "jobs"));
    await manager.init();
    assert.equal((await stat(join(root, "jobs"))).mode & 0o777, 0o700);
    await assert.rejects(manager.refresh("../../outside"), /inválido/);
    const workflows = new WorkflowManager(manager, async () => [], join(root, "workflows"));
    await assert.rejects(workflows.get("../../outside"));
  } finally { process.umask(old); await rm(root, { recursive: true, force: true }); }
});

test("security: public errors redact credential patterns", () => {
  const error = serializeError(new Error("Bearer fixture-secret api_key=fixture-key token=fixture-token password=fixture-password sk-fixture-secret"));
  assert(!JSON.stringify(error).includes("fixture-"));
});

test("npm: default agents resolve independently of caller directory", async () => {
  const cwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "multiagents-cwd-"));
  const original = process.env.AGENTS_CONFIG;
  const technical = process.env.TECHNICAL_AGENTS_CONFIG;
  try {
    delete process.env.AGENTS_CONFIG; delete process.env.TECHNICAL_AGENTS_CONFIG;
    process.chdir(root);
    assert.equal((await loadConfiguredAgents()).length, 3);
  } finally {
    process.chdir(cwd);
    if (original === undefined) delete process.env.AGENTS_CONFIG; else process.env.AGENTS_CONFIG = original;
    if (technical === undefined) delete process.env.TECHNICAL_AGENTS_CONFIG; else process.env.TECHNICAL_AGENTS_CONFIG = technical;
    await rm(root, { recursive: true, force: true });
  }
});
