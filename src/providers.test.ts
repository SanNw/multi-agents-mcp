import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadAgents } from "./agents.js";
import { ProviderRegistry } from "./providers.js";
import { RouterClient } from "./router-client.js";

test("URL genérica normaliza /v1 e não herda chave legada", () => {
  const client = new RouterClient({ MULTIAGENTS_BASE_URL: "http://127.0.0.1:1234/api/v1/", NINEROUTER_KEY: "legacy-fixture" });
  assert.equal(client.baseUrl, "http://127.0.0.1:1234/api");
  assert.equal(client.apiKey, "");
  assert.throws(() => new RouterClient({ MULTIAGENTS_BASE_URL: "https://user:pass@example.com/v1" }), /credenciais/);
});

test("perfis isolam chave, catálogo e endpoint em duas inferências reais locais", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiagents-providers-"));
  const seen: Array<{ url?: string; key?: string }> = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request body */ }
    seen.push({ url: request.url, key: request.headers.authorization });
    response.end(JSON.stringify({ model: "fixture", choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const config = join(directory, "providers.yaml");
    await writeFile(config, `providers:\n  first:\n    base_url: http://127.0.0.1:${port}/first/v1\n    api_key_env: FIRST_KEY\n    models: [combo]\n  second:\n    base_url: http://127.0.0.1:${port}/second/v1\n    api_key_env: SECOND_KEY\n    streaming: false\n    models: [combo]\n`);
    const registry = await ProviderRegistry.load({ MULTIAGENTS_PROVIDERS_CONFIG: config, FIRST_KEY: "first-fixture", SECOND_KEY: "second-fixture", NINEROUTER_KEY: "never-send-this" });
    const agent = (await loadAgents())[0]!;
    for (const provider of ["first", "second"]) {
      assert.equal((await registry.delegate({ ...agent, provider }, "teste", undefined, undefined, undefined, { retries: 0 })).provider, provider);
    }
    assert.deepEqual(seen, [{ url: "/first/v1/chat/completions", key: "Bearer first-fixture" }, { url: "/second/v1/chat/completions", key: "Bearer second-fixture" }]);
    assert.equal(registry.list().find(profile => profile.id === "first")?.models_source, "configured");
    assert.deepEqual(await registry.models("second"), [{ id: "combo" }]);
    await assert.rejects(registry.delegate({ ...agent, provider: "unknown" }, "teste"), /desconhecido/);
    await assert.rejects(ProviderRegistry.load({ MULTIAGENTS_PROVIDERS_CONFIG: config }), /Credencial/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared policy counts retries and denies the next HTTP effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiagents-quota-"));
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    calls++;
    response.statusCode = 503;
    response.end("temporarily unavailable");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const config = join(directory, "providers.yaml");
    await writeFile(config, `providers:\n  limited:\n    base_url: http://127.0.0.1:${port}/v1\n    max_input_chars: 1000\n    limits:\n      max_concurrent: 1\n      max_requests: 1\n      max_reserved_tokens: 10000\n      window_ms: 60000\n`);
    const env = { MULTIAGENTS_PROVIDERS_CONFIG: config, MULTIAGENTS_BUDGETS_DIR: join(directory, "budgets") };
    const registry = await ProviderRegistry.load(env);
    const agent = { ...(await loadAgents())[0]!, provider: "limited", fallback_routes: ["fixture-fallback"] };
    await assert.rejects(registry.delegate(agent, "x".repeat(1001)), /política/);
    assert.equal(calls, 0);
    await assert.rejects(registry.delegate(agent, "teste", undefined, undefined, undefined, { retries: 1 }), /cota/);
    assert.equal(calls, 1);
    const otherSession = await ProviderRegistry.load(env);
    await assert.rejects(otherSession.delegate(agent, "teste"), /cota/);
    assert.equal(calls, 1);
    assert.equal((await registry.inspectBudgets())[0]?.requests_reserved, 1);
    assert.equal((await registry.inspectBudgets())[0]?.active, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("an uncertain attempt stays reserved when a retry is denied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiagents-uncertain-"));
  let calls = 0;
  const server = createServer(request => { calls++; request.socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const config = join(directory, "providers.yaml");
    await writeFile(config, `providers:\n  limited:\n    base_url: http://127.0.0.1:${port}/v1\n    limits:\n      max_concurrent: 1\n      max_requests: 1\n      max_reserved_tokens: 100000\n      window_ms: 60000\n`);
    const registry = await ProviderRegistry.load({ MULTIAGENTS_PROVIDERS_CONFIG: config, MULTIAGENTS_BUDGETS_DIR: join(directory, "budgets") });
    const agent = { ...(await loadAgents())[0]!, provider: "limited", fallback_routes: ["fixture-fallback"] };
    await assert.rejects(registry.delegate(agent, "teste", undefined, undefined, undefined, { retries: 1 }), /cota/);
    assert.equal(calls, 1);
    const [state] = await registry.inspectBudgets();
    assert.equal(state?.uncertain, 1);
    assert.equal(state?.leases[0]?.owner_pid, process.pid);
    await assert.rejects(registry.delegate(agent, "teste"), /concorrência/);
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
