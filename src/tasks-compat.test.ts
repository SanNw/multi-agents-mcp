import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

test("experimental SDK Tasks negotiate and expose seeded get/result/cancel without an execution runner", { timeout: 5000 }, async () => {
  const store = new InMemoryTaskStore();
  const server = new Server({ name: "tasks-protocol-fixture", version: "1" }, {
    capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, taskStore: store,
  });
  const client = new Client({ name: "tasks-client-fixture", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual(client.getServerCapabilities()?.tasks?.cancel, {});
    const completed = await store.createTask({ ttl: 30000 }, "completed-fixture", { method: "tools/call", params: { name: "fixture" } });
    await store.storeTaskResult(completed.taskId, "completed", { content: [{ type: "text", text: "stored fixture result" }] });
    assert.equal((await client.experimental.tasks.getTask(completed.taskId, { timeout: 1000 })).status, "completed");
    const result = await client.experimental.tasks.getTaskResult(completed.taskId, CallToolResultSchema, { timeout: 1000 });
    assert.deepEqual(result.content, [{ type: "text", text: "stored fixture result" }]);
    const running = await store.createTask({ ttl: 30000 }, "running-fixture", { method: "tools/call", params: { name: "fixture" } });
    assert.equal((await client.experimental.tasks.cancelTask(running.taskId, { timeout: 1000 })).status, "cancelled");
    assert.equal((await store.getTask(running.taskId))?.status, "cancelled");
    assert.equal((await client.experimental.tasks.listTasks(undefined, { timeout: 1000 })).tasks.length, 2);
  } finally {
    store.cleanup();
    await client.close();
    await server.close();
  }
});

test("client without Tasks retains ordinary callTool compatibility", { timeout: 5000 }, async () => {
  const server = new Server({ name: "ordinary-protocol-fixture", version: "1" }, { capabilities: { tools: {} } });
  let calls = 0;
  server.setRequestHandler(CallToolRequestSchema, async () => {
    calls++;
    return { content: [{ type: "text", text: "ordinary result" }] };
  });
  const client = new Client({ name: "ordinary-client-fixture", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(client.getServerCapabilities()?.tasks, undefined);
    const result = await client.callTool({ name: "fixture" }, CallToolResultSchema, { timeout: 1000 });
    assert.deepEqual(result.content, [{ type: "text", text: "ordinary result" }]);
    assert.equal(calls, 1);
    await assert.rejects(client.experimental.tasks.getTask("unknown", { timeout: 1000 }));
    assert.equal(calls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
