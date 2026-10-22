// opencode-voice: Speech-to-text and text-to-speech for OpenCode (V2 CLI plugin).

import fs from "node:fs";
import os from "node:os";
import { Plugin } from "@opencode/plugin/tui";
import { registerSTT } from "./lib/stt.js";
import { registerTTS } from "./lib/tts.js";
import { createClient } from "./lib/llm-client.js";
import { createLogger } from "./lib/logger.js";
import type { Logger, PluginOptions, Prompts, VoiceState } from "./types.js";

const DEFAULT_MODEL = "large-v3-turbo-q5_0";

function resolvePath(filePath: string): string {
  return filePath.replace(/^~(?=\/|$)/, os.homedir());
}

function loadPromptFile(filePath: string | undefined, logger: Logger, name: string): string | null {
  if (!filePath) return null;
  const resolved = resolvePath(filePath);
  try {
    const prompt = fs.readFileSync(resolved, "utf-8").trim() || null;
    logger.log(
      "plugin",
      prompt ? `Loaded ${name} prompt: ${resolved}` : `Ignored empty ${name} prompt: ${resolved}`,
      "debug",
    );
    return prompt;
  } catch (err) {
    logger.log(
      "Plugin",
      `Failed to load ${name} prompt ${resolved}: ${(err as Error).message}`,
      "warn",
    );
    return null;
  }
}

export default Plugin.define({
  id: "opencode-voice",
  setup(ctx) {
    const opts = (ctx.options ?? {}) as PluginOptions;
    const logger = createLogger(ctx.client);
    logger.log("plugin", "Initializing", "debug");

    const { complete } = createClient(opts, logger);

    const prompts: Prompts = {
      stt: loadPromptFile(opts.sttPrompt, logger, "STT"),
      ttsAuto: loadPromptFile(opts.ttsAutoPrompt, logger, "TTS auto"),
      ttsManual: loadPromptFile(opts.ttsManualPrompt, logger, "TTS manual"),
    };

    // Durable, reactive store for all runtime voice state.
    const [voice, setVoice] = ctx.storage.store<VoiceState>("voice", {
      initial: {
        mic: "",
        model: opts.sttModel || DEFAULT_MODEL,
        language: opts.sttLanguage || "auto",
        apiModel: opts.sttModel || null,
        ttsVoice: "ryan",
        ttsMode: "off",
      },
    });
    const store = { voice, setVoice };

    const stt = registerSTT(ctx, complete, prompts, opts, store, logger);
    const tts = registerTTS(ctx, complete, prompts, store, logger);

    // Register all voice commands in a single reactive keymap layer. This must
    // run inside a component (an "app" slot render) rather than bare setup:
    // calling ctx.keymap.layer directly during setup throws
    // "Keymap.Provider is missing" in current builds. The layer is disposed
    // automatically when the slot/plugin is torn down.
    ctx.ui.slot({
      append: "app",
      render: () => {
        const commands = [...stt.commands, ...tts.commands];
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands,
          bindings: commands.map((command) => command.id).filter((id): id is string => !!id),
        }));
        return null;
      },
    });

    const stops = tts.subscribe();

    return () => {
      stops.forEach((stop) => stop());
      stt.cleanup?.();
      tts.cleanup?.();
    };
  },
});
