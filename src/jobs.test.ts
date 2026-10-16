import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "./agents.js";
import { JobManager } from "./jobs.js";

async function waitForIdle(manager: JobManager) {
  const deadline = Date.now() + 10000;
  while (true) {
    const state = await manager.inspect();
    if (!state.active && !state.queued && !state.pending_submissions) return;
    assert(Date.now() < deadline, "Job manager did not become idle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("history summaries omit heavy bodies and preserve lazy access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jobs-history-"));
  try {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const body = { id, status: "success", created_at: "2026-01-01", updated_at: "2026-01-01", input: { agent, task: "private".repeat(10000) }, partial_content: "large".repeat(10000) };
    await writeFile(join(directory, `${id}.json`), JSON.stringify(body));
    const manager = new JobManager({ async delegate() { throw new Error("must not run"); } }, directory);
    await manager.init();
    assert.equal(manager.list()[0].input.task, "");
    assert.equal(manager.list()[0].partial_content, "");
    assert.equal(manager.get(id).input.task, body.input.task);
    assert.equal(manager.list()[0].input.task, "");
    assert.equal((await manager.inspect()).jobs[0].ownership, "unknown");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed running persistence releases the queue without calling inference twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jobs-persist-"));
  let calls = 0;
  const manager = new JobManager({ async delegate() { calls++; throw new Error("finished"); } }, directory);
  await manager.init();
  const original = (manager as any).persist.bind(manager);
  let failed = false;
  (manager as any).persist = async (job: any) => {
    if (job.status === "running" && !failed) { failed = true; throw new Error("disk full"); }
    return original(job);
  };
  try {
    const first = await manager.submit({ agent, task: "first" });
    const second = await manager.submit({ agent, task: "second" });
    await waitForIdle(manager);
    assert.equal(manager.get(first.id).status, "error");
    assert.equal(manager.get(second.id).status, "error");
    assert.equal(calls, 1);
    assert.equal((manager as any).controllers.size, 0);
  } finally { await waitForIdle(manager); await rm(directory, { recursive: true, force: true }); }
});

test("terminal persistence failure retains uncertainty and releases concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jobs-final-write-"));
  let calls = 0;
  const manager = new JobManager({ async delegate() { calls++; throw new Error("provider completed"); } }, directory);
  await manager.init();
  const persist = (manager as any).persist.bind(manager);
  (manager as any).persist = async (job: any) => {
    if (job.input.task === "first" && job.status === "error") throw new Error("disk full");
    return persist(job);
  };
  try {
    const first = await manager.submit({ agent, task: "first" });
    const second = await manager.submit({ agent, task: "second" });
    await waitForIdle(manager);
    assert.equal(manager.get(first.id).persistence_uncertain, true);
    assert.equal(manager.get(second.id).status, "error");
    assert.equal(calls, 2);
    await assert.rejects(manager.retry(first.id), /incerto/);
  } finally { await waitForIdle(manager); await rm(directory, { recursive: true, force: true }); }
});

test("foreign session fallback identity stays unknown and bootstrap does not mutate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jobs-foreign-"));
  try {
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const body = JSON.stringify({ id, status: "running", created_at: "2026-01-01", updated_at: "2026-01-01", input: { agent, task: "test" }, partial_content: "", owner: { pid: process.pid, host: (await import("node:os")).hostname(), identity: "session:foreign", session: "foreign" } });
    await writeFile(join(directory, `${id}.json`), body);
    const manager = new JobManager({ async delegate() { throw new Error("must not run"); } }, directory);
    await manager.init();
    assert.equal((await manager.inspect()).jobs[0].ownership, "unknown");
    await assert.rejects(manager.cancel(id), /outra sessão/);
    assert.equal(await readFile(join(directory, `${id}.json`), "utf8"), body);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("queue cap rejects before persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jobs-queue-cap-"));
  const previous = process.env.MULTIAGENTS_MAX_QUEUED_JOBS;
  process.env.MULTIAGENTS_MAX_QUEUED_JOBS = "1";
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const manager = new JobManager({ async delegate() { await gate; throw new Error("finished"); } }, directory);
  try {
    await manager.init();
    await manager.submit({ agent, task: "running" });
    await manager.submit({ agent, task: "queued" });
    await assert.rejects(manager.submit({ agent, task: "denied" }), /fila/);
    assert.equal(manager.list().length, 2);
    assert.equal((await manager.inspect()).queued, 1);
    finish();
    while (manager.list().some(job => ["queued", "running"].includes(job.status))) await new Promise(resolve => setTimeout(resolve, 5));
  } finally {
    finish();
    await new Promise(resolve => setTimeout(resolve, 60));
    if (previous === undefined) delete process.env.MULTIAGENTS_MAX_QUEUED_JOBS; else process.env.MULTIAGENTS_MAX_QUEUED_JOBS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing proc uses session ownership and PID reuse is interrupted without inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jobs-portable-"));
  const runner = { async delegate(): Promise<never> { throw new Error("finished"); } };
  try {
    const missingProc = new JobManager(runner, directory, undefined, { identity: async () => undefined });
    await missingProc.init();
    const submitted = await missingProc.submit({ agent, task: "portable" });
    while (["queued", "running"].includes(missingProc.get(submitted.id).status)) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(missingProc.get(submitted.id).owner!.identity, /^session:/);
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, status: "running", created_at: "2026-01-01", updated_at: "2026-01-01", input: { agent, task: "old" }, partial_content: "", owner: { pid: process.pid, host: (await import("node:os")).hostname(), identity: "old-boot:old-start" } }));
    const restarted = new JobManager(runner, directory, undefined, { platform: "linux", identity: async () => "new-boot:new-start" });
    await restarted.init();
    assert.equal(restarted.get(id).status, "interrupted");
    await writeFile(join(directory, "dddddddd-dddd-dddd-dddd-dddddddddddd.json"), "{broken");
    const native = new JobManager(runner, directory, undefined, { platform: "win32" });
    await native.init();
    assert.equal((await native.inspect()).unreadable.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fresh sidecars bootstrap without reading bodies and stale indexes fall back safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jobs-sidecar-"));
  const runner = { async delegate(): Promise<never> { throw new Error("completed"); } };
  try {
    const first = new JobManager(runner, directory);
    await first.init();
    const job = await first.submit({ agent, task: "large".repeat(10000) });
    while (["queued", "running"].includes(first.get(job.id).status)) await new Promise(resolve => setTimeout(resolve, 5));
    const bodyPath = join(directory, `${job.id}.json`);
    const original = await readFile(bodyPath, "utf8");
    const { stat } = await import("node:fs/promises");
    await writeFile(bodyPath, "invalid JSON");
    const info = await stat(bodyPath);
    const metadataPath = `${bodyPath}.meta`;
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.bytes = info.size;
    metadata.modified = info.mtimeMs;
    await writeFile(metadataPath, JSON.stringify(metadata));
    const second = new JobManager(runner, directory);
    await second.init();
    assert.equal(second.list()[0].id, job.id);
    assert.equal(second.list()[0].input.task, "");
    assert.throws(() => second.get(job.id), SyntaxError);
    await writeFile(bodyPath, original);
    const third = new JobManager(runner, directory);
    await third.init();
    assert.equal(third.get(job.id).input.task, job.input.task);
    assert.equal(await readFile(bodyPath, "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
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
