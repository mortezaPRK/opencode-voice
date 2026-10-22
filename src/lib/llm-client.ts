// OpenAI-compatible LLM client for text normalization.
//
// Works with any OpenAI-compatible endpoint (Anthropic compat layer, OpenAI,
// Ollama, vLLM, LM Studio, etc.). Configuration is passed from plugin options.
import type {
  Complete,
  CompletionRequest,
  CompletionResult,
  Logger,
  PluginOptions,
} from "../types.js";

interface ResolvedConfig {
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
  maxTokens: number;
  reasoningEffort: string | null;
  chatTemplateKwargs: Record<string, unknown> | null;
  retries: number;
}

const DEFAULTS: ResolvedConfig = {
  maxTokens: 2048,
  reasoningEffort: null,
  chatTemplateKwargs: null,
  retries: 2,
};

function normalizeRetries(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS.retries;
  return Math.floor(parsed);
}

function normalizeChatTemplateKwargs(
  value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an LLM completion function.
 */
export function createClient(
  pluginOptions: PluginOptions | undefined,
  logger?: Logger,
): { complete: Complete } {
  function getConfig(): ResolvedConfig {
    return {
      endpoint: pluginOptions?.endpoint,
      model: pluginOptions?.model,
      apiKeyEnv: pluginOptions?.apiKeyEnv,
      maxTokens: pluginOptions?.maxTokens ?? DEFAULTS.maxTokens,
      reasoningEffort: pluginOptions?.reasoningEffort ?? DEFAULTS.reasoningEffort,
      chatTemplateKwargs: normalizeChatTemplateKwargs(
        pluginOptions?.chatTemplateKwargs ?? DEFAULTS.chatTemplateKwargs,
      ),
      retries: normalizeRetries(pluginOptions?.retries ?? DEFAULTS.retries),
    };
  }

  async function complete({
    system,
    prompt,
    config: overrides,
  }: CompletionRequest): Promise<CompletionResult> {
    const base = getConfig();
    const cfg: ResolvedConfig = {
      ...base,
      maxTokens: overrides?.maxTokens ?? base.maxTokens,
    };
    if (!cfg.endpoint) {
      logger?.log("LLM", "completion skipped: endpoint not configured", "warn");
      return { text: null, error: "LLM endpoint not configured" };
    }
    if (!cfg.model) {
      logger?.log("LLM", "completion skipped: model not configured", "warn");
      return { text: null, error: "LLM model not configured" };
    }
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;

    const endpoint = cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";

    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages,
    };
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
    if (cfg.chatTemplateKwargs) body.chat_template_kwargs = cfg.chatTemplateKwargs;

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        logger?.log(
          "LLM",
          `Completion request attempt=${attempt + 1} model=${cfg.model} maxTokens=${cfg.maxTokens} promptChars=${prompt.length}`,
          "debug",
        );
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          logger?.log(
            "LLM",
            `Completion response status=${response.status}`,
            shouldRetry(response.status) ? "warn" : "error",
          );
          if (attempt < cfg.retries && shouldRetry(response.status)) {
            await wait(250 * 2 ** attempt);
            continue;
          }
          return { text: null, error: `LLM request failed (${response.status})` };
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data?.choices?.[0]?.message?.content || null;
        if (text) {
          logger?.log("LLM", `Completion succeeded chars=${text.length}`, "debug");
          return { text };
        }

        logger?.log("LLM", "Completion returned empty content", "warn");

        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: "Empty LLM response" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.log("LLM", `Completion error attempt=${attempt + 1}: ${message}`, "warn");
        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: `LLM error: ${message}` };
      }
    }

    return { text: null, error: "LLM request failed after retries" };
  }

  return { complete };
}
