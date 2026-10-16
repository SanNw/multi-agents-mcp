import { access, lstat, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { parse } from "yaml";
import { loadAgents, defaultAgentsPath } from "./agents.js";
import { providerConfigSchema } from "./providers.js";
import { RouterClient } from "./router-client.js";

export const serverVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version as string;
type Check = { id: string; status: "ok" | "warning" | "error"; message: string };

export async function inspectStateLocks(env = process.env) {
  const jobs = env.MULTIAGENTS_JOBS_DIR ?? env.NINEROUTER_JOBS_DIR ?? "./.jobs";
  const results = [];
  for (const [store, directory] of Object.entries({
    workflows: env.MULTIAGENTS_WORKFLOWS_DIR ?? env.NINEROUTER_WORKFLOWS_DIR ?? resolve(dirname(jobs), ".workflows"),
    combos: env.MULTIAGENTS_COMBOS_DIR ?? resolve(dirname(jobs), ".combos"),
    budgets: env.MULTIAGENTS_BUDGETS_DIR ?? resolve(dirname(jobs), ".budgets"),
  })) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Not private");
      const names = (await readdir(directory)).filter(name => name.endsWith(".lock"));
      results.push({ store, status: "inspected", locks: names.filter(name => /^(write|[a-f0-9-]{36}|[a-f0-9]{64})\.lock$/.test(name)),
        unrecognized: names.filter(name => !/^(write|[a-f0-9-]{36}|[a-f0-9]{64})\.lock$/.test(name)).length, ownership: "unknown" });
    } catch (error) { results.push({ store, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable", locks: [], unrecognized: 0, ownership: "unknown" }); }
  }
  return results;
}

export async function diagnoseConfiguration(env = process.env) {
  const checks: Check[] = [];
  const check = (id: string, status: Check["status"], message: string) => { checks.push({ id, status, message }); };
  const providers = new Set(["default"]);
  try { new RouterClient(env); check("default-endpoint", "ok", "Configuração do endpoint padrão válida; inferência não testada."); }
  catch { check("default-endpoint", "error", "Endpoint ou timeout padrão inválido; revise a configuração privada."); }
  if (env.MULTIAGENTS_PROVIDERS_CONFIG) {
    try {
      const config = providerConfigSchema.parse(parse(await readFile(env.MULTIAGENTS_PROVIDERS_CONFIG, "utf8")));
      for (const [id, profile] of Object.entries(config.providers)) {
        providers.add(id);
        try { new RouterClient({ ...env, MULTIAGENTS_BASE_URL: profile.base_url, MULTIAGENTS_API_KEY: "" }); }
        catch { check(`endpoint:${id}`, "error", "Endpoint do perfil inválido; revise a configuração privada."); }
        check(`credential:${id}`, profile.api_key_env && !env[profile.api_key_env] ? "error" : "ok", profile.api_key_env && !env[profile.api_key_env] ? "Credencial de inferência ausente no ambiente." : "Perfil de inferência configurado; credencial e acesso remoto não testados.");
        if (profile.management) check(`management:${id}`, env[profile.management.api_key_env] ? "ok" : "error", env[profile.management.api_key_env] ? "Credencial administrativa configurada; permissões remotas não testadas." : "Credencial administrativa ausente no ambiente.");
        if (profile.limits) check(`limits:${id}`, "ok", "Limites compartilhados configurados; estado não modificado por este diagnóstico.");
      }
      check("providers", "ok", "Schema de provedores válido.");
    } catch { check("providers", "error", "Arquivo de provedores inacessível ou incompatível com o schema; revise-o localmente."); }
  } else check("providers", "ok", "Usando somente o perfil padrão do ambiente.");
  try {
    const agents = await loadAgents(env.AGENTS_CONFIG ?? defaultAgentsPath);
    if (env.TECHNICAL_AGENTS_CONFIG) agents.push(...await loadAgents(env.TECHNICAL_AGENTS_CONFIG));
    if (new Set(agents.map(agent => agent.id)).size !== agents.length) throw new Error("IDs duplicados");
    check("agents", agents.length ? "ok" : "warning", agents.length ? "Schema e identificadores de agentes válidos." : "Nenhum agente configurado.");
    for (const agent of agents) {
      if (!providers.has(agent.provider ?? "default")) check(`agent-provider:${agent.id}`, "error", "O provedor referenciado pelo agente não está configurado.");
      if (/^(your-|model-id-)/i.test(agent.route)) check(`agent-route:${agent.id}`, "warning", "Substitua o modelo de exemplo por um ID do seu backend.");
    }
  } catch { check("agents", "error", "Configuração de agentes inacessível, inválida ou com IDs duplicados."); }
  const jobs = env.MULTIAGENTS_JOBS_DIR ?? env.NINEROUTER_JOBS_DIR ?? "./.jobs";
  for (const [label, path] of Object.entries({ jobs,
    workflows: env.MULTIAGENTS_WORKFLOWS_DIR ?? env.NINEROUTER_WORKFLOWS_DIR ?? resolve(dirname(jobs), ".workflows"),
    combos: env.MULTIAGENTS_COMBOS_DIR ?? resolve(dirname(jobs), ".combos"),
    budgets: env.MULTIAGENTS_BUDGETS_DIR ?? resolve(dirname(jobs), ".budgets") })) {
    if (!isAbsolute(path)) check(`location:${label}`, "warning", "Diretório relativo depende da pasta de inicialização do cliente; prefira caminho absoluto privado.");
    try {
      const info = await lstat(path);
      await access(path, constants.R_OK | constants.W_OK);
      check(`state:${label}`, !info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077)) ? "error" : "ok", !info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077)) ? "Estado exige diretório privado, regular e acessível; revise permissões localmente." : "Diretório acessível; nenhum arquivo foi alterado.");
    } catch { check(`state:${label}`, "warning", "Diretório ausente ou inacessível; o diagnóstico não o criou."); }
  }
  if (process.platform !== "linux") check("platform", "warning", "Plataforma nativa não validada integralmente; validação POSIX não comprova ACL do Windows. Use Linux/WSL para estado privado confirmado.");
  check("runtime", "ok", "Este relatório identifica o processo atual; recarregue a conexão MCP após trocar o runtime.");
  return { version: serverVersion, runtime: { node: process.version, platform: process.platform }, checks, network: false as const, inference: false as const };
}
