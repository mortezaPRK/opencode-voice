// OpenAI-compatible LLM client for text normalization, plus backend selection.
//
// Works with any OpenAI-compatible endpoint (Anthropic compat layer, OpenAI,
// Ollama, vLLM, LM Studio, etc.). Configuration is passed from plugin options.
// When `llm.type` is "opencode", generation is delegated to the host's
// `generate.text` API instead of calling an endpoint directly.
import type {
  Complete,
  CompletionRequest,
  CompletionResult,
  Logger,
  PluginOptions,
} from "../types.js";
import {
  resolveLLMConfig,
  type LLMBackend,
  type ResolvedOpenAICompatibleOptions,
} from "./llm-config.js";
import { createOpenCodeClient, type GenerateText } from "./opencode-llm-client.js";

export interface CompletionClient {
  backend: LLMBackend;
  complete: Complete;
  /** Configuration error reported by `complete` on every call. */
  error?: string;
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createErrorClient(error: string, logger?: Logger): { complete: Complete } {
  let logged = false;
  return {
    complete: async () => {
      if (!logged) {
        logger?.log("LLM", `Invalid configuration: ${error}`, "warn");
        logged = true;
      }
      return { text: null, error };
    },
  };
}

/**
 * Create an LLM completion function for an OpenAI-compatible endpoint.
 */
export function createOpenAICompatibleClient(
  cfg: ResolvedOpenAICompatibleOptions,
  logger?: Logger,
): { complete: Complete } {
  async function complete({
    system,
    prompt,
    config: overrides,
  }: CompletionRequest): Promise<CompletionResult> {
    if (!cfg.endpoint) {
      logger?.log("LLM", "completion skipped: endpoint not configured", "warn");
      return { text: null, error: "LLM endpoint not configured" };
    }
    if (!cfg.model) {
      logger?.log("LLM", "completion skipped: model not configured", "warn");
      return { text: null, error: "LLM model not configured" };
    }
    const maxTokens = overrides?.maxTokens ?? cfg.maxTokens;
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;

    const endpoint = cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";

    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: maxTokens,
      messages,
    };
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
    if (cfg.chatTemplateKwargs) body.chat_template_kwargs = cfg.chatTemplateKwargs;

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        logger?.log(
          "LLM",
          `Completion request attempt=${attempt + 1} model=${cfg.model} maxTokens=${maxTokens} promptChars=${prompt.length}`,
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

/**
 * Create the configured completion client.
 *
 * `generate` is required only for the "opencode" backend; it is supplied by the
 * plugin from the host context so this module stays independent of OpenCode APIs.
 */
export function createClient(
  pluginOptions: PluginOptions | undefined,
  logger?: Logger,
  generate?: GenerateText,
): CompletionClient {
  const resolved = resolveLLMConfig(pluginOptions);
  for (const warning of resolved.warnings) logger?.log("LLM", warning, "warn");

  if (resolved.error) {
    return {
      backend: resolved.backend,
      complete: createErrorClient(resolved.error, logger).complete,
      error: resolved.error,
    };
  }

  if (resolved.backend === "opencode") {
    if (!generate) {
      const error = "OpenCode LLM backend requires the OpenCode client";
      return {
        backend: "opencode",
        complete: createErrorClient(error, logger).complete,
        error,
      };
    }
    return {
      backend: "opencode",
      ...createOpenCodeClient(generate, resolved.opencode, logger),
    };
  }

  return {
    backend: "openai-compatible",
    ...createOpenAICompatibleClient(resolved.openai, logger),
  };
}
