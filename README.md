[![CI](https://github.com/mortezaPRK/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mortezaPRK/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@mortz.prk/opencode-voice)](https://www.npmjs.com/package/@mortz.prk/opencode-voice)
[![Downloads](https://img.shields.io/npm/dm/@mortz.prk/opencode-voice)](https://www.npmjs.com/package/@mortz.prk/opencode-voice)

# opencode-voice

Speech-to-text and text-to-speech plugin for [OpenCode](https://opencode.ai/).

Record voice prompts with local whisper transcription, hear assistant responses
spoken aloud via Piper TTS. Both directions use an LLM to normalize text for
natural speech (fixing homophones, splitting camelCase identifiers, summarizing
code-heavy responses, etc.).

## Install

This is a **V2 CLI plugin** for OpenCode. Add it to the project/global
`opencode.jsonc` under `plugins`. By default the plugin reuses the model and
credentials already configured in OpenCode:

> [!TIP]
> The plugin is CLI-only (voices STT/TTS). To keep it active even against remote
> servers, also add the package under `plugins` in the global CLI config
> (`~/.config/opencode/cli.json`). See [CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli).

```jsonc
{
  "plugins": [
    {
      "package": "@mortz.prk/opencode-voice",
      "options": {
        "llm": {
          "type": "opencode",
          "model": { "providerID": "anthropic", "id": "claude-sonnet-4-6" },
        },
      },
    },
  ],
}
```

Omit `llm.model` to use OpenCode's default model. An OpenAI-compatible
endpoint can be configured instead; see [LLM backend](#llm-backend).

> [!NOTE]
> **Keybind conflict.** This plugin uses `ctrl+r` for voice recording, which
> OpenCode assigns to session rename by default. To let the plugin keep
> `ctrl+r`, disable the conflicting binding in `cli.json`:
>
> ```json
> {
>   "keybinds": { "session.rename": "none" }
> }
> ```

### Refresh cached plugin after updates

If OpenCode keeps using an older published version of the plugin after an
update, clear the cached package and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/
```

## Prerequisites

### Speech-to-text

The plugin uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via a
`whisper-cli` binary and `sox` for microphone capture. Follow the subsection
for your OS to install the binary and verify your microphone, then run the
shared **Download model & smoke test** step at the end.

#### macOS

Install the `whisper-cpp` bottle (ships a `whisper-cli` with Metal enabled on
Apple Silicon) and `sox`:

```bash
brew install whisper-cpp sox
```

Verify your microphone by recording a 3-second clip and playing it back. The
first `sox -d` invocation triggers a macOS microphone permission prompt —
grant it in **System Settings → Privacy & Security → Microphone**, then rerun.
Remove the temp file once you've heard yourself clearly:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

#### Linux (including WSL2)

Install `sox` with its PulseAudio driver (a separate package on Debian/Ubuntu),
the PulseAudio tools so the plugin can enumerate input devices via `pactl`,
and the build tools for whisper.cpp:

```bash
sudo apt install sox libsox-fmt-pulse pulseaudio-utils build-essential cmake
```

On WSL2, make sure [WSLg](https://learn.microsoft.com/windows/wsl/tutorials/gui-apps)
is running — it bridges the Windows microphone into WSL as a PulseAudio source
(typically named `RDPSource`), which you can then pick with `/stt-mic`.

**WSL2 audio troubleshooting.** There is no `/dev/snd` in WSL2 — that is
normal. Audio goes through WSLg's PulseAudio server at `/mnt/wslg/PulseServer`,
so ALSA-only tools like `arecord -l` will never list a device. If `/stt-mic`
finds no devices or `pactl info` fails with `Connection refused`, WSLg's
PulseAudio is stuck; fix it from Windows PowerShell:

```powershell
wsl --shutdown   # then reopen Ubuntu (closes all WSL sessions)
```

If the source list is still empty after a restart, check Windows
**Settings → Privacy & security → Microphone** and enable both "Microphone
access" and "Let desktop apps access your microphone" (WSLg captures audio via
a desktop RDP client), then run `wsl --update` for the latest WSLg.

Verify your microphone by recording a 3-second clip and playing it back.
Remove the temp file once you've heard yourself clearly; skip building
whisper.cpp until this works, otherwise `/stt-mic` will have nothing to select:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

`whisper-cli` is not packaged for Linux, so build whisper.cpp from source.
Pick **one** of the two builds below.

**CPU build** — works on any machine, adequate for `tiny`/`base`/`small`
models:

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

**CUDA build** — NVIDIA GPU, ~100× faster encode for `medium`/`large` models.
Check your GPU with `nvidia-smi` and your toolkit with `nvcc --version`, then
pick the arch code from the table:

| GPU family    | Arch      | `CMAKE_CUDA_ARCHITECTURES` | Min. CUDA |
| ------------- | --------- | -------------------------- | --------- |
| RTX 20 / T4   | Turing    | `75`                       | 10.0      |
| RTX 30 / A100 | Ampere    | `86`                       | 11.0      |
| RTX 40 / L40  | Ada       | `89`                       | 11.8      |
| H100          | Hopper    | `90`                       | 12.0      |
| RTX 50 / B100 | Blackwell | `120`                      | 13.0      |

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

If you have multiple CUDA toolkits installed (e.g. Blackwell requires CUDA 13
while the default `nvcc` is 12), also pass `-DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.3/bin/nvcc`
to point at the matching `nvcc`. CUDA runtime libraries are resolved via
ldconfig; no `LD_LIBRARY_PATH` is needed.

At runtime the plugin records through sox's `pulseaudio` driver when `pactl`
is available, and falls back to sox's default device otherwise.

#### Download model & smoke test

Download a whisper model to `~/.local/share/whisper-cpp/` (same path on both
OSes):

```bash
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

Smoke-test the install by transcribing a short recording:

```bash
sox -d /tmp/smoke.wav trim 0 4   # say something for 4 seconds
whisper-cli -m ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  -f /tmp/smoke.wav -l auto -nt
rm /tmp/smoke.wav
```

Check the first `system_info:` line in the output to confirm the expected
backend is active:

| Install                        | Expect                  |
| ------------------------------ | ----------------------- |
| macOS Homebrew (Apple Silicon) | `METAL = 1`             |
| Linux CUDA build               | `CUDA : ARCHS = <n>`    |
| CPU-only                       | `METAL = 0` / no `CUDA` |

Reference `encode time` on a 4-second clip: CPU `medium` ≈ 15–30 s; CUDA
`medium` ≈ 100–200 ms; CUDA `large-v3-turbo` ≈ 100–300 ms. Apple Silicon
Metal timings are hardware-dependent but typically sub-second. If your GPU
build shows CPU-level timings, the GPU backend failed to load — on Linux,
re-check `nvidia-smi` and rebuild with the arch code from the table above.

### Text-to-speech

Install [Piper](https://github.com/rhasspy/piper):

```bash
uv tool install piper-tts
```

Or with pip:

```bash
pip install piper-tts
```

The plugin looks for `piper` on your `PATH` (`~/.local/bin` is typically on `PATH`).

Download a voice model to `~/.local/share/piper-voices/`:

```bash
mkdir -p ~/.local/share/piper-voices
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json
```

### LLM backend

Text normalization needs a text-generation model. For speech-to-text it cleans
up whisper output (punctuation, filler words, software engineering homophones).
For text-to-speech it converts markdown into natural spoken text.

Two backends are supported. Explicit `llm` options take precedence over the
legacy top-level fields.

#### OpenCode providers (recommended)

Reuse the providers, models, and credentials already configured in OpenCode. No
API key needs to be repeated in the plugin options.

```jsonc
{
  "plugins": [
    {
      "package": "@mortz.prk/opencode-voice",
      "options": {
        "llm": {
          "type": "opencode",
          "model": { "providerID": "anthropic", "id": "claude-sonnet-4-6" },
        },
      },
    },
  ],
}
```

- `model` _(optional)_ - `providerID`, `id`, and optional `variant`. Omit it to
  use OpenCode's default model
- `timeoutMs` _(optional)_ - request timeout in milliseconds (default `60000`)

Generation settings such as token limits and reasoning effort come from the
OpenCode model configuration. `endpoint`, `maxTokens`, `reasoningEffort`,
`chatTemplateKwargs`, `apiKeyEnv`, and `retries` are rejected under
`llm.type: "opencode"` so the configuration cannot silently diverge from what
OpenCode applies.

#### OpenAI-compatible endpoint

Any OpenAI-compatible endpoint works (Anthropic, OpenAI, Ollama, vLLM, LM Studio,
etc.). The `apiKeyEnv` option is optional - omit it for unauthenticated
endpoints like Ollama.

```jsonc
{
  "plugins": [
    {
      "package": "@mortz.prk/opencode-voice",
      "options": {
        "llm": {
          "type": "openai-compatible",
          "endpoint": "https://api.anthropic.com/v1",
          "model": "claude-haiku-4-5",
          "apiKeyEnv": "ANTHROPIC_API_KEY",
        },
      },
    },
  ],
}
```

For unauthenticated local endpoints (e.g. Ollama):

```jsonc
{
  "plugins": [
    {
      "package": "@mortz.prk/opencode-voice",
      "options": {
        "llm": {
          "type": "openai-compatible",
          "endpoint": "http://localhost:11434/v1",
          "model": "llama3.2",
        },
      },
    },
  ],
}
```

- `endpoint` _(required)_ - OpenAI-compatible base URL
- `model` _(required)_ - model name sent to `/chat/completions`
- `apiKeyEnv` _(optional)_ - environment variable containing the API key
- `maxTokens` _(optional)_ - maximum completion tokens for normalization calls
- `reasoningEffort` _(optional)_ - reasoning level for models that support it
- `chatTemplateKwargs` _(optional)_ - extra keyword arguments passed to the model's chat template (e.g. `{"enable_thinking": false}` for Qwen models to disable chain-of-thought)
- `retries` _(optional)_ - number of retry attempts for transient LLM failures

#### Legacy configuration

Configurations without `llm` keep working: `endpoint`, `model`, `apiKeyEnv`,
`maxTokens`, `reasoningEffort`, `chatTemplateKwargs`, and `retries` at the top
level are treated as the OpenAI-compatible backend. New configurations should
use `llm.type: "openai-compatible"` instead.

#### Other options

- `tmpDir` _(optional)_ - directory used for the temporary STT recording file (default `/tmp`)
- `sttLanguage` _(optional)_ - spoken language passed to local `whisper-cli -l` (default `auto`; any whisper.cpp language code, e.g. `en`, `zh`). Can be changed at runtime via `/stt-language`
- `trimSilence` _(optional)_ - whether to remove leading silence from recordings (default `true`). Set to `false` if your recordings are missing the first word or syllable

### Logging

The plugin writes diagnostics through OpenCode's structured app logger. If this plugin is not working with your setup, check the OpenCode log file and, optionally, enable debug mode. See the [OpenCode Docs](https://opencode.ai/docs/troubleshooting/#logs) for details.

Routine plugin diagnostics use `debug`; recoverable issues use `warn`; failed
child processes, API calls, or unexpected exceptions use `error`.

### STT API transcription (optional)

Instead of local `whisper-cli`, you can use an OpenAI-compatible speech-to-text
API (e.g. serving a Whisper model). This is useful when you want to run the
plugin on a machine without whisper-cpp installed.

```jsonc
{
  "plugins": [
    {
      "package": "@mortz.prk/opencode-voice",
      "options": {
        "sttEndpoint": "http://127.0.0.1:8000/v1",
        "sttModel": "whisper-large-v3-turbo",
        "sttApiKeyEnv": "MY_STT_API_KEY",
      },
    },
  ],
}
```

- `sttEndpoint` _(optional)_ - OpenAI-compatible base URL with `/audio/transcriptions` support
- `sttModel` _(optional)_ - whisper model name to pass to the API (default: `whisper-large-v3-turbo`). Can be changed at runtime via `/stt-model`, which fetches available whisper models from the endpoint's `/models` listing
- `sttApiKeyEnv` _(optional)_ - environment variable containing the API key

OpenRouter note: when `sttEndpoint` points at `https://openrouter.ai/api/v1`, the plugin automatically uses OpenRouter's JSON/base64 transcription request format instead of multipart upload.

### Custom prompts

The LLM system prompts used for normalization can be fully replaced by pointing
to your own prompt files. This lets you fine-tune how transcriptions are cleaned
up or how responses are spoken.

```jsonc
{
  "plugins": [
    {
      "package": "@mortz.prk/opencode-voice",
      "options": {
        "sttPrompt": "~/.config/opencode/stt-prompt.md",
        "ttsAutoPrompt": "~/.config/opencode/tts-auto-prompt.md",
        "ttsManualPrompt": "~/.config/opencode/tts-manual-prompt.md",
      },
    },
  ],
}
```

- `sttPrompt` _(optional)_ - system prompt for cleaning up whisper transcriptions
- `ttsAutoPrompt` _(optional)_ - system prompt for auto-speaking assistant responses
- `ttsManualPrompt` _(optional)_ - system prompt for manually reading responses aloud

If a path is not set, the built-in default prompt is used.

## Commands

### Speech-to-text

| Command         | Keybind    | Description                            |
| --------------- | ---------- | -------------------------------------- |
| `/stt-record`   | `ctrl+r`   | Start/stop recording + transcribe      |
| `/stt-submit`   | `leader+r` | Stop recording, transcribe, and submit |
| `/stt-stop`     |            | Cancel recording                       |
| `/stt-model`    |            | Select whisper model                   |
| `/stt-language` |            | Select transcription language          |
| `/stt-mic`      |            | Select microphone                      |

`/stt-mic` lists CoreAudio input devices on macOS, and PulseAudio sources on
Linux (via `pactl`, monitor sources excluded). On systems without a supported
device listing, "System default" uses sox's default device (`sox -d`).

`/stt-language` offers a curated list of common languages (plus auto-detect)
and only affects local `whisper-cli` transcription, not the STT API. Languages
outside the list can be set via the `sttLanguage` plugin option.

### Text-to-speech

The `leader` key's active chord is `ctrl+x` by default (configurable via
`keybinds.leader` in `cli.json`). So `leader+s` means press `ctrl+x` then `s`.

| Command      | Keybind    | Description              |
| ------------ | ---------- | ------------------------ |
| `/tts-speak` | `leader+s` | Read last response aloud |
| `/tts-mode`  | `leader+v` | Toggle auto TTS on/off   |
| `/tts-stop`  | `escape`   | Stop playback            |
| `/tts-voice` |            | Select TTS voice         |

## How it works

### STT pipeline

1. `sox` records audio from your microphone (CoreAudio on macOS, PulseAudio on
   Linux when `pactl` is available, sox default device otherwise)
2. `whisper-cli` transcribes locally using a ggml model, or an OpenAI-compatible
   API endpoint if `sttEndpoint` is configured
3. LLM normalizes the transcription: fixes punctuation, removes filler words,
   corrects software engineering homophones ("Jason" to "JSON", "bullion" to
   "boolean", etc.)
4. Cleaned text is appended to the OpenCode prompt, or submitted immediately
   when `/stt-submit` is used. If normalization fails (e.g. the configured LLM
   backend is unreachable), the raw transcription is used as a fallback so you
   never lose your input

### TTS pipeline

1. When the assistant finishes responding (or on manual trigger), the response
   text is sent to the LLM for speech normalization
2. The LLM decides how to handle it: narrate simple answers, summarize
   code-heavy responses, or briefly notify for confirmations
3. Piper synthesizes speech locally, piped through sox for playback

### Auto TTS

When enabled (`/tts-mode`), the plugin automatically speaks:

- Assistant responses when a session goes idle after work
- Permission requests
- Questions that need your answer

## Contributing

opencode-voice is open to contributions and ideas!

### Issue conventions

**Format:** `type: brief description`

- `feat:` new features or functionality
- `fix:` bug fixes
- `enhance:` improvements to existing features
- `chore:` maintenance tasks, dependencies, cleanup
- `docs:` documentation updates
- `build:` build system, CI/CD changes

### Development

```bash
npm run check        # lint + fmt
npm run lint         # oxlint
npm run fmt          # oxfmt --check
npm run fmt:fix      # oxfmt --write
```

### Test local plugin in OpenCode

To test unpublished changes in the OpenCode TUI, run `npm run build` first so
`dist/` exists (the package exports `./dist/index.js`), then point
`opencode.jsonc` at the local repo path, not the npm package name:

```jsonc
{
  "plugins": ["/Users/your-user/opencode-voice"],
}
```

V2 discovers local plugins in `.opencode/plugins/` too — symlink or copy the
package there if you prefer that instead of a `plugins` entry.

### Optional macOS Hammerspoon integration

If you use macOS, [Hammerspoon](https://www.hammerspoon.org/), and
[Ghostty](https://ghostty.org/), see
[`examples/hammerspoon/ghostty-fn.lua`](examples/hammerspoon/ghostty-fn.lua)
for an optional global `Fn` key setup.

Behavior:

- Press `Fn` to send `ctrl+r` and start recording.
- Hold `Fn` for at least 0.5 seconds and release to send `leader+r`, which
  stops recording, normalizes, and submits the prompt.

Notes:

- It assumes OpenCode is using the default leader key, `ctrl+x`.
- It assumes OpenCode is running in Ghostty terminal `1`.
- It is best used as a push-to-talk flow: hold `Fn` while speaking, then
  release to submit.
- Adjust `APP_NAME`, `TARGET_TERMINAL`, and `LONG_PRESS_THRESHOLD_SECONDS` to
  fit your setup.

### Release process

Manual releases via opencode; see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## License

This project is licensed under the [MIT License](LICENSE).
