import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "./agents.js";
import { JobManager } from "./jobs.js";
import type { RouterClient } from "./router-client.js";

const agent: Agent = {
  id: "test", route: "combo-test", role: "teste", description: "Agente de teste", temperature: 0,
  fallback_routes: [], route_strategy: "round_robin",
  timeout_ms: 2_000, first_byte_timeout_ms: 1_000, idle_timeout_ms: 1_000,
  max_output_tokens: 100, retries: 0, concurrency: 1,
};

test("job assíncrono salva checkpoint e resultado", async () => {
  const directory = await mkdtemp(join(tmpdir(), "9router-jobs-"));
  const runner: Pick<RouterClient, "delegate"> = {
    async delegate(currentAgent, _task, _context, _instructions, _format, options) {
      await options?.onProgress?.({ delta: "OK", content: "OK" });
      return {
        agent: currentAgent.id, requested_route: currentAgent.route, effective_model: "fake", request_id: "request",
        selected_route: currentAgent.route, status: "success", content: "OK", finish_reason: "stop", elapsed_ms: 1, attempts: [],
        quality: { status: "ok", issues: [], context_chars: 0, context_bytes: 0, context_sha256: "", output_chars: 2 },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    },
  };
  try {
    const manager = new JobManager(runner, directory);
    await manager.init();
    const submitted = await manager.submit({ agent, task: "teste", state: { decisions: ["preservar API"], test_results: ["pendente"] }, routing: { agent: "test" } });
    while (["queued", "running"].includes(manager.get(submitted.id).status)) await new Promise((resolve) => setTimeout(resolve, 5));
    const job = manager.get(submitted.id);
    assert.equal(job.status, "success");
    assert.equal(job.partial_content, "OK");
    assert.equal(JSON.parse(await readFile(join(directory, `${job.id}.json`), "utf8")).result.content, "OK");
    const second = new JobManager(runner, directory);
    await second.init();
    assert.deepEqual(second.get(job.id).input.state, submitted.input.state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("outra sessão não interrompe nem cancela tarefa de processo vivo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "9router-owner-"));
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const runner = { async delegate(): Promise<never> { await gate; throw new Error("fim do teste"); } };
  try {
    const first = new JobManager(runner, directory); await first.init();
    const job = await first.submit({ agent, task: "teste" });
    await new Promise(resolve => setTimeout(resolve, 30));
    const second = new JobManager(runner, directory); await second.init();
    assert.equal(second.get(job.id).status, "running");
    await assert.rejects(second.cancel(job.id), /outra sessão/);
    finish();
    while (["queued", "running"].includes(first.get(job.id).status)) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await second.refresh(job.id)).status, "error");
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { finish(); await rm(directory, { recursive: true, force: true }); }
});

test("submissões e cancelamentos concorrentes preservam JSON válido", async () => {
  const directory = await mkdtemp(join(tmpdir(), "9router-jobs-race-"));
  const runner: Pick<RouterClient, "delegate"> = {
    async delegate(currentAgent, _task, _context, _instructions, _format, options) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        options?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      return {
        agent: currentAgent.id, requested_route: currentAgent.route, selected_route: currentAgent.route,
        effective_model: "fake", request_id: "request", status: "success", content: "OK",
        finish_reason: "stop", elapsed_ms: 1, attempts: [],
        quality: { status: "ok", issues: [], context_chars: 0, context_bytes: 0, context_sha256: "", output_chars: 2 },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    },
  };
  try {
    const manager = new JobManager(runner, directory);
    await manager.init();
    const submitted = await Promise.all([1, 2, 3].map((n) => manager.submit({ agent, task: `teste ${n}` })));
    await Promise.all(submitted.map(({ id }) => manager.cancel(id)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const { id } of submitted) {
      assert.equal(manager.get(id).status, "cancelled");
      assert.equal(JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")).id, id);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
