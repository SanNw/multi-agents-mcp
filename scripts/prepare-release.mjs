import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export async function prepareRelease(root, destination) {
  const sourceRoot = await realpath(root);
  // Publication is allowlisted; private runtime files never enter staging.
  const files = ["package.json", "package-lock.json", "tsconfig.json", ".gitignore", ".env.example", "README.md", "LICENSE", "SECURITY.md",
    "docs/WORKFLOWS.md", "docs/PROVIDERS.md", "docs/SECURITY_ASSESSMENT.md", ".github/workflows/ci.yml", "scripts/prepare-release.mjs", "scripts/prepare-release.test.mjs", "scripts/package.test.mjs",
    ...(await readdir(resolve(root, "src"))).filter(name => name.endsWith(".ts")).map(name => `src/${name}`),
    "config/agents.yaml", "config/technical-agents.yaml", "config/providers.example.yaml"];
  const manifest = []; const staged = [];
  for (const name of files) {
    const source = resolve(root, name);
    if (!(await lstat(source)).isFile() || !(await realpath(source)).startsWith(sourceRoot + "/")) throw new Error(`Arquivo nao regular: ${name}`);
    const bytes = await readFile(source); const text = bytes.toString("utf8");
    const secret = /\bsk-[A-Za-z0-9_-]{16,}\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text);
    const personal = /\/mnt\/c\/Users\/San|\/home\/developer|\/mnt\/e\/Projetos|C:\\\\Users\\\\San/.test(text);
    if (secret || personal) throw new Error(`Revisao de publicacao necessaria: ${name}; conteudo nao exibido`);
    staged.push({ name, bytes });
    manifest.push({ path: name, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await mkdir(destination, { recursive: false });
  for (const { name, bytes } of staged) {
    const target = resolve(destination, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  const version = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
  await writeFile(resolve(destination, "PUBLICATION_MANIFEST.json"), JSON.stringify({ name: "MULTIAGENTS-MCP", version, files: manifest }, null, 2) + "\n");
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await mkdir(resolve(root, "release"), { recursive: true });
  if ((await lstat(resolve(root, "release"))).isSymbolicLink()) throw new Error("Diretorio release nao pode ser symlink");
  const destination = resolve(root, "release", `public-${Date.now()}`);
  const manifest = await prepareRelease(root, destination);
  console.log(JSON.stringify({ destination, files: manifest.length, status: "staged-for-review" }));
}
