import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareRelease } from "./prepare-release.mjs";

test("exporta somente allowlist, bloqueia segredos e nao sobrescreve staging", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "router-release-")); const root = join(temporary, "source");
  try {
    const files = ["package.json", "package-lock.json", "tsconfig.json", ".gitignore", ".env.example", "README.md", "LICENSE", "SECURITY.md",
      "docs/WORKFLOWS.md", "docs/PROVIDERS.md", "docs/SECURITY_ASSESSMENT.md", ".github/workflows/ci.yml", "scripts/prepare-release.mjs", "scripts/prepare-release.test.mjs", "scripts/package.test.mjs", "src/example.ts", "config/agents.example.yaml", "config/providers.example.yaml", ".env", ".jobs/private.json"];
    for (const file of files) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), "fixture"); }
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.4.1" }));
    const destination = join(temporary, "public");
    const manifest = await prepareRelease(root, destination);
    assert.ok(manifest.some(file => file.path === "src/example.ts"));
    await assert.rejects(readFile(join(destination, ".env")));
    await assert.rejects(readFile(join(destination, ".jobs/private.json")));
    await assert.rejects(prepareRelease(root, destination));
    await writeFile(join(root, "README.md"), ["sk", "x".repeat(32)].join("-"));
    await assert.rejects(prepareRelease(root, join(temporary, "secret")), /publicacao/);
    await writeFile(join(root, "README.md"), "fixture");
    await symlink(join(root, "README.md"), join(root, "src/link.ts"));
    await assert.rejects(prepareRelease(root, join(temporary, "symlink")), /regular/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
