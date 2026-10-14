import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgents } from "./agents.js";
import type { Job } from "./jobs.js";
import { WorkflowManager, actionSchema } from "./workflows.js";

async function fixture(run: (manager: WorkflowManager, jobs: Map<string, Job>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "router-workflows-"));
  const jobs = new Map<string, Job>();
  const backend = {
    async submit(input: Job["input"]) {
      const job = { id: `job-${jobs.size}`, status: "running", input } as Job;
      jobs.set(job.id, job); return job;
    },
    async refresh(id: string) { return jobs.get(id)!; },
  };
  const manager = new WorkflowManager(backend, () => loadAgents(), directory);
  try { await run(manager, jobs, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const input = { task: "Objetivo", steps: [{ agent: "philologist", task: "Analise", acceptance: "Evidência conferida" }] };
function complete(job: Job, content: string) { job.status = "success"; job.result = { content } as Job["result"]; }

test("workflow exige revisão, preserva estado e não submete duas vezes", async () => fixture(async (manager, jobs) => {
  const workflow = await manager.create({ ...input, steps: [...input.steps, ...input.steps] });
  await manager.advance(workflow.id); await manager.advance(workflow.id);
  assert.equal(jobs.size, 1);
  await assert.rejects(manager.review(workflow.id, true, "teste"), /pronta/);
  complete(jobs.get("job-0")!, '{"summary":"evidência do original","actions":[]}');
  assert.equal((await manager.advance(workflow.id)).status, "awaiting_review");
  await manager.review(workflow.id, true, "Original comparado");
  await manager.advance(workflow.id);
  assert.match(jobs.get("job-1")!.input.context!, /Original comparado/);
  complete(jobs.get("job-1")!, '{"summary":"revisado","actions":[]}');
  await manager.advance(workflow.id);
  assert.equal((await manager.review(workflow.id, true, "checagem final")).status, "completed");
  await manager.advance(workflow.id); assert.equal(jobs.size, 2);
}));

test("ações precisam de aprovação; resultados são idempotentes e nunca executados pelo MCP", async () => fixture(async (manager, jobs) => {
  const workflow = await manager.create(input); await manager.advance(workflow.id);
  complete(jobs.get("job-0")!, '{"summary":"teste necessário","actions":[{"type":"run_tests","command":["npm","test"]}]}');
  const pending = await manager.advance(workflow.id); const action = pending.steps[0]!.actions[0]!;
  await assert.rejects(manager.recordAction(workflow.id, action.id, true, "passou"), /aprovação/);
  await manager.approveAction(workflow.id, action.id, true);
  await manager.recordAction(workflow.id, action.id, true, "passou");
  await manager.recordAction(workflow.id, action.id, true, "passou");
  await assert.rejects(manager.recordAction(workflow.id, action.id, false, "outro"), /registrado/);
  assert.equal((await manager.review(workflow.id, true, "teste real conferido")).status, "completed");
}));

test("resposta inválida e falha param o fluxo sem retry", async () => fixture(async (manager, jobs) => {
  const workflow = await manager.create(input); await manager.advance(workflow.id);
  complete(jobs.get("job-0")!, '{"summary":"não autorizar","actions":[{"type":"read_file","path":"../.env"}]}');
  assert.equal((await manager.advance(workflow.id)).status, "blocked");
  await manager.advance(workflow.id); assert.equal(jobs.size, 1);
  await assert.rejects(manager.create({ ...input, steps: Array(9).fill(input.steps[0]) }));
  assert.equal(actionSchema.safeParse({ type: "read_file", path: "/etc/passwd" }).success, false);
}));

test("workflow pode ser retomado por outro manager e serializa avanços", async () => fixture(async (manager, jobs, directory) => {
  const workflow = await manager.create(input);
  const resumed = new WorkflowManager({ async submit() { throw new Error("Não duplicar"); }, async refresh(id) { return jobs.get(id)!; } }, () => loadAgents(), directory);
  assert.equal((await resumed.get(workflow.id)).id, workflow.id);
  const concurrent = await Promise.allSettled([manager.advance(workflow.id), manager.advance(workflow.id)]);
  assert.equal(jobs.size, 1);
  assert.ok(concurrent.some(result => result.status === "fulfilled"));
}));

test("replanejamento preserva tentativa anterior e não reinicia orçamento", async () => fixture(async (manager, jobs) => {
  const workflow = await manager.create(input); await manager.advance(workflow.id);
  jobs.get("job-0")!.status = "error";
  await manager.advance(workflow.id);
  const replanned = await manager.replan(workflow.id, input.steps, "Nova hipótese verificada");
  assert.equal(replanned.replans[0]!.steps[0]!.job_id, "job-0");
  assert.equal(replanned.submissions, 1);
  await manager.advance(workflow.id);
  assert.equal((await manager.get(workflow.id)).submissions, 2);
  await assert.rejects(manager.replan(workflow.id, input.steps, "não interromper etapa ativa"), /bloqueado/);
}));

test("submissão incerta bloqueia sem repetir inferência", async () => fixture(async (_manager, _jobs, directory) => {
  let calls = 0;
  const manager = new WorkflowManager({ async submit() { calls++; throw new Error("queda após iniciar submissão"); }, async refresh() { throw new Error("Não executar"); } }, () => loadAgents(), directory);
  const workflow = await manager.create(input);
  await assert.rejects(manager.advance(workflow.id));
  assert.equal((await manager.advance(workflow.id)).status, "blocked");
  assert.equal(calls, 1);
}));
