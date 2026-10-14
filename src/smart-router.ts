import { loadAgents, type Agent } from "./agents.js";

export type TaskSignals = {
  task: string; context?: string; agent?: string;
  kind?: "development" | "architecture" | "documentation" | "translation" | "philology";
  complexity?: "low" | "medium" | "high";
  language?: string; file_count?: number; needs_tools?: boolean; security_sensitive?: boolean;
};

export async function loadConfiguredAgents() {
  const agents = await loadAgents();
  if (process.env.TECHNICAL_AGENTS_CONFIG) agents.push(...await loadAgents(process.env.TECHNICAL_AGENTS_CONFIG));
  if (new Set(agents.map(a => a.id)).size !== agents.length) throw new Error("Identificadores de agentes duplicados");
  return agents;
}

export function classifyTask(input: TaskSignals, agents: Pick<Agent, "id" | "role" | "task_kinds">[]) {
  if (!agents.length) throw new Error("Nenhum agente configurado; configure AGENTS_CONFIG");
  const agentIds = agents.map(agent => agent.id);
  const prefix = input.task.match(/^\s*@([\w-]+)\b\s*/);
  const explicit = input.agent;
  if (prefix && !agentIds.includes(prefix[1]!)) throw new Error("Agente desconhecido");
  if (explicit && !agentIds.includes(explicit)) throw new Error("Agente desconhecido");
  if (prefix && explicit && prefix[1] !== explicit) throw new Error("Seleção manual conflitante");
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
  const kind = input.kind ?? (philology ? "philology" : translation ? "translation" : score >= 3 ? "architecture" : documentation ? "documentation" : "development");
  const roleKinds: Record<string, string> = { software_development: "development", architecture_and_review: "architecture", technical_assistance: "documentation", independent_translation: "translation", philological_analysis: "philology" };
  const select = (kind: string) => agents.find(candidate => candidate.task_kinds?.includes(kind as NonNullable<TaskSignals["kind"]>) || roleKinds[candidate.role] === kind)?.id;
  const agent = explicit ?? prefix?.[1] ?? select(kind) ?? agents[0]!.id;
  const reviewer = select("architecture");
  const developer = select("development");
  if (manual) reasons.unshift("seleção explícita do usuário");
  else reasons.unshift(philology || translation ? "fluxo editorial existente" : documentation && score < 3 ? "tarefa auxiliar" : "tipo e complexidade da tarefa");
  return {
    agent, task, manual, reasons, complexity_score: score,
    needs_clarification: mixed && !manual && !input.kind,
    classification: "deterministic" as const,
    suggested_flow: manual || translation || philology || score < 3 || !reviewer || !developer ? [agent] : [reviewer, developer, reviewer],
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
