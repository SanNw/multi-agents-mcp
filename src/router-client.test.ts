import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Agent } from "./agents.js";
import { RouterError } from "./errors.js";
import { RouterClient } from "./router-client.js";

const agent: Agent = {
  id: "test", route: "combo-test", role: "teste", description: "Agente de teste", temperature: 0,
  fallback_routes: ["combo-fallback"], route_strategy: "fallback",
  timeout_ms: 2_000, first_byte_timeout_ms: 1_000, idle_timeout_ms: 1_000,
  max_output_tokens: 100, retries: 0, concurrency: 1,
};

test("retorna conclusão JSON e telemetria", async () => withServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ model: "effective", choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { total_tokens: 3 } }));
}, async (url) => {
  const result = await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste");
  assert.equal(result.content, "OK");
  assert.equal(result.effective_model, "effective");
  assert.equal(result.attempts.length, 1);
}));

test("repete HTTP transitório e preserva as tentativas", async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls += 1;
    response.setHeader("content-type", "application/json");
    if (calls === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: "overloaded" } }));
    } else response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  }, async (url) => {
    const result = await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", undefined, undefined, undefined, { retries: 1 });
    assert.equal(result.content, "OK");
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.code, "HTTP_503");
  });
});

test("repete indisponibilidade transitória reportada como HTTP 400", async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls += 1;
    response.setHeader("content-type", "application/json");
    if (calls === 1) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: "Upstream request failed: Model is unavailable." } }));
    } else response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  }, async (url) => {
    const result = await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", undefined, undefined, undefined, { retries: 1 });
    assert.equal(result.content, "OK");
    assert.equal(result.attempts[0]?.code, "HTTP_400");
  });
});

test("classifica JSON inválido", async () => withServer((_request, response) => response.end("não-json"), async (url) => {
  await assert.rejects(
    new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste"),
    (error: unknown) => error instanceof RouterError && error.code === "INVALID_JSON",
  );
}));

test("agrega stream SSE e publica progresso", async () => withServer((_request, response) => {
  response.setHeader("content-type", "text/event-stream");
  response.write('data: {"model":"effective","choices":[{"delta":{"content":"O"}}]}\n\n');
  response.write('data: {"choices":[{"delta":{"content":"K"},"finish_reason":"stop"}]}\n\n');
  response.end("data: [DONE]\n\n");
}, async (url) => {
  const progress: string[] = [];
  const result = await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", undefined, undefined, undefined, {
    stream: true, onProgress: ({ content }) => { progress.push(content); },
  });
  assert.equal(result.content, "OK");
  assert.deepEqual(progress, ["O", "OK"]);
}));

test("marca saída truncada como degradada e tenta a rota seguinte", async () => {
  const routes: string[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model: string };
    routes.push(body.model);
    response.setHeader("content-type", "application/json");
    if (routes.length === 1) {
      response.end(JSON.stringify({ choices: [{ message: { content: "## S0001\nparcial" }, finish_reason: "length" }] }));
    } else {
      response.end(JSON.stringify({ choices: [{ message: { content: "## S0001\ncompleto\n\n## S0002\ncompleto" }, finish_reason: "stop" }] }));
    }
  }, async (url) => {
    const result = await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", "fonte", undefined, undefined, {
      retries: 1, expectedIds: ["S0001", "S0002"],
    });
    assert.equal(result.status, "success");
    assert.deepEqual(routes, ["combo-test", "combo-fallback"]);
    assert.equal(result.attempts[0]?.status, "degraded");
    assert.deepEqual(result.attempts[0]?.quality_issues, ["FINISH_REASON_LENGTH", "EXPECTED_IDS_MISMATCH"]);
  });
});

test("expõe contexto e devolve degradação sem falso sucesso semântico", async () => withServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { content: "Here's a thinking process..." }, finish_reason: "length" }] }));
}, async (url) => {
  const result = await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", "abc", undefined, undefined, {
    retries: 0, expectedText: "OK",
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.quality.context_chars, 3);
  assert.equal(result.quality.context_bytes, 3);
  assert.match(result.quality.context_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.quality.issues.map(({ code }) => code), [
    "FINISH_REASON_LENGTH", "EXPECTED_TEXT_MISMATCH", "REASONING_LEAK",
  ]);
}));

test("preserva a melhor saída degradada quando o fallback falha", async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls += 1;
    response.setHeader("content-type", "application/json");
    if (calls === 1) {
      response.end(JSON.stringify({ choices: [{ message: { content: "## S0002\nb\n\n## S0001\na" }, finish_reason: "stop" }] }));
    } else {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: "overloaded" } }));
    }
  }, async (url) => {
    const result = await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", undefined, undefined, undefined, {
      retries: 1, expectedIds: ["S0001", "S0002"],
    });
    assert.equal(result.status, "degraded");
    assert.equal(result.content.startsWith("## S0002"), true);
    assert.equal(result.attempts.at(-1)?.status, "error");
    assert.match(result.quality.issues[0]?.message ?? "", /ordem divergente/);
  });
});

test("abre circuito para rota indisponível e a ignora na chamada seguinte", async () => {
  const routes: string[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model: string };
    routes.push(body.model);
    response.setHeader("content-type", "application/json");
    if (body.model === "combo-test") {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: "Model is unavailable." } }));
    } else response.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
  }, async (url) => {
    const client = new RouterClient({ NINEROUTER_URL: url, NINEROUTER_CIRCUIT_BREAKER_MS: "60000" });
    await client.delegate(agent, "teste", undefined, undefined, undefined, { retries: 1, expectedText: "OK" });
    await client.delegate(agent, "teste", undefined, undefined, undefined, { retries: 0, expectedText: "OK" });
    assert.deepEqual(routes, ["combo-test", "combo-fallback", "combo-fallback"]);
  });
});

test("abre circuito para rota que vaza raciocínio", async () => {
  const routes: string[] = [];
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model: string };
    routes.push(body.model);
    response.setHeader("content-type", "application/json");
    const content = body.model === "combo-test" ? "Here's a thinking process..." : "OK";
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  }, async (url) => {
    const client = new RouterClient({ NINEROUTER_URL: url, NINEROUTER_CIRCUIT_BREAKER_MS: "60000" });
    await client.delegate(agent, "teste", undefined, undefined, undefined, { retries: 1, expectedText: "OK" });
    await client.delegate(agent, "teste", undefined, undefined, undefined, { retries: 0, expectedText: "OK" });
    assert.deepEqual(routes, ["combo-test", "combo-fallback", "combo-fallback"]);
  });
});

test("401 não provoca retry nem expõe erro bruto do provedor", async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls++; response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: "temporarily token=SECRET sk-secret-key" } }));
  }, async url => {
    await assert.rejects(new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", undefined, undefined, undefined, { retries: 2 }),
      (error: unknown) => error instanceof RouterError && error.code === "HTTP_401" && !error.message.includes("SECRET"));
    assert.equal(calls, 1);
  });
});

test("circuitos abertos não são ignorados e métricas ausentes são null", async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls++; response.statusCode = 503; response.end("indisponível");
  }, async url => {
    const client = new RouterClient({ NINEROUTER_URL: url });
    await assert.rejects(client.delegate(agent, "teste", undefined, undefined, undefined, { retries: 1 }));
    await assert.rejects(client.delegate(agent, "teste"), (error: unknown) => error instanceof RouterError && error.code === "CIRCUIT_OPEN");
    assert.equal(calls, 2);
  });
  await withServer((_request, response) => response.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] })), async url => {
    assert.equal((await new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste")).usage.total_tokens, null);
  });
});

test("stream parcial interrompido não é repetido automaticamente", async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls++; response.setHeader("content-type", "text/event-stream");
    response.write('data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n');
  }, async url => {
    let partial = "";
    await assert.rejects(new RouterClient({ NINEROUTER_URL: url }).delegate(agent, "teste", undefined, undefined, undefined,
      { stream: true, idleTimeoutMs: 30, retries: 2, onProgress: ({ content }) => { partial = content; } }),
      (error: unknown) => error instanceof RouterError && error.code === "STREAM_INTERRUPTED" && !error.retryable);
    assert.equal(calls, 1); assert.equal(partial, "parcial");
  });
});

async function withServer(listener: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function readBody(request: Parameters<RequestListener>[0]) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
