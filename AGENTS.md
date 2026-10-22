# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single V2 CLI plugin via `Plugin.define({ id, setup })` in `index.js`. No server-side plugin.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
- Configuration uses `ctx.options` (static) and `ctx.storage` (runtime, `storage.store` reactive store). No dotfile I/O.
- No build step. Plain ESM JavaScript, shipped as-is.
- Audio/whisper/Piper logic lives in `lib/` and is OpenCode-API-agnostic; only `lib/session.js` and the `registerSTT`/`registerTTS` wiring touch the V2 context.

## Scripts

```bash
npm run test         # node --test
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, test, build). See
RELEASE_PROCESS.md for release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
