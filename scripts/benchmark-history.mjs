import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JobManager } from "../dist/jobs.js";

const runner = { async delegate() { throw new Error("Benchmark must not run inference"); } };

if (process.argv[2] === "--worker") {
  const [directory, expectedCount] = process.argv.slice(3);
  global.gc();
  const before = process.memoryUsage();
  const started = performance.now();
  const manager = new JobManager(runner, directory);
  await manager.init();
  const bootstrapMs = performance.now() - started;
  const summaries = manager.list(Number(expectedCount));
  assert.equal(summaries.length, Number(expectedCount));
  assert.ok(summaries.every(job => job.input.task === "" && job.partial_content === "" && !job.result?.content));
  assert.ok(manager.get(summaries[0].id).input.task.startsWith("synthetic:"));
  assert.equal(manager.list(1)[0].input.task, "");
  global.gc();
  const after = process.memoryUsage();
  console.log(JSON.stringify({ bootstrap_ms: bootstrapMs, rss_bytes: after.rss, heap_used_bytes: after.heapUsed,
    rss_delta_bytes: after.rss - before.rss, heap_delta_bytes: after.heapUsed - before.heapUsed,
    list_json_bytes: Buffer.byteLength(JSON.stringify(summaries)), body_free_summaries: true, full_content_retrievable: true }));
} else {
  const directory = await mkdtemp(join(tmpdir(), "multiagents-history-benchmark-"));
  const measurements = [];
  try {
    for (const fixture of [{ label: "small", count: 20, characters: 4096 }, { label: "large", count: 400, characters: 131072 }]) {
      const files = [];
      for (let index = 0; index < fixture.count; index++) {
        const id = randomUUID();
        const agent = { id: "synthetic", route: "synthetic", role: "benchmark", description: "Synthetic only", concurrency: 1 };
        const job = { id, status: "success", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
          input: { agent, task: `synthetic:${"x".repeat(fixture.characters)}` }, partial_content: "y".repeat(fixture.characters) };
        const file = join(directory, `${id}.json`);
        await writeFile(file, JSON.stringify(job), { mode: 0o600 });
        files.push({ file, job });
      }
      for (const mode of ["legacy", "sidecars"]) {
        if (mode === "sidecars") {
          for (const { file, job } of files) {
            const source = await stat(file);
            const summary = { ...job, input: { agent: job.input.agent, task: "" }, partial_content: "" };
            await writeFile(`${file}.meta`, JSON.stringify({ job: summary, bytes: source.size, modified: source.mtimeMs }), { mode: 0o600 });
          }
        }
        const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", directory, String(fixture.count)], { encoding: "utf8" });
        assert.equal(child.status, 0, child.stderr);
        measurements.push({ fixture: fixture.label, mode, jobs: fixture.count, body_characters_per_job: fixture.characters * 2, ...JSON.parse(child.stdout) });
      }
      for (const { file } of files) {
        await rm(file);
        await rm(`${file}.meta`);
      }
    }
    const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(JSON.stringify({ measured_at: new Date().toISOString(), node: process.version, package_version: packageInfo.version,
      platform: process.platform, architecture: process.arch,
      method: "Fresh child process per measurement; synthetic files; explicit GC before and after; warm filesystem cache; one sample, no performance threshold. Legacy reads all bodies once at startup; sidecars validate source size and mtime. RSS includes transient parsing and allocator retention.", measurements }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
