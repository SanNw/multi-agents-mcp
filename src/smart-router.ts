import { dirname, resolve } from "node:path";
import { defaultAgentsPath, loadAgents } from "./agents.js";

export const technicalIds = ["naruto", "sasuke", "sakura"] as const;
export type TaskSignals = {
  task: string; context?: string; agent?: string;
  kind?: "development" | "architecture" | "documentation" | "translation" | "philology";
  complexity?: "low" | "medium" | "high";
  language?: string; file_count?: number; needs_tools?: boolean; security_sensitive?: boolean;
};

export async function loadConfiguredAgents() {
  const original = process.env.AGENTS_CONFIG ?? defaultAgentsPath;
  const technical = process.env.TECHNICAL_AGENTS_CONFIG ?? resolve(dirname(original), "technical-agents.yaml");
  const agents = [...await loadAgents(original), ...await loadAgents(technical)];
  if (new Set(agents.map(a => a.id)).size !== agents.length) throw new Error("Identificadores de agentes duplicados");
  return agents;
}

export function classifyTask(input: TaskSignals, agentIds: string[] = [...technicalIds, "translator_a", "translator_b", "philologist", "translation_critic", "portuguese_editor"]) {
  const prefix = input.task.match(/^\s*@(naruto|sasuke|sakura)\b\s*/i);
  const explicit = input.agent?.toLowerCase();
  if (explicit && !agentIds.includes(explicit)) throw new Error("Agente desconhecido");
  if (prefix && explicit && prefix[1]!.toLowerCase() !== explicit) throw new Error("Seleção manual conflitante");
  const task = prefix ? input.task.slice(prefix[0].length) : input.task;
  if (!task.trim()) throw new Error("Tarefa vazia");
  const manual = Boolean(explicit || prefix);
  const text = task.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const translation = input.kind === "translation" || /\b(traduz\w*|traducao|translate)\b/.test(text);
  const philology = input.kind === "philology" || /\b(filolog\w*|morfologia)\b/.test(text);
  const development = input.kind === "development" || /\b(implemente|implementar|corrija|refatore|componente|backend|api|oauth2|react|python|typescript)\b/.test(text);
  const architecture = input.kind === "architecture" || /\b(arquitetura|estruturais|desempenho|seguranca|integracao|oauth2)\b/.test(text);
  const documentation = input.kind === "documentation" || /\b(documentacao|documente|docstrings?|resuma|explique)\b/.test(text);
  const reasons: string[] = [];
  let score = input.complexity === "high" ? 4 : input.complexity === "medium" ? 1 : 0;
  if ((input.file_count ?? 0) > 5) { score += 2; reasons.push("mais de cinco arquivos"); }
  if ((input.context?.length ?? 0) > 24000) { score += 2; reasons.push("contexto extenso"); }
  if (input.security_sensitive) { score += 3; reasons.push("impacto de segurança informado"); }
  if (input.needs_tools && input.language) { score += 1; reasons.push("ferramentas e linguagem informadas"); }
  if (architecture) { score += 3; reasons.push("arquitetura ou integração crítica"); }
  const mixed = (translation || philology) && development;
  const agent = explicit ?? prefix?.[1]?.toLowerCase() ?? (philology ? "philologist" : translation ? "translator_a" : score >= 3 ? "sasuke" : documentation ? "sakura" : "naruto");
  if (manual) reasons.unshift("seleção explícita do usuário");
  else reasons.unshift(philology || translation ? "fluxo editorial existente" : documentation && score < 3 ? "tarefa auxiliar" : "tipo e complexidade da tarefa");
  return {
    agent, task, manual, reasons, complexity_score: score,
    needs_clarification: mixed && !manual && !input.kind,
    classification: "deterministic" as const,
    suggested_flow: manual || translation || philology || score < 3 ? [agent] : ["sasuke", "naruto", "sasuke"],
    execution: "Codex aplica alterações e executa ferramentas; o MCP produz propostas e análises",
  };
}

export function prioritizeRoutes(routes: string[], history: unknown[]) {
  const attempts = history.filter((value): value is { route: string; status: string } =>
    Boolean(value && typeof value === "object" && "route" in value && typeof value.route === "string" && "status" in value && typeof value.status === "string"));
  const recent = (route: string) => attempts.filter(attempt => attempt.route === route).slice(0, 10);
  const primary = routes[0];
  if (!primary || recent(primary).filter(attempt => attempt.status === "error").length < 2 || recent(primary).some(attempt => attempt.status === "success")) return routes;
  const proven = routes.find(route => recent(route).some(attempt => attempt.status === "success"));
  return proven && proven !== primary ? [proven, ...routes.filter(route => route !== proven)] : routes;
}
