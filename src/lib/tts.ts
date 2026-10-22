// Text-to-speech: LLM normalization, Piper synthesis, sox playback.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { getActiveSessionID, getSessionTitle, getTurnAssistantText } from "./session.js";
import type {
  CommandModule,
  Complete,
  Context,
  KeymapCommand,
  Logger,
  Prompts,
  ToastVariant,
  VoiceState,
  VoiceStore,
} from "../types.js";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");

const TTS_VOICES: Record<string, { label: string; file: string }> = {
  ryan: { label: "Ryan (high)", file: "en_US-ryan-high.onnx" },
  bryce: { label: "Bryce (medium)", file: "en_US-bryce-medium.onnx" },
};
const DEFAULT_TTS_VOICE = "ryan";

const PIPER_RATE = 22050;
const PIPER_BITS = 16;
const PIPER_CHANNELS = 1;

// ---- System prompts ----

const SYSTEM_AUTO = `You are a text-to-speech narrator for a coding assistant CLI. Your job is to convert the assistant's markdown output into natural spoken text that is useful and pleasant to listen to.

You have three modes depending on the content complexity:

1. NARRATE - For simple explanations, short answers, and conversational responses. Convert to natural spoken text, normalizing code references for speech.
   - camelCase/PascalCase identifiers: split into words (parseConfig -> "parse config")
   - File paths: use just the filename (src/utils/helpers.ts -> "helpers dot ts")
   - Short code snippets in backticks: read them naturally
   - Keep the narrative flow intact

2. SUMMARIZE - For responses with significant code blocks, multiple file changes, or complex technical details. Provide a brief spoken summary of what was done and tell the user to check the screen.
   - Mention what was changed and why
   - Do not try to describe code blocks verbatim
   - End with something like "check the details on your screen" or "take a look at the output for the specifics"

3. NOTIFY - For very short confirmations, status updates, or acknowledgments. Keep it to one brief sentence.

Choose the appropriate mode based on the content. Most responses with code blocks should use SUMMARIZE mode. Simple Q&A or short explanations use NARRATE. Build results, "done", confirmations use NOTIFY.

Output ONLY the spoken text. Nothing else. No mode labels. No commentary.`;

const SYSTEM_MANUAL = `You are a text-to-speech reader for a coding assistant. The user has explicitly requested this text be read aloud. Read the prose content faithfully and in detail.

Rules:
- Read all prose text naturally and completely
- Code identifiers: split camelCase/PascalCase/snake_case into words (parseConfig -> "parse config", my_variable -> "my variable")
- File paths: read just the filename with extension (src/utils/helpers.ts -> "helpers dot ts")
- Line references: keep as is ("line 42")
- URLs: say "a link" or just the domain name
- Code blocks: skip entirely, just say "code block" or "code snippet"
- Error codes: expand naturally (ECONNREFUSED -> "connection refused")
- Shell commands: read them naturally (npm test -> "npm test")
- List items: read each item
- Remove markdown formatting but preserve all the informational content
- Do NOT summarize. Do NOT say "check the screen". Read everything that is prose.
- Output ONLY the spoken text`;

// ---- Session helpers ----

function extractSessionID(event: unknown): string | null {
  const e = event as {
    data?: { sessionID?: string };
    sessionID?: string;
    properties?: { sessionID?: string };
  };
  return e?.data?.sessionID ?? e?.sessionID ?? e?.properties?.sessionID ?? null;
}

// ---- Public API for V2 CLI plugin ----

export interface TTSModule extends CommandModule {
  subscribe: () => Array<() => void>;
}

export function registerTTS(
  ctx: Context,
  complete: Complete,
  prompts: Prompts,
  store: VoiceStore,
  logger: Logger,
): TTSModule {
  const { voice, setVoice } = store;
  const systemAuto = prompts?.ttsAuto || SYSTEM_AUTO;
  const systemManual = prompts?.ttsManual || SYSTEM_MANUAL;

  function toast(message: string, variant: ToastVariant = "info"): void {
    ctx.ui.toast.show({ message, variant, duration: 3000 });
  }

  function getVoiceEntry(): { label: string; file: string } {
    const current = voice.ttsVoice || DEFAULT_TTS_VOICE;
    return TTS_VOICES[current] || TTS_VOICES[DEFAULT_TTS_VOICE];
  }

  function getVoiceModel(): string {
    return path.join(VOICES_DIR, getVoiceEntry().file);
  }

  function getVoiceLabel(): string {
    return getVoiceEntry().label;
  }

  function piperOnPath(): boolean {
    const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    return pathDirs.some((dir) => fs.existsSync(path.join(dir, "piper")));
  }

  async function normalizeForSpeech(
    text: string,
    systemPrompt: string,
  ): Promise<{ text: string | null; error?: string }> {
    logger.log("TTS", `Normalizing speech chars=${text.length}`, "debug");
    return complete({
      system: systemPrompt,
      prompt: `Convert for text-to-speech:\n\n${text}`,
      config: { maxTokens: 4096 },
    });
  }

  // ---- Audio pipeline ----

  let piperProc: ChildProcess | null = null;
  let playProc: ChildProcess | null = null;

  function killProcs(): void {
    if (piperProc) {
      try {
        piperProc.kill("SIGKILL");
      } catch {}
      piperProc = null;
    }
    if (playProc) {
      try {
        playProc.kill("SIGKILL");
      } catch {}
      playProc = null;
    }
  }

  function speak(text: string): Promise<void> {
    if (!text) return Promise.resolve();
    const line = text.replace(/\n/g, " ").trim();
    if (!line) return Promise.resolve();

    killProcs();

    const voiceModel = getVoiceModel();
    logger.log("TTS", `Speak requested chars=${line.length} voice=${voiceModel}`, "debug");
    if (!piperOnPath()) {
      logger.log("TTS", `Piper binary not found on PATH`, "warn");
      toast(`Piper binary not found on PATH`, "warning");
      return Promise.resolve();
    }
    if (!fs.existsSync(voiceModel)) {
      logger.log("TTS", `Voice model not found: ${voiceModel}`, "warn");
      toast(`Voice model not found: ${voiceModel}`, "warning");
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let piperStderr = "";
      let playStderr = "";
      const play = spawn(
        "play",
        [
          "-t",
          "raw",
          "-r",
          String(PIPER_RATE),
          "-e",
          "signed",
          "-b",
          String(PIPER_BITS),
          "-c",
          String(PIPER_CHANNELS),
          "-q",
          "-",
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      playProc = play;

      const piper = spawn("piper", ["-m", voiceModel, "--output_raw"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      piperProc = piper;

      piper.stderr?.on("data", (chunk: Buffer) => {
        piperStderr += chunk.toString();
      });
      play.stderr?.on("data", (chunk: Buffer) => {
        playStderr += chunk.toString();
      });

      piper.stdout?.on("data", (chunk: Buffer) => {
        if (play.stdin && !play.stdin.destroyed) {
          play.stdin.write(chunk);
        }
      });

      piper.on("close", (code: number | null) => {
        if (code !== 0 && code !== null) {
          logger.log("TTS", `piper exited code=${code} stderr=${piperStderr.trim()}`, "error");
        }
        if (play.stdin && !play.stdin.destroyed) {
          play.stdin.end();
        }
      });

      play.on("close", (code: number | null) => {
        if (code !== 0 && code !== null) {
          logger.log("TTS", `play exited code=${code} stderr=${playStderr.trim()}`, "error");
        } else {
          logger.log("TTS", "playback finished", "debug");
        }
        piperProc = null;
        playProc = null;
        resolve();
      });

      piper.on("error", (err: Error) => {
        logger.log("TTS", `piper error: ${err.message}`, "error");
        killProcs();
        resolve();
      });
      play.on("error", (err: Error) => {
        logger.log("TTS", `play error: ${err.message}`, "error");
        killProcs();
        resolve();
      });

      if (piper.stdin && !piper.stdin.destroyed) {
        piper.stdin.write(line + "\n");
        piper.stdin.end();
      }
    });
  }

  // ---- Session-prefixed announcements ----

  async function speakWithSessionPrefix(
    sessionID: string | null,
    message: string,
    suffix?: string,
  ): Promise<void> {
    const sessionTitle = await getSessionTitle(ctx, sessionID);
    const parts: string[] = [];
    if (sessionTitle) parts.push(`Session: ${sessionTitle}.`);
    parts.push(message);
    if (suffix) parts.push(suffix);
    await speak(parts.join(" "));
  }

  function stopSpeech(): boolean {
    const wasPlaying = piperProc !== null || playProc !== null;
    killProcs();
    return wasPlaying;
  }

  // ---- Manual mode ----

  async function speakLastResponse(): Promise<void> {
    const sessionID = getActiveSessionID(ctx);
    const result = await getTurnAssistantText(ctx, sessionID);
    if (!result || !result.text) {
      toast("No assistant response to speak", "warning");
      return;
    }

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemManual);
    if (!llmResult.text) {
      logger.log("TTS", `Manual normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger.log("TTS", `Manual normalization succeeded chars=${llmResult.text.length}`, "debug");
    toast("Speaking last response");
    await speak(llmResult.text);
  }

  // ---- Auto mode ----

  let lastSpokenMessageID: string | null = null;

  // Triggered once per completed agent execution, so auto-TTS fires only after
  // a real turn (a genuine assistant response) rather than on the initial idle.
  async function speakAuto(sessionID: string | null): Promise<void> {
    if (voice.ttsMode !== "on") return;

    const result = await getTurnAssistantText(ctx, sessionID);
    if (!result || !result.text) return;

    if (result.lastMessageID === lastSpokenMessageID) return;
    lastSpokenMessageID = result.lastMessageID;

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemAuto);
    if (!llmResult.text) {
      logger.log("TTS", `Auto normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger.log("TTS", `Auto normalization succeeded chars=${llmResult.text.length}`, "debug");
    await speakWithSessionPrefix(sessionID, llmResult.text, "Ready for your input.");
  }

  function subscribe(): Array<() => void> {
    const stops: Array<() => void> = [];

    // Fires when an agent execution completes (a real assistant turn).
    stops.push(
      ctx.data.on("session.execution.succeeded", (event: unknown) => {
        const sessionID = extractSessionID(event);
        if (!sessionID) return;
        void speakAuto(sessionID);
      }),
    );

    stops.push(
      ctx.data.on("permission.asked", (event: unknown) => {
        if (voice.ttsMode !== "on") return;
        const sessionID = extractSessionID(event);
        void speakWithSessionPrefix(sessionID, "Permission requested. Please check your screen.");
      }),
    );

    // Question/input announcements: a form was created that needs an answer.
    stops.push(
      ctx.data.on("form.created", (event: unknown) => {
        if (voice.ttsMode !== "on") return;
        const sessionID = extractSessionID(event);
        void speakWithSessionPrefix(
          sessionID,
          "A question needs your answer. Please check your screen.",
        );
      }),
    );

    return stops;
  }

  // ---- Commands ----

  const commands: KeymapCommand[] = [
    {
      id: "tts.speak-last",
      title: "TTS: speak last response",
      group: "Voice",
      description: "Read the last assistant response aloud (detailed)",
      bind: "<leader>s",
      palette: true,
      slash: { name: "tts-speak" },
      run() {
        void speakLastResponse();
      },
    },
    {
      id: "tts.mode",
      title: "TTS: toggle",
      group: "Voice",
      description: "Toggle auto text-to-speech on/off",
      bind: "<leader>v",
      palette: true,
      slash: { name: "tts-mode" },
      run() {
        const current = voice.ttsMode || "off";
        const next = current === "on" ? "off" : "on";
        setVoice((draft) => {
          draft.ttsMode = next;
        });
        if (next === "off") stopSpeech();
        toast(next === "on" ? `TTS on (${getVoiceLabel()})` : "TTS off");
      },
    },
    {
      id: "tts.stop",
      title: "TTS: stop playback",
      group: "Voice",
      description: "Stop current TTS playback",
      bind: "escape",
      palette: true,
      slash: { name: "tts-stop" },
      run() {
        if (stopSpeech()) toast("TTS stopped");
      },
    },
    {
      id: "tts.voice",
      title: "TTS: select voice",
      group: "Voice",
      description: "Choose TTS voice",
      palette: true,
      slash: { name: "tts-voice" },
      async run() {
        const current = voice.ttsVoice || DEFAULT_TTS_VOICE;
        const selected = await ctx.ui.dialog.select({
          title: "Select voice",
          current,
          options: Object.entries(TTS_VOICES).map(([key, value]) => ({
            title: value.label,
            value: key,
          })),
        });
        if (selected === undefined) return;
        setVoice((draft) => {
          draft.ttsVoice = selected;
        });
        toast(`Voice: ${TTS_VOICES[selected].label}`);
      },
    },
  ];

  function cleanup(): void {
    killProcs();
  }

  return { commands, subscribe, cleanup };
}

export type { VoiceState };
