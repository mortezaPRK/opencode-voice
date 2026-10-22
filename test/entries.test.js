import assert from "node:assert/strict";
import test from "node:test";

test("server entry is a no-op plugin", async () => {
  const plugin = (await import("../dist/index.js")).default;

  assert.equal(plugin.id, "opencode-voice");
  assert.equal(typeof plugin.setup, "function");
  await plugin.setup();
});

test("tui entry exposes the CLI plugin", async () => {
  const plugin = (await import("../dist/tui.js")).default;

  assert.equal(plugin.id, "opencode-voice");
  assert.equal(typeof plugin.setup, "function");
});
