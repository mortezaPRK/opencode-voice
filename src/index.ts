// opencode-voice server entry.
//
// The voice features are a V2 CLI plugin and live in `src/tui.ts`, exported as
// `./tui`. The server entry is intentionally empty so packages configured under
// `plugins` load cleanly on both sides; a CLI-only package must still expose a
// valid server entry.

import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "opencode-voice",
  setup() {},
});
