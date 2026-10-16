import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseConfiguration, inspectStateLocks } from "./diagnostics.js";

test("offline diagnostics report missing credentials and bad agents without network, secrets or paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-diagnostics-"));
  try {
    const config = join(root, "profiles.yaml");
    await writeFile(config, JSON.stringify({ providers: { missing: { base_url: "https://private.example.invalid/v1", api_key_env: "MISSING_KEY" } } }));
    const report = await diagnoseConfiguration({ MULTIAGENTS_PROVIDERS_CONFIG: config, AGENTS_CONFIG: join(root, "not-found.yaml"), MULTIAGENTS_API_KEY: "never-show-fixture" });
    assert.equal(report.network, false); assert.equal(report.inference, false);
    assert(report.checks.some(check => check.id === "credential:missing" && check.status === "error"));
    assert(report.checks.some(check => check.id === "agents" && check.status === "error"));
    const text = JSON.stringify(report);
    for (const hidden of [root, "never-show-fixture", "private.example.invalid", "MISSING_KEY"]) assert(!text.includes(hidden));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diagnostics validate configured agent/provider references and placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-diagnostics-"));
  try {
    const agents = join(root, "agents.yaml");
    await writeFile(agents, JSON.stringify({ agents: { mine: { provider: "missing", route: "your-model-id", role: "custom", description: "Fixture" } } }));
    const report = await diagnoseConfiguration({ AGENTS_CONFIG: agents });
    assert(report.checks.some(check => check.id === "agent-provider:mine" && check.status === "error"));
    assert(report.checks.some(check => check.id === "agent-route:mine" && check.status === "warning"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery inspection reports surviving locks without removing or exposing arbitrary names", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-lock-inspection-"));
  try {
    await writeFile(join(root, "write.lock"), "preserve-fixture");
    await writeFile(join(root, "private-name.lock"), "preserve-fixture");
    const result = await inspectStateLocks({ MULTIAGENTS_COMBOS_DIR: root, MULTIAGENTS_JOBS_DIR: join(root, "missing", "jobs") });
    assert.deepEqual(result.find(item => item.store === "combos"), { store: "combos", status: "inspected", locks: ["write.lock"], unrecognized: 1, ownership: "unknown" });
    assert.equal(await readFile(join(root, "write.lock"), "utf8"), "preserve-fixture");
    assert(!JSON.stringify(result).includes("private-name"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
