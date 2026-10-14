import { createHash, randomUUID } from "node:crypto";
import type { Agent } from "./agents.js";
import { RouterError } from "./errors.js";

type Model = { id: string; owned_by?: string };
type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type Completion = {
  model?: string;
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string }; finish_reason?: string }>;
  usage?: Usage;
  error?: { message?: string; code?: string | number };
};
type CompletionResult = { content: string; model?: string; finishReason?: string; usage?: Usage };

export type AttemptTelemetry = {
  attempt: number;
  started_at: string;
  elapsed_ms: number;
  status: "success" | "degraded" | "error";
  route: string;
  effective_model?: string | null;
  finish_reason?: string | null;
  quality_issues?: string[];
  code?: string;
  retryable?: boolean;
};

export type DelegateOptions = {
  timeoutMs?: number;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputTokens?: number;
  retries?: number;
  expectedIds?: string[];
  expectedText?: string;
  minOutputChars?: number;
  stream?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: { delta: string; content: string }) => void | Promise<void>;
};

export type QualityIssue = {
  code: "FINISH_REASON_LENGTH" | "FINISH_REASON_MISSING" | "USAGE_MISSING" | "EXPECTED_TEXT_MISMATCH" | "EXPECTED_IDS_MISMATCH" | "OUTPUT_TOO_SHORT" | "REASONING_LEAK";
  message: string;
};

export type DelegateQuality = {
  status: "ok" | "degraded";
  issues: QualityIssue[];
  context_chars: number;
  context_bytes: number;
  context_sha256: string;
  output_chars: number;
  expected_ids?: string[];
  present_ids?: string[];
  missing_ids?: string[];
  unexpected_ids?: string[];
};

export type DelegateResult = {
  agent: string;
  requested_route: string;
  effective_model: string | null;
  request_id: string;
  status: "success" | "degraded";
  content: string;
  selected_route: string;
  finish_reason: string | null;
  elapsed_ms: number;
  attempts: AttemptTelemetry[];
  quality: DelegateQuality;
  usage: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };
};

export class RouterClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly circuitBreakerMs: number;
  private readonly routeCursor = new Map<string, number>();
  private readonly circuits = new Map<string, number>();

  constructor(env = process.env) {
    const url = new URL(env.MULTIAGENTS_BASE_URL ?? env.NINEROUTER_URL ?? "http://127.0.0.1:20128");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Endpoint deve ser HTTP(S), sem credenciais, query ou fragmento na URL");
    this.baseUrl = url.href.replace(/\/$/, "").replace(/\/v1$/, "");
    this.apiKey = env.MULTIAGENTS_API_KEY ?? (env.MULTIAGENTS_BASE_URL ? "" : env.NINEROUTER_KEY ?? "");
    this.timeoutMs = Number(env.MULTIAGENTS_TIMEOUT_MS ?? env.NINEROUTER_TIMEOUT_MS ?? 600_000);
    this.circuitBreakerMs = Number(env.MULTIAGENTS_CIRCUIT_BREAKER_MS ?? env.NINEROUTER_CIRCUIT_BREAKER_MS ?? 60_000);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || !Number.isFinite(this.circuitBreakerMs) || this.circuitBreakerMs < 0) throw new Error("Timeout ou circuit breaker inválido");
  }

  async models(): Promise<Model[]> {
    const response = await this.fetchResponse("/v1/models", undefined, {
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
      phase: "connect",
    });
    const body = await this.readJson<{ data?: Model[] }>(response);
    return body.data ?? [];
  }

  async delegate(
    agent: Agent,
    task: string,
    context?: string,
    instructions?: string,
    outputFormat?: string,
    options: DelegateOptions = {},
  ): Promise<DelegateResult> {
    const requestId = randomUUID();
    const started = Date.now();
    const attempts: AttemptTelemetry[] = [];
    const timeoutMs = options.timeoutMs ?? agent.timeout_ms ?? this.timeoutMs;
    const retries = options.retries ?? agent.retries ?? 2;
    const routes = [...new Set([agent.route, ...agent.fallback_routes])];
    const cursor = agent.route_strategy === "round_robin" ? this.routeCursor.get(agent.id) ?? 0 : 0;
    if (agent.route_strategy === "round_robin") this.routeCursor.set(agent.id, (cursor + 1) % routes.length);
    const commonBody = {
      messages: [
        { role: "system", content: `${agent.description}\nAtue apenas no papel ${agent.role}. Não substitua a decisão final do Codex.` },
        { role: "user", content: buildUserMessage(task, context, instructions, outputFormat) },
      ],
      temperature: agent.temperature,
      max_tokens: options.maxOutputTokens ?? agent.max_output_tokens,
      stream: options.stream ?? false,
    };
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(new Error("overall timeout")), timeoutMs);
    const signal = combineSignals([overall.signal, options.signal]);
    const attemptedRoutes = new Set<string>();
    let bestDegraded: DelegateResult | undefined;

    try {
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        const attemptStarted = Date.now();
        const route = this.selectRoute(routes, cursor + attempt - 1, attemptedRoutes);
        attemptedRoutes.add(route);
        const body = { ...commonBody, model: route };
        try {
          const result = body.stream
            ? await this.streamCompletion(body, signal, agent, options, requestId)
            : await this.jsonCompletion(body, signal, agent, options, requestId);
          const quality = assessQuality(result, context, options);
          if (quality.issues.some(({ code }) => ["REASONING_LEAK", "FINISH_REASON_MISSING", "USAGE_MISSING"].includes(code))) {
            this.circuits.set(route, Date.now() + this.circuitBreakerMs);
          }
          const status = quality.status === "ok" ? "success" : "degraded";
          attempts.push({
            attempt, route, effective_model: result.model ?? null, finish_reason: result.finishReason ?? null,
            started_at: new Date(attemptStarted).toISOString(), elapsed_ms: Date.now() - attemptStarted,
            status, quality_issues: quality.issues.map(({ code }) => code),
          });
          const delegated: DelegateResult = {
            agent: agent.id,
            requested_route: agent.route,
            selected_route: route,
            effective_model: result.model ?? null,
            request_id: requestId,
            status,
            content: result.content,
            finish_reason: result.finishReason ?? null,
            elapsed_ms: Date.now() - started,
            attempts,
            quality,
            usage: normalizeUsage(result.usage),
          };
          if (status === "degraded" && attempt <= retries) {
            bestDegraded = delegated;
            continue;
          }
          return delegated;
        } catch (error) {
          const normalized = normalizeError(error, requestId);
          if (opensCircuit(normalized)) this.circuits.set(route, Date.now() + this.circuitBreakerMs);
          attempts.push({
            attempt, route,
            started_at: new Date(attemptStarted).toISOString(),
            elapsed_ms: Date.now() - attemptStarted,
            status: "error",
            code: normalized.code,
            retryable: normalized.retryable,
          });
          if (!normalized.retryable || attempt > retries || signal.aborted) {
            if (bestDegraded && !signal.aborted) return bestDegraded;
            Object.assign(normalized, { attempts });
            throw normalized;
          }
          await delay(normalized.retryAfterMs ?? retryDelay(attempt), signal);
        }
      }
      throw new RouterError("Tentativas esgotadas", { code: "RETRIES_EXHAUSTED", requestId });
    } finally {
      clearTimeout(overallTimer);
    }
  }

  private selectRoute(routes: string[], offset: number, attempted: Set<string>) {
    const now = Date.now();
    for (let step = 0; step < routes.length; step += 1) {
      const route = routes[(offset + step) % routes.length]!;
      const blockedUntil = this.circuits.get(route) ?? 0;
      if (blockedUntil <= now && !attempted.has(route)) {
        if (blockedUntil) this.circuits.delete(route);
        return route;
      }
    }
    const available = routes.find((route) => (this.circuits.get(route) ?? 0) <= now);
    if (!available) throw new RouterError("Todas as rotas estão com circuito aberto", { code: "CIRCUIT_OPEN", retryable: false });
    return available;
  }

  private async jsonCompletion(
    body: Record<string, unknown>, signal: AbortSignal, agent: Agent,
    options: DelegateOptions, requestId: string,
  ): Promise<CompletionResult> {
    const response = await this.fetchResponse("/v1/chat/completions", { method: "POST", body: JSON.stringify(body) }, {
      signal,
      firstByteTimeoutMs: options.firstByteTimeoutMs ?? agent.first_byte_timeout_ms,
      phase: "first_byte",
      requestId,
    });
    const completion = await this.readJson<Completion>(response, requestId);
    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new RouterError("Backend retornou uma resposta sem conteúdo", { code: "EMPTY_COMPLETION", phase: "decode", requestId });
    return { content, model: completion.model, finishReason: completion.choices?.[0]?.finish_reason, usage: completion.usage };
  }

  private async streamCompletion(
    body: Record<string, unknown>, signal: AbortSignal, agent: Agent,
    options: DelegateOptions, requestId: string,
  ): Promise<CompletionResult> {
    const response = await this.fetchResponse("/v1/chat/completions", { method: "POST", body: JSON.stringify(body) }, {
      signal,
      firstByteTimeoutMs: options.firstByteTimeoutMs ?? agent.first_byte_timeout_ms,
      phase: "first_byte",
      requestId,
    });
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const completion = await this.readJson<Completion>(response, requestId);
      const content = completion.choices?.[0]?.message?.content;
      if (!content) throw new RouterError("Resposta sem conteúdo", { code: "EMPTY_COMPLETION", phase: "decode", requestId });
      await options.onProgress?.({ delta: content, content });
      return { content, model: completion.model, finishReason: completion.choices?.[0]?.finish_reason, usage: completion.usage };
    }
    if (!response.body) throw new RouterError("Stream sem corpo", { code: "EMPTY_STREAM", phase: "generation", requestId });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let model: string | undefined;
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let receivedContent = false;
    const idleMs = options.idleTimeoutMs ?? agent.idle_timeout_ms;
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const { done, value } = await readWithTimeout(reader, idleMs, requestId);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          for (const line of event.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let chunk: Completion;
            try { chunk = JSON.parse(data) as Completion; }
            catch (error) { throw new RouterError("Evento SSE inválido", { code: "INVALID_STREAM_JSON", phase: "decode", requestId, cause: error }); }
            model = chunk.model ?? model;
            usage = chunk.usage ?? usage;
            finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              receivedContent = true;
              content += delta;
              await options.onProgress?.({ delta, content });
            }
          }
        }
      }
    } catch (error) {
      if (receivedContent) throw new RouterError("Stream interrompido após conteúdo parcial", { code: "STREAM_INTERRUPTED", phase: "generation", retryable: false, requestId, cause: error });
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!content) throw new RouterError("Stream concluído sem conteúdo", { code: "EMPTY_COMPLETION", phase: "generation", requestId });
    return { content, model, finishReason, usage };
  }

  private async fetchResponse(
    path: string, init: RequestInit | undefined,
    options: { signal: AbortSignal; firstByteTimeoutMs?: number; phase: "connect" | "first_byte"; requestId?: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const signal = combineSignals([controller.signal, options.signal]);
    const timer = options.firstByteTimeoutMs ? setTimeout(() => controller.abort(new Error("first byte timeout")), options.firstByteTimeoutMs) : undefined;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
        signal,
      });
      if (!response.ok) throw await httpError(response, options.requestId);
      return response;
    } catch (error) {
      throw normalizeFetchError(error, options.phase, options.requestId);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async readJson<T>(response: Response, requestId?: string): Promise<T> {
    const raw = await response.text();
    try {
      const body = JSON.parse(raw) as T & { error?: { message?: string; code?: string | number } };
      if (body.error) throw new RouterError(body.error.message ?? "Backend retornou erro", { code: String(body.error.code ?? "UPSTREAM_ERROR"), phase: "decode", requestId });
      return body;
    } catch (error) {
      if (error instanceof RouterError) throw error;
      throw new RouterError("Resposta JSON inválida", { code: "INVALID_JSON", phase: "decode", requestId, cause: error });
    }
  }
}

function buildUserMessage(task: string, context?: string, instructions?: string, outputFormat?: string) {
  return [`TAREFA\n${task}`, context && `CONTEXTO\n${context}`, instructions && `INSTRUÇÕES ADICIONAIS\n${instructions}`, outputFormat && `FORMATO DE SAÍDA\n${outputFormat}`].filter(Boolean).join("\n\n");
}

async function httpError(response: Response, requestId?: string) {
  const raw = await response.text();
  let message = raw.slice(0, 500) || `Backend respondeu HTTP ${response.status}`;
  try { message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? message; } catch { /* keep safe excerpt */ }
  const retryAfter = response.headers.get("retry-after");
  const transientMessage = /model is unavailable|upstream request failed|overload|temporar(?:y|ily)|try again/i.test(message);
  return new RouterError(`Backend respondeu HTTP ${response.status}`, {
    code: `HTTP_${response.status}`,
    phase: "connect",
    retryable: ![401, 403].includes(response.status) && (transientMessage || [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)),
    status: response.status,
    retryAfterMs: retryAfter ? parseRetryAfter(retryAfter) : undefined,
    requestId,
  });
}

function normalizeFetchError(error: unknown, phase: "connect" | "first_byte", requestId?: string) {
  if (error instanceof RouterError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const aborted = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) || /timeout|aborted/i.test(message);
  return new RouterError(message || "Falha de rede", { code: aborted ? (phase === "first_byte" ? "FIRST_BYTE_TIMEOUT" : "REQUEST_TIMEOUT") : "NETWORK_ERROR", phase, retryable: true, requestId, cause: error });
}

function normalizeError(error: unknown, requestId: string) {
  return error instanceof RouterError ? error : new RouterError(error instanceof Error ? error.message : String(error), { code: "UNEXPECTED_ERROR", requestId, cause: error });
}

function opensCircuit(error: RouterError) {
  return error.retryable && (/^HTTP_(400|408|425|429|5\d\d)$/.test(error.code) || ["NETWORK_ERROR", "FIRST_BYTE_TIMEOUT", "REQUEST_TIMEOUT", "EMPTY_COMPLETION"].includes(error.code));
}

function assessQuality(result: CompletionResult, context: string | undefined, options: DelegateOptions): DelegateQuality {
  const issues: QualityIssue[] = [];
  const content = result.content;
  const usage = normalizeUsage(result.usage);
  if (result.finishReason === "length") issues.push({ code: "FINISH_REASON_LENGTH", message: "A resposta atingiu o limite de saída e pode estar incompleta." });
  if (!result.finishReason) issues.push({ code: "FINISH_REASON_MISSING", message: "O provedor não informou a razão de término." });
  if (!usage.total_tokens && !result.finishReason) issues.push({ code: "USAGE_MISSING", message: "O provedor retornou uso zerado junto de término desconhecido." });
  if (options.expectedText !== undefined && content.trim() !== options.expectedText.trim()) {
    issues.push({ code: "EXPECTED_TEXT_MISMATCH", message: "A resposta não corresponde ao texto de controle esperado." });
  }
  if (options.minOutputChars !== undefined && content.length < options.minOutputChars) {
    issues.push({ code: "OUTPUT_TOO_SHORT", message: `A resposta tem ${content.length} caracteres; mínimo esperado: ${options.minOutputChars}.` });
  }
  if (/^\s*(?:<think>|here(?:'|’)s (?:a |the )?(?:thinking|analysis)|thinking process|we need (?:to )?(?:answer|analy[sz]e))/i.test(content)) {
    issues.push({ code: "REASONING_LEAK", message: "A resposta começou com raciocínio interno não solicitado." });
  }
  let presentIds: string[] | undefined;
  let missingIds: string[] | undefined;
  let unexpectedIds: string[] | undefined;
  if (options.expectedIds) {
    presentIds = [...content.matchAll(/^## (S\d{4})\s*$/gm)].map((match) => match[1]!);
    missingIds = options.expectedIds.filter((id) => !presentIds!.includes(id));
    unexpectedIds = presentIds.filter((id) => !options.expectedIds!.includes(id));
    const wrongOrder = presentIds.some((id, index) => id !== options.expectedIds![index]);
    if (missingIds.length || unexpectedIds.length || presentIds.length !== options.expectedIds.length || wrongOrder) {
      issues.push({
        code: "EXPECTED_IDS_MISMATCH",
        message: `Cobertura de IDs divergente: ${missingIds.length} ausentes, ${unexpectedIds.length} inesperados, ${presentIds.length}/${options.expectedIds.length} encontrados${wrongOrder ? ", ordem divergente" : ""}.`,
      });
    }
  }
  const source = context ?? "";
  return {
    status: issues.length ? "degraded" : "ok", issues,
    context_chars: source.length,
    context_bytes: Buffer.byteLength(source, "utf8"),
    context_sha256: createHash("sha256").update(source).digest("hex"),
    output_chars: content.length,
    ...(options.expectedIds ? { expected_ids: options.expectedIds, present_ids: presentIds, missing_ids: missingIds, unexpected_ids: unexpectedIds } : {}),
  };
}

function combineSignals(signals: Array<AbortSignal | undefined>) {
  const valid = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (valid.length === 1) return valid[0];
  const controller = new AbortController();
  for (const signal of valid) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function parseRetryAfter(value: string) {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryDelay(attempt: number) { return Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250); }
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, requestId: string) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RouterError("Stream sem dados dentro do prazo", {
        code: "STREAM_IDLE_TIMEOUT", phase: "generation", retryable: true, requestId,
      })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer!));
}
function normalizeUsage(usage?: Usage) {
  return { input_tokens: usage?.prompt_tokens ?? null, output_tokens: usage?.completion_tokens ?? null, total_tokens: usage?.total_tokens ?? null };
}
