# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single V2 CLI plugin. TypeScript source in `src/` (`src/index.ts` +
`src/lib/*.ts`), compiled with `tsc` to `dist/`. The published package ships
`dist/` (`exports` -> `./dist/index.js`).

## Key invariants

- Single V2 CLI plugin via `Plugin.define({ id, setup })` in `src/index.ts`. No server-side plugin.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
- Configuration uses `ctx.options` (static) and `ctx.storage` (runtime, `storage.store` reactive store). No dotfile I/O.
- TypeScript source is compiled to `dist/` with `tsc`; `dist/` is generated, not committed.
- Audio/whisper/Piper logic lives in `src/lib/` and is OpenCode-API-agnostic; only `src/lib/session.ts` and the `registerSTT`/`registerTTS` wiring touch the V2 context.
- Register keymap commands from an `app` slot render, not bare `setup` (calling `ctx.keymap.layer` in `setup` throws `Keymap.Provider is missing`).

## Scripts

```bash
npm run build        # tsc (src -> dist)
npm run typecheck    # tsc --noEmit
npm run test         # builds, then node --test (imports dist/)
npm run check         # lint + fmt + typecheck
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors, then `npm test`.

CI runs on every PR (`checks.yml`: install, test, lint, typecheck) and releases
via `publish.yml`. See RELEASE_PROCESS.md for release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **TypeScript** - strict mode; `tsc` emits `dist/`
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
