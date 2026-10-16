import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderRegistry } from "./providers.js";
import { ComboManager } from "./combos.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { JobManager } from "./jobs.js";
import { createHash } from "node:crypto";
import { probeCases } from "./combo-probes.js";

async function fixture(adapter: "omniroute" | "9router" = "omniroute") {
  const root = await mkdtemp(join(tmpdir(), "multiagents-combos-"));
  const combos = [{ id: "external", name: "shared-route", models: ["model-a", "model-b"], strategy: "priority" }];
  const requests: Array<{ method: string; url: string; key?: string; body?: Record<string, unknown> }> = [];
  let uncertain = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method!, url: request.url!, key: request.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/admin/api/combos?") && request.method === "GET") return void response.end(JSON.stringify({ combos }));
    if (request.url === "/admin/api/combos" && request.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const combo = { id: String(combos.length), ...body }; combos.push(combo);
      if (uncertain) { uncertain = false; request.socket.destroy(); return; }
      response.writeHead(201); response.end(JSON.stringify(combo)); return;
    }
    if (request.url === "/v1/models") return void response.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
    if (request.url === "/v1/chat/completions") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model === "model-b") { response.writeHead(503); response.end(JSON.stringify({ error: "fixture failure" })); return; }
      response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: "OK" }, finish_reason: "stop" }] })); return;
    }
    response.writeHead(404); response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const consumer = join(root, "cli.json");
  await writeFile(consumer, JSON.stringify({ model: "gateway/shared-route", small_model: "gateway/shared-route", apiKey: "never-expose-fixture" }));
  const config = join(root, "providers.yaml");
  const profile = {
    base_url: `http://127.0.0.1:${port}/v1`, api_key_env: "INFERENCE_KEY",
    management: { adapter, base_url: `http://127.0.0.1:${port}/admin`, api_key_env: "MANAGEMENT_KEY",
      projects: { project: { models: ["model-a", "model-b"], allow_create: true, allow_update: true, allow_tests: true, max_combos: 5 } },
      consumers: [{ id: "other-cli", path: consumer }], protected_routes: ["shared-route"] },
  };
  async function load() {
    await writeFile(config, JSON.stringify({ providers: { fixture: profile } }));
    const registry = await ProviderRegistry.load({ MULTIAGENTS_PROVIDERS_CONFIG: config, INFERENCE_KEY: "inference-fixture", MANAGEMENT_KEY: "management-fixture" });
    return { registry, manager: new ComboManager(registry, join(root, "state")) };
  }
  const loaded = await load();
  return { ...loaded, root, profile, load, combos, requests, loseResponse: () => { uncertain = true; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

test("canonical revisions ignore key order but retain all backend configuration", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "stable", models: ["model-a"] });
    const applied = await setup.manager.apply(plan.id);
    const index = setup.combos.findIndex(combo => combo.id === applied.result!.id);
    const original = setup.combos[index]!;
    setup.combos[index] = { strategy: original.strategy, models: original.models, name: original.name, id: original.id };
    assert.equal((await setup.manager.list("fixture")).combos.find(combo => combo.id === original.id)!.managed, true);
    Object.assign(setup.combos[index]!, { timeout: 12 });
    await assert.rejects(setup.manager.resolveAgent({ provider: "fixture" } as never, "project", original.id), /alterado/);
    await assert.rejects(setup.manager.apply(plan.id), /alterado/);
  } finally { await setup.close(); }
});

test("legacy ownership remains usable without rewriting its ledger", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "legacy", models: ["model-a"] });
    const applied = await setup.manager.apply(plan.id);
    const raw = setup.combos.find(combo => combo.id === applied.result!.id)!;
    applied.result!.revision = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const path = join(setup.root, "state", plan.id + ".json");
    const saved = JSON.stringify(applied);
    await writeFile(path, saved);
    assert.equal((await setup.manager.list("fixture")).combos.find(combo => combo.id === raw.id)!.managed, true);
    assert.equal((await setup.manager.resolveAgent({ provider: "fixture" } as never, "project", raw.id)).route, raw.name);
    assert.equal(await readFile(path, "utf8"), saved);
    const index = setup.combos.indexOf(raw);
    setup.combos[index] = { strategy: raw.strategy, models: raw.models, name: raw.name, id: raw.id };
    assert.equal((await setup.manager.list("fixture")).combos.find(combo => combo.id === raw.id)!.managed, true);
    assert.equal(await readFile(path, "utf8"), saved);
    setup.combos[index] = raw;
    Object.assign(raw, { routing: "changed" });
    await assert.rejects(setup.manager.resolveAgent({ provider: "fixture" } as never, "project", raw.id), /alterado/);
  } finally { await setup.close(); }
});

test("synthetic suites check deterministic cases and persist private isolated reports", async () => {
  assert.equal(probeCases("json-v1")[0]!.check('{"count":3}'), true);
  assert.equal(probeCases("json-v1")[0]!.check('{"count":3,"extra":true}'), false);
  assert.equal(probeCases("json-v1")[0]!.check('```json\n{"count":3}\n```'), false);
  assert.equal(probeCases("instructions-v1")[0]!.check("green blue red"), true);
  const setup = await fixture();
  try {
    const report = await setup.manager.testCombo("fixture", "project", "external", ["model-a"], "instructions-v1");
    assert.equal(report.samples_per_model, 2);
    assert.equal(report.results.length, 2);
    assert(report.results.every(result => !result.passed));
    assert.equal(report.quality_evaluation, false);
    const path = join(setup.root, "state", "reports", report.report_id + ".json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, "utf8")).suite, "instructions-v1");
    assert.equal((await setup.manager.list("fixture")).combos[0]!.managed, false);
    await assert.rejects(setup.manager.testCombo("fixture", "project", "external", ["model-a"], "tools-v1" as never));
  } finally { await setup.close(); }
});

test("external CLI routes are visible, protected, and never changed", async () => {
  const setup = await fixture();
  try {
    const inventory = await setup.manager.list("fixture", "project");
    assert.equal(inventory.combos[0]!.protected, true);
    assert.deepEqual(inventory.combos[0]!.consumers, ["other-cli"]);
    assert(!JSON.stringify(inventory).includes("never-expose"));
    await assert.rejects(setup.manager.plan({ provider: "fixture", project_id: "project", name: "example", models: ["model-a"], source_combo_id: "external" }), /externo|protegido/);
    assert(setup.requests.every(request => request.method === "GET"));
  } finally { await setup.close(); }
});

test("9Router creation preserves backend strategy and never edits global settings", async () => {
  const setup = await fixture("9router");
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "coding", models: ["model-a"] });
    assert.equal(plan.definition.strategy, "backend-default");
    assert.equal((await setup.manager.apply(plan.id)).status, "applied");
    const request = setup.requests.find(item => item.method === "POST")!;
    assert.deepEqual(Object.keys(request.body!).sort(), ["models", "name"]);
    assert(setup.requests.every(item => !item.url.includes("settings")));
  } finally { await setup.close(); }
});

test("concurrent application is serialized and changed backend state is rejected", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "coding", models: ["model-a"] });
    const results = await Promise.allSettled([setup.manager.apply(plan.id), new ComboManager(setup.registry, join(setup.root, "state")).apply(plan.id)]);
    assert(results.some(result => result.status === "fulfilled"));
    assert.equal(setup.requests.filter(request => request.method === "POST").length, 1);
    const applied = await setup.manager.apply(plan.id);
    setup.combos.find(combo => combo.id === applied.result!.id)!.models = ["model-b"];
    await assert.rejects(setup.manager.apply(plan.id), /alterado/);
    await assert.rejects(setup.manager.resolveAgent({ provider: "fixture" } as never, "project", applied.result!.id), /alterado/);
  } finally { await setup.close(); }
});

test("real MCP exposes combo tools, probes members, and binds direct/async/workflow jobs", async () => {
  const setup = await fixture();
  const client = new Client({ name: "combo-test", version: "1" });
  const agents = join(setup.root, "agents.yaml");
  await writeFile(agents, JSON.stringify({ agents: { worker: { provider: "fixture", route: "model-a", role: "software_development", description: "Fixture", route_strategy: "fallback" } } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env: {
    ...process.env as Record<string, string>, AGENTS_CONFIG: agents, TECHNICAL_AGENTS_CONFIG: "",
    MULTIAGENTS_PROVIDERS_CONFIG: join(setup.root, "providers.yaml"), INFERENCE_KEY: "inference-fixture", MANAGEMENT_KEY: "management-fixture",
    MULTIAGENTS_COMBOS_DIR: join(setup.root, "state"), MULTIAGENTS_JOBS_DIR: join(setup.root, "jobs"), MULTIAGENTS_WORKFLOWS_DIR: join(setup.root, "workflows"),
  } });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError ?? false, false, JSON.stringify(response));
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(transport);
    const inventory = await call("list_combos", { provider: "fixture", project_id: "project" });
    assert.equal(inventory.combos[0].protected, true);
    assert(!JSON.stringify(inventory).includes("never-expose"));
    assert.equal((await call("list_models", { provider: "fixture" })).source, "remote");
    const { plan } = await call("plan_combo", { provider: "fixture", project_id: "project", name: "coding", models: ["model-a"] });
    const applied = (await call("apply_combo_plan", { plan_id: plan.id })).plan;
    const selection = { agent: "worker", task: "Reply OK", project_id: "project", combo_id: applied.result.id, retries: 0 };
    await call("delegate_agent", selection);
    assert.equal(setup.requests.filter(request => request.url === "/v1/chat/completions").at(-1)!.body!.model, applied.result.name);
    await call("submit_agent_task", selection);
    await call("submit_routed_task", selection);
    const workflow = (await call("create_workflow", { task: "Fixture", steps: [{ agent: "worker", task: "Reply OK", acceptance: "Fixture", project_id: "project", combo_id: applied.result.id }] })).workflow;
    await call("advance_workflow", { workflow_id: workflow.id });
    const probe = await call("test_combo", { provider: "fixture", project_id: "project", combo_id: "external" });
    assert.equal(probe.results.length, 2);
    assert.equal(probe.results[1].status, "error");
    const denied = await client.callTool({ name: "delegate_agent", arguments: { ...selection, combo_id: "external" } });
    assert.equal(denied.isError, true);
    assert(!setup.requests.some(request => ["PUT", "PATCH", "DELETE"].includes(request.method)));
  } finally { await client.close(); await setup.close(); }
});

test("create is idempotent; updates create a new version without PUT or DELETE", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "coding", models: ["model-a"] });
    const applied = await setup.manager.apply(plan.id);
    assert.equal(applied.status, "applied");
    assert.equal((await setup.manager.apply(plan.id)).result!.id, applied.result!.id);
    const update = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "coding", models: ["model-b"], source_combo_id: applied.result!.id });
    const next = await setup.manager.apply(update.id);
    assert.notEqual(next.result!.name, applied.result!.name);
    assert.deepEqual(setup.combos.find(combo => combo.id === applied.result!.id)!.models, ["model-a"]);
    assert(!setup.requests.some(request => ["PUT", "PATCH", "DELETE"].includes(request.method)));
    assert.equal(setup.requests.find(request => request.url.startsWith("/admin/api/combos"))!.key, "Bearer management-fixture");
    assert.equal((await setup.manager.resolveAgent({ id: "custom", provider: "fixture", route: "old" } as never, "project", next.result!.id)).route, next.result!.name);
    await assert.rejects(setup.manager.resolveAgent({ id: "custom", provider: "fixture" } as never, "other", next.result!.id));
  } finally { await setup.close(); }
});

test("uncertain creation reconciles after restart without another POST", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "test", models: ["model-a"] });
    setup.loseResponse();
    assert.equal((await setup.manager.apply(plan.id)).status, "uncertain");
    const resumed = new ComboManager(setup.registry, join(setup.root, "state"));
    assert.equal((await resumed.apply(plan.id)).status, "applied");
    assert.equal(setup.requests.filter(request => request.method === "POST").length, 1);
  } finally { await setup.close(); }
});

test("tests call each member directly, with no fallbacks or writes", async () => {
  const setup = await fixture();
  try {
    const report = await setup.manager.testCombo("fixture", "project", "external", ["model-b", "model-a"]);
    assert.deepEqual(report.results.map(item => item.model), ["model-b", "model-a"]);
    assert.equal(report.results[0]!.status, "error");
    assert.equal(report.results[1]!.status, "success");
    assert.equal(setup.requests.filter(request => request.url === "/v1/chat/completions").length, 2);
    assert(!setup.requests.some(request => request.method !== "GET" && request.url !== "/v1/chat/completions"));
    assert(setup.requests.filter(request => request.url === "/v1/chat/completions").every(request => request.key === "Bearer inference-fixture"));
  } finally { await setup.close(); }
});

test("probe quota and allowlist are checked before inference; unreadable consumers are disclosed", async () => {
  const setup = await fixture();
  try {
    await writeFile(join(setup.root, "cli.json"), "invalid-json");
    const inventory = await setup.manager.list("fixture");
    assert.deepEqual(inventory.consumer_scan.unavailable, ["other-cli"]);
    await assert.rejects(setup.manager.testCombo("fixture", "project", "external", ["not-a-member"]));
    await assert.rejects(setup.manager.testCombo("fixture", "project", "external", ["model-a", "model-a"]));
    setup.profile.management.projects.project.max_combos = 1;
    const { manager } = await setup.load();
    const first = await manager.plan({ provider: "fixture", project_id: "project", name: "coding", models: ["model-a"] });
    await manager.apply(first.id);
    const next = await manager.plan({ provider: "fixture", project_id: "project", name: "extra", models: ["model-a"] });
    await assert.rejects(manager.apply(next.id), /Limite/);
    assert.equal((await stat(join(setup.root, "state"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(setup.root, "state", first.id + ".json"))).mode & 0o777, 0o600);
    assert(!setup.requests.some(request => request.url === "/v1/chat/completions"));
  } finally { await setup.close(); }
});

test("plan symlinks and management redirects fail closed without forwarding credentials", async () => {
  const setup = await fixture();
  let leaked = false;
  const target = createServer((_request, response) => { leaked = true; response.end("{}"); });
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}` }); response.end();
  });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => redirect.listen(0, "127.0.0.1", resolve));
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "coding", models: ["model-a"] });
    await rm(join(setup.root, "state", plan.id + ".json"));
    await symlink(join(setup.root, "cli.json"), join(setup.root, "state", plan.id + ".json"));
    await assert.rejects(setup.manager.apply(plan.id));
    setup.profile.management.base_url = `http://127.0.0.1:${(redirect.address() as AddressInfo).port}`;
    const { registry } = await setup.load();
    await assert.rejects(registry.management("fixture").list(), /administrativa/);
    assert.equal(leaked, false);
  } finally {
    redirect.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => redirect.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    await setup.close();
  }
});

test("policy denies unknown models, project, writes and test quota; state is private", async () => {
  const setup = await fixture();
  try {
    await assert.rejects(setup.manager.plan({ provider: "fixture", project_id: "project", name: "test", models: ["missing"] }));
    setup.profile.management.projects.project.allow_create = false;
    setup.profile.management.projects.project.allow_tests = false;
    const { manager } = await setup.load();
    await assert.rejects(manager.plan({ provider: "fixture", project_id: "other", name: "test", models: ["model-a"] }));
    const plan = await manager.plan({ provider: "fixture", project_id: "project", name: "test", models: ["model-a"] });
    await assert.rejects(manager.apply(plan.id), /política|politica/);
    await assert.rejects(manager.testCombo("fixture", "project", "external"), /política|politica/);
    await assert.rejects(manager.apply("../outside"));
    const content = await readFile(join(setup.root, "state", plan.id + ".json"), "utf8");
    assert(!content.includes("management-fixture"));
  } finally { await setup.close(); }
});

test("queued jobs and retries revalidate the saved project combo before inference", async () => {
  const setup = await fixture();
  try {
    const plan = await setup.manager.plan({ provider: "fixture", project_id: "project", name: "coding", models: ["model-a"] });
    const applied = await setup.manager.apply(plan.id);
    const agent = await setup.manager.resolveAgent({ id: "custom", provider: "fixture", concurrency: 1 } as never, "project", applied.result!.id);
    const jobs = new JobManager(setup.registry, join(setup.root, "jobs"), async input => {
      await setup.manager.resolveAgent(input.agent, input.combo_selection!.project_id, input.combo_selection!.combo_id);
    });
    await jobs.init();
    setup.combos.find(combo => combo.id === applied.result!.id)!.models = ["model-b"];
    const job = await jobs.submit({ agent, task: "test", combo_selection: { project_id: "project", combo_id: applied.result!.id } });
    const settle = async (id: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await jobs.refresh(id);
        if (!["queued", "running"].includes(current.status)) return current;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Job did not settle");
    };
    assert.equal((await settle(job.id)).status, "error");
    assert.equal((await settle((await jobs.retry(job.id)).id)).status, "error");
    assert(!setup.requests.some(request => request.url === "/v1/chat/completions"));
  } finally { await setup.close(); }
});
