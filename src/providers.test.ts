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
