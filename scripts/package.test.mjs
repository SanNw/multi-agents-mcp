import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("npm tarball includes executable/configs but excludes state and test code", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const files = pack.files.map(file => file.path);
  for (const name of ["dist/index.js", "config/agents.example.yaml", "LICENSE", "README.md"]) assert(files.includes(name), name);
  for (const file of files) {
    assert(!["config/agents.yaml", "config/technical-agents.yaml", "docs/model-selection.md"].includes(file), file);
    assert(!/(?:^|\/)(?:\.env|\.jobs|\.workflows|\.combos|node_modules|src|release)(?:\/|$)/.test(file), file);
    assert(!file.endsWith(".test.js") && !file.endsWith(".test.ts"), file);
    assert(!/\.sqlite(?:-wal|-shm)?$|\.npmrc$/.test(file), file);
  }
});
