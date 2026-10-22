// Speech-to-text: sox recording, whisper-cpp or API transcription, LLM normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { getActiveSessionID, getActiveSessionTitle } from "./session.js";
import type {
  CommandModule,
  Complete,
  Context,
  KeymapCommand,
  Logger,
  PluginOptions,
  Prompts,
  Toast,
  ToastVariant,
  VoiceState,
  VoiceStore,
} from "../types.js";

const DEFAULT_MODEL = "large-v3-turbo-q5_0";

let sttApiEndpoint: string | null = null;
let sttApiModel: string | null = null;
let sttApiKeyEnv: string | null = null;

const WAV_FILENAME = "opencode-stt.wav";
let tmpDir = "/tmp";

const MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

interface WhisperModel {
  label: string;
  file: string;
}

const MODELS: Record<string, WhisperModel> = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5 (recommended)",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": { label: "Large v3 Turbo Q8", file: "ggml-large-v3-turbo-q8_0.bin" },
  "large-v3-turbo": { label: "Large v3 Turbo (full)", file: "ggml-large-v3-turbo.bin" },
  "medium-q5_0": { label: "Medium Q5 (multilingual, faster)", file: "ggml-medium-q5_0.bin" },
  "small.en": { label: "Small English", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", file: "ggml-small.bin" },
  "base.en": { label: "Base English", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English (fastest)", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual (fastest)", file: "ggml-tiny.bin" },
};

const DEFAULT_LANGUAGE = "auto";
// Curated subset for the /stt-language picker; options.sttLanguage accepts any
// whisper.cpp language code.
const LANGUAGES: Record<string, { label: string }> = {
  auto: { label: "Auto-detect" },
  en: { label: "English" },
  zh: { label: "Chinese" },
  yue: { label: "Cantonese" },
  ja: { label: "Japanese" },
  ko: { label: "Korean" },
  de: { label: "German" },
  fr: { label: "French" },
  es: { label: "Spanish" },
  pt: { label: "Portuguese" },
  ru: { label: "Russian" },
  it: { label: "Italian" },
};
let sttDefaultLanguage = DEFAULT_LANGUAGE;

type AudioBackend = "coreaudio" | "pulseaudio" | "default";

interface InputDevice {
  name: string;
  label: string;
}

interface TranscriptionResult {
  text?: string;
  error?: string;
}

export function isOpenRouterEndpoint(endpoint: string | null | undefined): boolean {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint || "");
}

function buildMultipartTranscriptionRequest(
  model: string,
  audioBuffer: Buffer,
  apiKey: string | null,
): { headers: Record<string, string>; body: FormData } {
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  return { headers, body: form };
}

export function buildOpenRouterTranscriptionRequest(
  model: string,
  audioBuffer: Buffer,
  apiKey: string | null,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const payload = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  };

  return { headers, body: JSON.stringify(payload) };
}

function getModelsDir(): string {
  for (const dir of MODELS_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return MODELS_DIRS[0];
}

// ---- Audio backend detection (coreaudio / pulseaudio / sox default) ----

function detectAudioBackend(): AudioBackend {
  if (process.platform === "darwin") return "coreaudio";
  try {
    execSync("pactl --version", { stdio: "ignore", timeout: 3000 });
    return "pulseaudio";
  } catch {
    return "default";
  }
}

// ---- Audio server diagnostics ----

export function isWSL(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// Unlike `pactl --version`, `pactl info` actually connects to the server.
function pulseServerHealth(): { ok: boolean } {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// User-facing hint for missing devices / recording failures. On WSL the audio
// server is WSLg's PulseAudio, which can wedge and needs a `wsl --shutdown`.
export function buildAudioHint(input: {
  backend: AudioBackend;
  serverOk: boolean;
  isWsl: boolean;
}): string {
  const { backend, serverOk, isWsl: wsl } = input;
  if (backend !== "pulseaudio") return "No input devices found";
  if (serverOk) return "No input devices found - check your audio input source configuration";
  if (wsl) {
    return 'Audio server unreachable. On WSL, WSLg\'s PulseAudio may be stuck - run "wsl --shutdown" on Windows, then reopen Ubuntu';
  }
  return "Audio server unreachable - check that PipeWire/PulseAudio is running";
}

// Appends a server-health hint to recording failure messages when the
// PulseAudio server is unreachable (e.g. wedged WSLg on WSL).
function audioFailureSuffix(backend: AudioBackend): string {
  if (backend !== "pulseaudio") return "";
  if (pulseServerHealth().ok) return "";
  return `. ${buildAudioHint({ backend, serverOk: false, isWsl: isWSL() })}`;
}

// Input device descriptors: name is the value passed to sox, label is shown in the UI.
export function parsePactlSources(jsonText: string): InputDevice[] {
  const data = JSON.parse(jsonText) as Array<{ name?: string; description?: string }>;
  return (Array.isArray(data) ? data : [])
    .filter((s) => s?.name && !s.name.endsWith(".monitor"))
    .map((s) => ({
      name: s.name as string,
      label: s.description ? `${s.description} (${s.name})` : (s.name as string),
    }));
}

export function parsePactlSourcesShort(text: string): InputDevice[] {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name) => name && !name.endsWith(".monitor"))
    .map((name) => ({ name, label: name }));
}

function listInputDevices(backend: AudioBackend): InputDevice[] {
  if (backend === "coreaudio") {
    try {
      const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(json) as {
        SPAudioDataType?: Array<{ _items?: Array<Record<string, unknown>> }>;
      };
      return (data.SPAudioDataType?.[0]?._items || [])
        .filter((d) => d.coreaudio_input_source != null)
        .map((d) => {
          const name = (d.coreaudio_device_name || d._name) as string;
          return { name, label: name };
        });
    } catch {
      return [];
    }
  }
  if (backend === "pulseaudio") {
    try {
      const json = execSync("pactl -f json list sources 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return parsePactlSources(json);
    } catch {
      try {
        const out = execSync("pactl list sources short 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        });
        return parsePactlSourcesShort(out);
      } catch {
        return [];
      }
    }
  }
  return [];
}

export function buildRecordArgs(backend: AudioBackend, mic: string | null): string[] {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", mic || "default"];
  if (backend === "coreaudio" && mic) return ["-t", "coreaudio", mic];
  return ["-d"];
}

// ---- Recording state and control ----

let soxProc: ChildProcess | null = null;
let soxStderr = "";
let recording = false;
let processing = false;

function forceKillSox(logger?: Logger): void {
  if (soxProc) {
    try {
      process.kill(soxProc.pid as number, "SIGKILL");
      logger?.log("STT", `Killed sox pid=${soxProc.pid}`, "debug");
    } catch {}
    soxProc = null;
  }
  try {
    execSync("pkill -9 -f 'sox.*opencode-stt'", { stdio: "ignore" });
  } catch {}
}

function startRecording(
  voice: VoiceState,
  backend: AudioBackend,
  toast: Toast,
  logger: Logger,
  trimSilence = true,
): void {
  if (soxProc) {
    logger.log("STT", "Start recording skipped: sox already running", "debug");
    return;
  }

  const wavFile = path.join(tmpDir, WAV_FILENAME);
  forceKillSox(logger);
  try {
    fs.unlinkSync(wavFile);
  } catch {}

  soxStderr = "";
  const mic = voice.mic || null;
  const inputArgs = buildRecordArgs(backend, mic);
  logger.log(
    "STT",
    `Starting recording backend=${backend} mic=${mic || "system default"}`,
    "debug",
  );

  const silenceArgs = trimSilence ? ["silence", "1", "0.1", "1%"] : [];
  const proc = spawn(
    "sox",
    [...inputArgs, "-r", "16000", "-c", "1", "-b", "16", wavFile, ...silenceArgs],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );
  soxProc = proc;

  proc.stderr?.on("data", (chunk: Buffer) => {
    soxStderr += chunk.toString();
  });

  proc.on("error", (err: Error) => {
    soxProc = null;
    logger.log("STT", `Recording failed: ${err.message}`, "error");
    if (recording) {
      recording = false;
      toast(`Recording failed: ${err.message}${audioFailureSuffix(backend)}`, "error");
    }
  });

  proc.on("exit", (code: number | null) => {
    soxProc = null;
    logger.log(
      "STT",
      `sox exited code=${code} stderr=${soxStderr.trim()}`,
      code === 0 || code === null ? "debug" : "warn",
    );
    if (recording && code !== 0 && code !== null && !processing) {
      recording = false;
      const errLine = soxStderr.trim().split("\n").pop();
      toast(
        `Recording error: ${errLine || `sox exited (code=${code})`}${audioFailureSuffix(backend)}`,
        "error",
      );
    }
  });

  recording = true;
}

function stopRecording(logger: Logger): void {
  logger.log("STT", "Stopping recording", "debug");
  if (soxProc) soxProc.kill("SIGINT");
}

async function waitForSoxExit(logger: Logger, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (soxProc && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (soxProc) {
    logger.log("STT", "sox did not stop before timeout", "warn");
    forceKillSox(logger);
  }
}

function getModelName(voice: VoiceState): string {
  const model = voice.model || DEFAULT_MODEL;
  return MODELS[model] ? model : DEFAULT_MODEL;
}

function getModelPath(voice: VoiceState): string {
  return path.join(getModelsDir(), MODELS[getModelName(voice)].file);
}

function getLanguage(voice: VoiceState): string {
  return voice.language || sttDefaultLanguage;
}

export function buildWhisperArgs(
  modelPath: string,
  wavFile: string,
  language: string | null,
): string[] {
  return ["-m", modelPath, "-f", wavFile, "-l", language || DEFAULT_LANGUAGE, "-np", "-nt"];
}

function transcribe(voice: VoiceState, logger: Logger): Promise<TranscriptionResult> {
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const mp = getModelPath(voice);
  const lang = getLanguage(voice);
  logger.log("STT", `Local transcription requested model=${mp} language=${lang}`, "debug");
  if (!fs.existsSync(mp)) {
    logger.log("STT", `Whisper model missing: ${mp}`, "error");
    return Promise.resolve({
      error: `Model not found: ${getModelName(voice)}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(wavFile)) {
    logger.log("STT", `Recording file missing: ${wavFile}`, "error");
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return Promise.resolve({ error: "Recording is empty - no audio captured" });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("whisper-cli", buildWhisperArgs(mp, wavFile, lang), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger.log("STT", `Started whisper-cli pid=${proc.pid}`, "debug");

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      logger.log("STT", "whisper-cli timed out after 60s", "error");
      resolve({ error: "Transcription timed out (60s)" });
    }, 60000);

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      logger.log("STT", `whisper-cli error: ${err.message}`, "error");
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code: number | null) => {
      clearTimeout(timer);
      // whisper-cli exits 0 even for an unknown language, printing the error to
      // stderr instead; surface it rather than reporting "no speech detected".
      const langError = stderr.match(/error: unknown language '([^']+)'/);
      if (langError) {
        logger.log("STT", `whisper-cli rejected language: ${langError[1]}`, "error");
        resolve({ error: `Unknown whisper language: ${langError[1]}` });
        return;
      }
      if (code !== 0) {
        logger.log("STT", `whisper-cli exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      logger.log("STT", `Local transcription succeeded stdoutChars=${stdout.length}`, "debug");
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a coding assistant CLI.

Clean up raw whisper transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Use the session context above to resolve ambiguous references (e.g. "that function", "the file", "it")
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation
- Keep the user's intent and meaning intact

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

async function normalizeTranscription(
  complete: Complete,
  rawText: string,
  sessionTitle: string,
  systemPrompt: string,
  logger: Logger,
): Promise<{ text: string | null; error?: string }> {
  const contextLine = sessionTitle ? ` The user is currently working on: "${sessionTitle}"` : "";
  const system = `${systemPrompt}${contextLine}`;

  logger.log("STT", `Normalizing transcription chars=${rawText.length}`, "debug");
  const result = await complete({
    system,
    prompt: `Clean up this speech-to-text transcription:\n\n${rawText}`,
  });
  return result;
}

async function getApiModels(logger: Logger): Promise<Array<{ title: string; value: string }>> {
  if (!sttApiEndpoint) return [];
  try {
    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}models`
      : `${sttApiEndpoint}/models`;
    const headers: Record<string, string> = {};
    if (sttApiKeyEnv && process.env[sttApiKeyEnv]) {
      headers["Authorization"] = "Bearer " + process.env[sttApiKeyEnv];
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    logger.log("STT", `Fetched STT API models status=${resp.status}`, resp.ok ? "debug" : "warn");
    if (!resp.ok) return [];
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    return (data.data || [])
      .filter((m) => m.id && /whisper/i.test(m.id))
      .map((m) => ({ title: m.id as string, value: m.id as string }));
  } catch (err) {
    logger.log("STT", `Failed to fetch STT API models: ${(err as Error).message}`, "error");
    return [];
  }
}

async function transcribeApi(voice: VoiceState, logger: Logger): Promise<TranscriptionResult> {
  if (!sttApiEndpoint || !sttApiModel) {
    logger.log("STT", "STT API transcription skipped: API not configured", "warn");
    return { error: "STT API not configured" };
  }
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const model = voice.apiModel || sttApiModel;
  logger.log("STT", `STT API transcription requested model=${model}`, "debug");

  if (!fs.existsSync(wavFile)) {
    logger.log("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return { error: "Recording is empty - no audio captured" };
  }

  try {
    const audioBuffer = await fs.promises.readFile(wavFile);
    const apiKey = sttApiKeyEnv ? (process.env[sttApiKeyEnv] ?? null) : null;
    const useOpenRouterFormat = isOpenRouterEndpoint(sttApiEndpoint);

    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}audio/transcriptions`
      : `${sttApiEndpoint}/audio/transcriptions`;

    const request = useOpenRouterFormat
      ? buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey)
      : buildMultipartTranscriptionRequest(model, audioBuffer, apiKey);

    const resp = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(60000),
    });
    logger.log("STT", `STT API response status=${resp.status}`, resp.ok ? "debug" : "error");

    if (!resp.ok) {
      const responseBody = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(responseBody) as { error?: { message?: string } };
        msg = err?.error?.message || msg;
      } catch {}
      return { error: msg };
    }

    let data: { text?: string };
    try {
      data = (await resp.json()) as { text?: string };
    } catch (err) {
      logger.log("STT", `STT API returned invalid JSON: ${(err as Error).message}`, "error");
      return { error: `STT API returned invalid JSON: ${(err as Error).message}` };
    }
    logger.log("STT", `STT API transcription succeeded chars=${data.text?.length || 0}`, "debug");
    return { text: data.text?.trim() || "" };
  } catch (err) {
    const e = err as Error;
    logger.log("STT", `STT API request failed: ${e.message}`, "error");
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      return { error: "STT API request timed out (60s)" };
    }
    return { error: `STT API request failed: ${e.message}` };
  }
}

// V2 has no composer-set API exposing staged prompt edits, so transcribed text
// is submitted directly to the focused session. For the review (non-submit)
// path we confirm first so the user can cancel before sending.
export async function sendTranscription(
  ctx: Context,
  text: string,
  submit: boolean,
  toast: Toast,
): Promise<boolean> {
  if (!submit) {
    const ok = await ctx.ui.dialog
      .confirm({
        title: "STT",
        message: `Submit transcription?\n\n${text}`,
        label: { confirm: "Submit", cancel: "Cancel" },
      })
      .catch(() => false);
    if (!ok) {
      toast("Transcription cancelled");
      return false;
    }
  }
  let sessionID = getActiveSessionID(ctx);
  if (!sessionID) {
    if (ctx.ui.router.current().type !== "home") {
      throw new Error("Open a session or the home screen to submit voice input");
    }
    const location = ctx.location ?? ctx.data.location.default();
    const selected = ctx.ui.model.current();
    const session = await ctx.client.session.create({
      ...(location ? { location: { directory: location.directory } } : {}),
      ...(selected
        ? {
            model: {
              providerID: selected.providerID,
              id: selected.modelID,
              ...(selected.variant ? { variant: selected.variant } : {}),
            },
          }
        : {}),
    });
    sessionID = session.id;
    ctx.ui.router.navigate({ type: "session", sessionID });
  }
  await ctx.client.session.prompt({ sessionID, text });
  return true;
}

async function doTranscribePipeline(
  ctx: Context,
  voice: VoiceState,
  complete: Complete,
  toast: Toast,
  systemPrompt: string,
  submit: boolean,
  logger: Logger,
): Promise<void> {
  processing = true;
  try {
    logger.log("STT", `Pipeline started submit=${submit}`, "debug");
    stopRecording(logger);
    await waitForSoxExit(logger);

    toast("Transcribing...");
    const result = sttApiEndpoint
      ? await transcribeApi(voice, logger)
      : await transcribe(voice, logger);

    if (result.error) {
      logger.log("STT", `Transcription failed: ${result.error}`, "error");
      toast(result.error, "error");
      return;
    }
    if (!result.text) {
      logger.log("STT", "Transcription produced no text", "warn");
      toast("No speech detected", "warning");
      return;
    }

    toast("Normalizing...");
    const sessionTitle = await getActiveSessionTitle(ctx);
    const llmResult = await normalizeTranscription(
      complete,
      result.text,
      sessionTitle,
      systemPrompt,
      logger,
    );

    if (!llmResult.text) {
      logger.log("STT", `Normalization failed, using raw input: ${llmResult.error}`, "warn");
      toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      await sendTranscription(ctx, result.text, submit, toast);
      return;
    }

    const sent = await sendTranscription(ctx, llmResult.text, submit, toast);
    if (!sent) return;
    logger.log("STT", `Pipeline completed normalizedChars=${llmResult.text.length}`, "debug");
    toast("Transcription submitted", "success");
  } catch (err) {
    logger.log("STT", `Pipeline error: ${(err as Error).message}`, "error");
    toast(`STT error: ${(err as Error).message}`, "error");
  } finally {
    processing = false;
    recording = false;
  }
}

// ---- Public API for V2 CLI plugin ----

export function registerSTT(
  ctx: Context,
  complete: Complete,
  prompts: Prompts,
  opts: PluginOptions,
  store: VoiceStore,
  logger: Logger,
): CommandModule {
  const { voice, setVoice } = store;
  const systemPrompt = prompts?.stt || STT_SYSTEM_PROMPT;
  const backend = detectAudioBackend();
  logger.log("STT", `Audio backend=${backend}`, "debug");
  function toast(message: string, variant: ToastVariant = "info"): void {
    ctx.ui.toast.show({ message, variant, duration: 3000 });
  }

  if (opts?.sttEndpoint) {
    sttApiEndpoint = opts.sttEndpoint;
    sttApiModel = opts.sttModel || "whisper-large-v3-turbo";
    sttApiKeyEnv = opts.sttApiKeyEnv || null;
    logger.log(
      "STT",
      `Configured STT API endpoint=${sttApiEndpoint} model=${sttApiModel}`,
      "debug",
    );
  }

  if (opts?.sttLanguage) {
    sttDefaultLanguage = opts.sttLanguage;
  }
  logger.log("STT", `Default language=${sttDefaultLanguage}`, "debug");

  tmpDir = opts?.tmpDir || "/tmp";
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    logger.log("STT", `Failed to create tmpDir ${tmpDir}: ${(err as Error).message}`, "warn");
  }
  logger.log("STT", `STT temp dir=${tmpDir}`, "debug");

  const commands: KeymapCommand[] = [
    {
      id: "stt.record",
      title: sttApiEndpoint ? "STT: record/transcribe (API)" : "STT: record/transcribe",
      group: "Voice",
      description: sttApiEndpoint
        ? "Toggle recording; press again to stop and transcribe via API"
        : "Toggle recording; press again to stop and transcribe",
      bind: "ctrl+r",
      palette: true,
      slash: { name: "stt-record" },
      run() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (recording) {
          toast("Stopping, transcribing...");
          void doTranscribePipeline(ctx, voice, complete, toast, systemPrompt, false, logger);
        } else {
          startRecording(voice, backend, toast, logger, opts?.trimSilence ?? true);
          if (recording) toast("Recording... press again to transcribe");
        }
      },
    },
    {
      id: "stt.submit",
      title: sttApiEndpoint ? "STT: submit recording (API)" : "STT: submit recording",
      group: "Voice",
      description: sttApiEndpoint
        ? "Stop recording, transcribe via API, and submit prompt"
        : "Stop recording, transcribe, and submit prompt",
      bind: "<leader>r",
      palette: true,
      slash: { name: "stt-submit" },
      run() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (!recording) {
          toast("No recording in progress", "warning");
          return;
        }
        toast("Stopping, transcribing...");
        void doTranscribePipeline(ctx, voice, complete, toast, systemPrompt, true, logger);
      },
    },
    {
      id: "stt.stop",
      title: "STT: cancel recording",
      group: "Voice",
      description: "Cancel current recording",
      palette: true,
      slash: { name: "stt-stop" },
      run() {
        if (recording) {
          recording = false;
          forceKillSox(logger);
          logger.log("STT", "Recording cancelled", "debug");
          toast("Recording cancelled");
        }
      },
    },
    {
      id: "stt.model",
      title: sttApiEndpoint ? "STT: select model (API)" : "STT: select model",
      group: "Voice",
      description: sttApiEndpoint ? "Choose whisper model via API" : "Choose whisper model",
      palette: true,
      slash: { name: "stt-model" },
      async run() {
        if (sttApiEndpoint) {
          const current = voice.apiModel || sttApiModel || "";
          const apiModels = await getApiModels(logger);
          const options = apiModels.length > 0 ? apiModels : [{ title: current, value: current }];
          const selected = await ctx.ui.dialog.select({
            title: "Select whisper model (API)",
            current,
            options,
          });
          if (selected === undefined) return;
          setVoice((draft) => {
            draft.apiModel = selected;
          });
          toast(`Whisper API model: ${selected}`);
        } else {
          const current = getModelName(voice);
          const selected = await ctx.ui.dialog.select({
            title: "Select whisper model",
            current,
            options: Object.entries(MODELS).map(([key, value]) => ({
              title: value.label,
              value: key,
            })),
          });
          if (selected === undefined) return;
          setVoice((draft) => {
            draft.model = selected;
          });
          toast(`Whisper model: ${MODELS[selected].label}`);
        }
      },
    },
    {
      id: "stt.language",
      title: "STT: select language",
      group: "Voice",
      description: "Choose transcription language (local whisper-cli only)",
      palette: true,
      slash: { name: "stt-language" },
      async run() {
        const current = getLanguage(voice);
        const selected = await ctx.ui.dialog.select({
          title: "Select transcription language",
          current,
          options: Object.entries(LANGUAGES).map(([key, value]) => ({
            title: value.label,
            value: key,
          })),
        });
        if (selected === undefined) return;
        setVoice((draft) => {
          draft.language = selected;
        });
        toast(`Whisper language: ${LANGUAGES[selected].label}`);
      },
    },
    {
      id: "stt.mic",
      title: "STT: select microphone",
      group: "Voice",
      description: "Choose audio input device",
      palette: true,
      slash: { name: "stt-mic" },
      async run() {
        const devices = listInputDevices(backend);
        if (devices.length === 0) {
          const serverOk = backend !== "pulseaudio" || pulseServerHealth().ok;
          const hint = buildAudioHint({ backend, serverOk, isWsl: isWSL() });
          logger.log("STT", `No input devices: ${hint}`, "warn");
          toast(hint);
          return;
        }
        const selected = await ctx.ui.dialog.select({
          title: "Select microphone",
          current: voice.mic,
          options: [
            { title: "System default", value: "" },
            ...devices.map((d) => ({ title: d.label, value: d.name })),
          ],
        });
        if (selected === undefined) return;
        setVoice((draft) => {
          draft.mic = selected;
        });
        if (selected === "") {
          toast("Mic: system default");
        } else {
          const device = devices.find((d) => d.name === selected);
          toast(`Mic: ${device?.label || selected}`);
        }
      },
    },
  ];

  function cleanup(): void {
    forceKillSox(logger);
  }

  return { commands, cleanup };
}
