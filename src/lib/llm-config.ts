// Resolves plugin options into one concrete LLM backend configuration.
//
// Two backends are supported:
// - "opencode": uses OpenCode's configured providers, credentials, and models.
// - "openai-compatible": calls a `/chat/completions` endpoint directly.
//
// Explicit `llm` options win over the legacy top-level endpoint fields, which
// remain supported so existing configurations keep working.

import type { OpenCodeModelRef, PluginOptions } from "../types.js";

export type LLMBackend = "opencode" | "openai-compatible";

export interface ResolvedOpenAICompatibleOptions {
  endpoint: string | undefined;
  model: string | undefined;
  apiKeyEnv: string | undefined;
  maxTokens: number;
  reasoningEffort: string | null;
  chatTemplateKwargs: Record<string, unknown> | null;
  retries: number;
}

export interface ResolvedOpenCodeOptions {
  model: OpenCodeModelRef | undefined;
  timeoutMs: number;
}

export interface ResolvedLLMConfig {
  backend: LLMBackend;
  opencode: ResolvedOpenCodeOptions;
  openai: ResolvedOpenAICompatibleOptions;
  error: string | undefined;
  warnings: string[];
}

export const DEFAULT_OPENCODE_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_RETRIES = 2;

const OPENAI_COMPATIBLE_KEYS = [
  "type",
  "endpoint",
  "model",
  "apiKeyEnv",
  "maxTokens",
  "reasoningEffort",
  "chatTemplateKwargs",
  "retries",
] as const;

const OPENCODE_KEYS = ["type", "model", "timeoutMs"] as const;

const LEGACY_KEYS = [
  "endpoint",
  "model",
  "apiKeyEnv",
  "maxTokens",
  "reasoningEffort",
  "chatTemplateKwargs",
  "retries",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

function unsupportedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function readOpenAICompatibleOptions(
  source: Record<string, unknown>,
  warnings: string[],
): ResolvedOpenAICompatibleOptions {
  const retries = nonNegativeInteger(source.retries, DEFAULT_RETRIES);
  if (isPresent(source.retries) && retries !== Number(source.retries)) {
    warnings.push(`Ignoring invalid retries=${String(source.retries)}; using ${retries}`);
  }
  return {
    endpoint: optionalString(source.endpoint),
    model: optionalString(source.model),
    apiKeyEnv: optionalString(source.apiKeyEnv),
    maxTokens: positiveInteger(source.maxTokens, DEFAULT_MAX_TOKENS),
    reasoningEffort: typeof source.reasoningEffort === "string" ? source.reasoningEffort : null,
    chatTemplateKwargs: normalizeChatTemplateKwargs(
      source.chatTemplateKwargs as Record<string, unknown> | string | null | undefined,
    ),
    retries,
  };
}

function readModelRef(value: unknown): { model?: OpenCodeModelRef; error?: string } {
  if (!isPresent(value)) return {};
  if (!isRecord(value)) {
    return {
      error: 'llm.model must be an object with "providerID" and "id" when llm.type is "opencode"',
    };
  }
  const providerID = optionalString(value.providerID);
  const id = optionalString(value.id);
  if (!providerID || !id) {
    return {
      error: 'llm.model must include non-empty "providerID" and "id" when llm.type is "opencode"',
    };
  }
  const variant = optionalString(value.variant);
  return { model: { providerID, id, ...(variant ? { variant } : {}) } };
}

/**
 * Resolve the configured backend. Never throws: validation problems are
 * returned as `error` so the plugin can report them without breaking startup.
 */
export function resolveLLMConfig(pluginOptions: PluginOptions | undefined): ResolvedLLMConfig {
  const warnings: string[] = [];
  const resolved: ResolvedLLMConfig = {
    backend: "openai-compatible",
    opencode: { model: undefined, timeoutMs: DEFAULT_OPENCODE_TIMEOUT_MS },
    openai: readOpenAICompatibleOptions((pluginOptions ?? {}) as Record<string, unknown>, warnings),
    error: undefined,
    warnings,
  };

  const llm = pluginOptions?.llm as unknown;
  if (!isPresent(llm)) return resolved;

  if (!isRecord(llm)) {
    resolved.error = 'llm must be an object with a "type" of "opencode" or "openai-compatible"';
    return resolved;
  }

  const type = llm.type;
  if (!isPresent(type)) {
    resolved.error = 'llm.type is required; use "opencode" or "openai-compatible"';
    return resolved;
  }

  if (type === "opencode") {
    const ignored = unsupportedKeys(llm, OPENCODE_KEYS);
    if (ignored.length > 0) {
      resolved.error =
        `llm.type "opencode" does not support: ${ignored.join(", ")}. ` +
        "OpenCode applies model settings itself, so remove them from the plugin options.";
      return resolved;
    }
    const model = readModelRef(llm.model);
    if (model.error) {
      resolved.error = model.error;
      return resolved;
    }
    resolved.backend = "opencode";
    resolved.opencode = {
      model: model.model,
      timeoutMs: positiveInteger(llm.timeoutMs, DEFAULT_OPENCODE_TIMEOUT_MS),
    };
    const legacy = LEGACY_KEYS.filter((key) => isPresent(pluginOptions?.[key]));
    if (legacy.length > 0) {
      warnings.push(
        `Ignoring top-level LLM options (${legacy.join(", ")}) because llm.type is "opencode"`,
      );
    }
    return resolved;
  }

  if (type === "openai-compatible") {
    const unknown = unsupportedKeys(llm, OPENAI_COMPATIBLE_KEYS);
    if (unknown.length > 0) {
      resolved.error =
        `llm.type "openai-compatible" does not support: ${unknown.join(", ")}. ` +
        'Remove them or use llm.type "opencode".';
      return resolved;
    }
    resolved.backend = "openai-compatible";
    resolved.openai = readOpenAICompatibleOptions(llm, warnings);
    if (!resolved.openai.endpoint) {
      resolved.error = 'llm.endpoint is required when llm.type is "openai-compatible"';
    } else if (!resolved.openai.model) {
      resolved.error = 'llm.model is required when llm.type is "openai-compatible"';
    }
    const legacy = LEGACY_KEYS.filter((key) => isPresent(pluginOptions?.[key]));
    if (legacy.length > 0) {
      warnings.push(
        `Ignoring top-level LLM options (${legacy.join(", ")}) because llm.type is "openai-compatible"`,
      );
    }
    return resolved;
  }

  resolved.error = `Unknown llm.type "${String(type)}"; use "opencode" or "openai-compatible"`;
  return resolved;
}
