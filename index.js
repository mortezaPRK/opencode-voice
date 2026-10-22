// opencode-voice: Speech-to-text and text-to-speech for OpenCode (V2 CLI plugin).
//
// STT: Record voice via sox, transcribe with whisper-cpp or an OpenAI-compatible
//      STT API, normalize with an OpenAI-compatible LLM, submit to the session.
//
// TTS: Auto-speak assistant responses (or read on demand) via Piper,
//      with LLM normalization for natural speech.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox
//   TTS: Piper binary on PATH, voice models at ~/.local/share/piper-voices/
//
// Configuration via opencode.json(c) plugin options:
//   { "plugins": [{ "package": "@morteza/dev/opencode-voice", "options": { "endpoint": "...", "model": "...", "apiKeyEnv": "..." } }] }
//
// Runtime state (model, mic, voice, tts mode) persists via ctx.storage.

import fs from "node:fs";
import os from "node:os";
import { Plugin } from "@opencode/plugin/tui";
import { registerSTT } from "./lib/stt.js";
import { registerTTS } from "./lib/tts.js";
import { createClient } from "./lib/llm-client.js";
import { createLogger } from "./lib/logger.js";

function loadPromptFile(filePath, logger, name) {
  if (!filePath) return null;
  const resolved = filePath.replace(/^~(?=\/|$)/, os.homedir());
  try {
    const prompt = fs.readFileSync(resolved, "utf-8").trim() || null;
    logger?.log(
      "plugin",
      prompt ? `Loaded ${name} prompt: ${resolved}` : `Ignored empty ${name} prompt: ${resolved}`,
      "debug",
    );
    return prompt;
  } catch (err) {
    logger?.log("Plugin", `Failed to load ${name} prompt ${resolved}: ${err.message}`, "warn");
    return null;
  }
}

// Default whisper model used when sttModel is not configured.
const DEFAULT_MODEL = "large-v3-turbo-q5_0";

export default Plugin.define({
  id: "opencode-voice",
  setup(ctx) {
    const opts = ctx.options || {};
    const logger = createLogger(ctx.client);
    logger.log("plugin", "Initializing", "debug");

    const { complete } = createClient(opts, logger);

    const prompts = {
      stt: loadPromptFile(opts.sttPrompt, logger, "STT"),
      ttsAuto: loadPromptFile(opts.ttsAutoPrompt, logger, "TTS auto"),
      ttsManual: loadPromptFile(opts.ttsManualPrompt, logger, "TTS manual"),
    };

    // Durable, reactive store for all runtime voice state (replaces V1 api.kv).
    const [voice, setVoice] = ctx.storage.store("voice", {
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
    // in current builds calling ctx.keymap.layer directly during setup throws
    // "Keymap.Provider is missing". The layer is disposed automatically when the
    // slot/plugin is torn down, so we don't dispose it in the cleanup below.
    ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [...stt.commands, ...tts.commands],
          bindings: [...stt.commands, ...tts.commands].map((c) => c.id),
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
