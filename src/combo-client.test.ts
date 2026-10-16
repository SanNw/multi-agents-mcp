import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ComboClient, managementSchema, memberModels } from "./combo-client.js";

for (const adapter of ["9router", "omniroute"] as const) {
  test(`${adapter} fixture contract: pages, credentials and unsupported payloads`, async () => {
    let mode = "pages";
    const offsets: number[] = [];
    const server = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer fixture-secret") { response.writeHead(401); response.end("{}"); return; }
      const offset = Number(new URL(request.url!, "http://fixture").searchParams.get("offset"));
      offsets.push(offset);
      if (mode === "unsupported") { response.end(JSON.stringify({ data: [] })); return; }
      if (mode === "short-page") { response.end(JSON.stringify({ combos: [], total: 101 })); return; }
      const count = offset === 0 ? 100 : 1;
      response.end(JSON.stringify({ combos: Array.from({ length: count }, (_, index) => ({ id: String(offset + index), name: "route-" + (offset + index), models: [{ model: "example", providerId: "provider" }], strategy: "priority" })), total: 101 }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const config = managementSchema.parse({ adapter, base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, api_key_env: "KEY", projects: {} });
    try {
      const client = new ComboClient(config, "fixture-secret");
      const combos = await client.list();
      assert.equal(combos.length, 101);
      assert.deepEqual(offsets, [0, 100]);
      assert.deepEqual(memberModels(combos[0]!), ["provider/example"]);
      assert.equal(combos[0]!.strategy, adapter === "9router" ? "backend-default" : "priority");
      await assert.rejects(new ComboClient(config, "invalid").list(), /HTTP 401/);
      mode = "unsupported";
      await assert.rejects(client.list(), /não suportado/);
      mode = "short-page";
      await assert.rejects(client.list(), /inventário incompleto/);
      assert.throws(() => memberModels({ id: "nested", name: "nested", strategy: "priority", models: [{ kind: "combo-ref", comboName: "external" }] }), /não suportado/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
