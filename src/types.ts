import type { Context, KeymapCommand } from "@opencode/plugin/tui/context";

export type { Context, KeymapCommand };

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(scope: string, message: string, level?: LogLevel): void;
}

export type ToastVariant = "info" | "success" | "warning" | "error";
export type Toast = (message: string, variant?: ToastVariant) => void;

export interface CompletionResult {
  text: string | null;
  error?: string;
}

export interface CompletionConfig {
  maxTokens?: number;
}

export interface CompletionRequest {
  system?: string;
  prompt: string;
  config?: CompletionConfig;
}

export type Complete = (request: CompletionRequest) => Promise<CompletionResult>;

export interface VoiceState {
  mic: string;
  model: string;
  language: string;
  apiModel: string | null;
  ttsVoice: string;
  ttsMode: "on" | "off";
}

export interface VoiceStore {
  voice: VoiceState;
  setVoice: (mutation: (draft: VoiceState) => void) => void | Promise<void>;
}

export interface Prompts {
  stt: string | null;
  ttsAuto: string | null;
  ttsManual: string | null;
}

export interface PluginOptions {
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  reasoningEffort?: string | null;
  chatTemplateKwargs?: Record<string, unknown> | string | null;
  retries?: number;
  tmpDir?: string;
  sttEndpoint?: string;
  sttModel?: string;
  sttApiKeyEnv?: string;
  sttLanguage?: string;
  trimSilence?: boolean;
  sttPrompt?: string;
  ttsAutoPrompt?: string;
  ttsManualPrompt?: string;
}

export interface CommandModule {
  commands: KeymapCommand[];
  cleanup?: () => void;
}
