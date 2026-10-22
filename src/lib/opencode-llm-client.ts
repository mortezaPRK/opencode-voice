// OpenCode-backed text generation for normalization.
//
// Uses the host's `generate.text` API, so the configured OpenCode provider and
// its credentials are reused. No session, tools, or history are involved.
// The OpenCode API accepts a single prompt, so the system prompt is joined to
// the user prompt before the call.

import type { Complete, CompletionRequest, CompletionResult, Logger } from "../types.js";
import type { ResolvedOpenCodeOptions } from "./llm-config.js";

export interface GenerateTextRequest {
  prompt: string;
  model?: { providerID: string; id: string; variant?: string } | null;
  signal?: AbortSignal;
}

export type GenerateText = (request: GenerateTextRequest) => Promise<{ text: string }>;

export function buildLLMPrompt(request: { system?: string; prompt: string }): string {
  return request.system ? `${request.system}\n\n---\n\n${request.prompt}` : request.prompt;
}

function errorName(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name?: unknown }).name)
    : undefined;
}

/**
 * Create a completion function backed by OpenCode's `generate.text`.
 */
export function createOpenCodeClient(
  generate: GenerateText,
  options: ResolvedOpenCodeOptions,
  logger?: Logger,
): { complete: Complete } {
  const { model, timeoutMs } = options;

  async function complete({
    system,
    prompt,
    config,
  }: CompletionRequest): Promise<CompletionResult> {
    if (config?.maxTokens !== undefined) {
      logger?.log(
        "LLM",
        "maxTokens is ignored by the opencode backend; configure limits on the OpenCode model",
        "debug",
      );
    }

    const signal = AbortSignal.timeout(timeoutMs);
    logger?.log(
      "LLM",
      `Completion request backend=opencode model=${model?.id ?? "default"} promptChars=${prompt.length}`,
      "debug",
    );

    try {
      const result = await generate({
        prompt: buildLLMPrompt({ system, prompt }),
        model: model ?? null,
        signal,
      });
      const text = result?.text?.trim();
      if (!text) {
        logger?.log("LLM", "Completion returned empty content", "warn");
        return { text: null, error: "Empty LLM response" };
      }
      logger?.log("LLM", `Completion succeeded chars=${text.length}`, "debug");
      return { text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const name = errorName(err);
      logger?.log(
        "LLM",
        `Completion error backend=opencode name=${name ?? "unknown"} message=${message}`,
        "warn",
      );
      if (name === "TimeoutError" || name === "AbortError") {
        return { text: null, error: `LLM request timed out (${timeoutMs}ms)` };
      }
      return { text: null, error: `LLM error: ${message}` };
    }
  }

  return { complete };
}
