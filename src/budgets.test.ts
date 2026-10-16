import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedBudget } from "./budgets.js";
import { spawn } from "node:child_process";

test("shared reservations enforce concurrency and aggregate quota across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-budget-"));
  try {
    const policy = { max_concurrent: 1, max_requests: 2, max_reserved_tokens: 100, window_ms: 60000 };
    const first = new SharedBudget(root, "backend", policy);
    const second = new SharedBudget(root, "backend", policy);
    const results = await Promise.allSettled([first.acquire("agent", 1), second.acquire("agent", 1)]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    const lease = results.find(item => item.status === "fulfilled")! as PromiseFulfilledResult<string>;
    await first.reserveAttempt(lease.value, 40);
    await first.finish(lease.value, false);
    const next = await second.acquire("agent", 1);
    await second.reserveAttempt(next, 60);
    await assert.rejects(second.reserveAttempt(next, 1), /quota|cota|limite/i);
    await second.finish(next, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uncertain and crashed operations keep concurrency reserved after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-budget-"));
  try {
    const policy = { max_concurrent: 1, max_requests: 10, max_reserved_tokens: 1000, window_ms: 1 };
    const budget = new SharedBudget(root, "backend", policy);
    const lease = await budget.acquire("agent", 1);
    await budget.reserveAttempt(lease, 20);
    await budget.finish(lease, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const restarted = new SharedBudget(root, "backend", policy);
    await assert.rejects(restarted.acquire("agent", 1), /concorr|concurr/i);
    assert.equal((await restarted.inspect()).uncertain, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project allowances cannot bypass provider quota or be omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-budget-"));
  try {
    const budget = new SharedBudget(root, "backend", { max_concurrent: 3, max_requests: 1, max_reserved_tokens: 100, window_ms: 60000,
      projects: { alpha: { max_concurrent: 1, max_requests: 1, max_reserved_tokens: 100 }, beta: { max_concurrent: 1, max_requests: 1, max_reserved_tokens: 100 } } });
    await assert.rejects(budget.acquire("agent", 1), /projeto|project/i);
    const first = await budget.acquire("agent", 1, "alpha");
    await budget.reserveAttempt(first, 20);
    await budget.finish(first, false);
    const second = await budget.acquire("other", 1, "beta");
    await assert.rejects(budget.reserveAttempt(second, 20), /quota|cota|limite/i);
    await budget.finish(second, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two independent processes dispute the last reservation atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-budget-processes-"));
  try {
    const source = new URL("../dist/budgets.js", import.meta.url).href;
    const code = `import { SharedBudget } from ${JSON.stringify(source)};
      const budget = new SharedBudget(process.argv[1], "backend", {max_concurrent:2,max_requests:1,max_reserved_tokens:100,window_ms:60000});
      const lease = await budget.acquire("agent",2);
      try { await budget.reserveAttempt(lease,50); console.log("reserved"); }
      catch { console.log("denied"); }
      finally { await budget.finish(lease,false); }`;
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, root], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; let errors = "";
      child.stdout.on("data", chunk => output += chunk);
      child.stderr.on("data", chunk => errors += chunk);
      child.on("error", reject);
      child.on("exit", status => status === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    });
    assert.deepEqual((await Promise.all([run(), run()])).sort(), ["denied", "reserved"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
