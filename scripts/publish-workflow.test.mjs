import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("publish workflow requires explicit tagged, CI-approved OIDC release of the tested tarball", async () => {
  const text = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const workflow = parse(text);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.version.required, true);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.jobs), ["publish"]);
  const publish = workflow.jobs.publish;
  assert.equal(publish.environment, "npm");
  assert.equal(publish.permissions["id-token"], "write");
  assert.equal(publish.permissions.contents, "read");
  assert.equal(publish.permissions.actions, "read");
  const steps = publish.steps;
  const ci = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const ciActions = ci.jobs.test.steps.filter(step => step.uses).map(step => step.uses);
  for (const step of steps.filter(step => step.uses)) {
    assert.match(step.uses, /@[a-f0-9]{40}$/);
    assert(ciActions.includes(step.uses));
  }
  assert.equal(steps.find(step => step.uses?.startsWith("actions/setup-node@")).with["node-version"], 24);
  const verification = steps.find(step => step.name === "Verify version and immutable release target").run;
  assert(verification.includes("assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`)"));
  assert(verification.includes("assert.equal(target, process.env.GITHUB_SHA)"));
  assert(verification.includes(".version, version)"));
  const approval = steps.find(step => step.name === "Require successful CI for this exact commit").run;
  assert(approval.includes("actions/workflows/ci.yml/runs"));
  assert(approval.includes("run.head_sha === process.env.GITHUB_SHA"));
  assert(approval.includes("run.conclusion === 'success'"));
  assert(approval.includes("run.path === '.github/workflows/ci.yml'"));
  const commands = steps.filter(step => step.run).map(step => step.run).join("\n");
  assert(commands.indexOf("npm test") < commands.indexOf("npm pack --ignore-scripts --json"));
  assert(commands.indexOf("npm pack --ignore-scripts --json") < commands.indexOf("['publish', pack.filename"));
  assert.equal((commands.match(/npm pack /g) ?? []).length, 1);
  assert.equal((commands.match(/\['publish',/g) ?? []).length, 1);
  assert(commands.includes("'--provenance'"));
  assert(commands.includes("assert.equal(pack.integrity, integrity)"));
  assert(commands.includes("assert.equal(JSON.parse(remote), integrity"));
  assert(commands.includes("npm >=11.5.1 required"));
  assert(!text.includes("secrets."));
  assert(!text.includes("npm install -g"));
});
