import assert from "node:assert/strict";
import test from "node:test";
import { sendTranscription } from "../dist/lib/stt.js";

function fixture(route = { type: "home" }, confirmed = true) {
  const calls = [];
  const ctx = {
    location: { directory: "/project" },
    data: { location: { default: () => ({ directory: "/default" }) } },
    ui: {
      router: {
        current: () => route,
        navigate: (destination) => calls.push(["navigate", destination]),
      },
      model: {
        current: () => ({ providerID: "litellm", modelID: "Fast", variant: "low" }),
      },
      dialog: { confirm: async () => confirmed },
    },
    client: {
      session: {
        create: async (input) => {
          calls.push(["create", input]);
          return { id: "new-session" };
        },
        prompt: async (input) => calls.push(["prompt", input]),
      },
    },
  };
  return { ctx, calls };
}

test("voice input creates and opens a session from home using the selected model", async () => {
  const { ctx, calls } = fixture();
  assert.equal(await sendTranscription(ctx, "Hello", true, () => {}), true);
  assert.deepEqual(calls, [
    [
      "create",
      {
        location: { directory: "/project" },
        model: { providerID: "litellm", id: "Fast", variant: "low" },
      },
    ],
    ["navigate", { type: "session", sessionID: "new-session" }],
    ["prompt", { sessionID: "new-session", text: "Hello" }],
  ]);
});

test("voice input submits to the active session without creating another", async () => {
  const { ctx, calls } = fixture({ type: "session", sessionID: "existing" });
  await sendTranscription(ctx, "Hello", true, () => {});
  assert.deepEqual(calls, [["prompt", { sessionID: "existing", text: "Hello" }]]);
});

test("cancelling review creates no session and submits nothing", async () => {
  const { ctx, calls } = fixture({ type: "home" }, false);
  const toasts = [];
  assert.equal(await sendTranscription(ctx, "Hello", false, (text) => toasts.push(text)), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(toasts, ["Transcription cancelled"]);
});

test("session creation uses default location and model when no model is selected", async () => {
  const { ctx, calls } = fixture();
  ctx.location = undefined;
  ctx.ui.model.current = () => undefined;
  await sendTranscription(ctx, "Hello", false, () => {});
  assert.deepEqual(calls[0], ["create", { location: { directory: "/default" } }]);
});

test("voice input on a plugin route does not create an unrelated session", async () => {
  const { ctx, calls } = fixture({ type: "plugin" });
  await assert.rejects(
    sendTranscription(ctx, "Hello", true, () => {}),
    /Open a session/,
  );
  assert.deepEqual(calls, []);
});

test("session creation failures propagate without submitting", async () => {
  const { ctx, calls } = fixture();
  ctx.client.session.create = async () => {
    throw new Error("create failed");
  };
  await assert.rejects(
    sendTranscription(ctx, "Hello", true, () => {}),
    /create failed/,
  );
  assert.deepEqual(calls, []);
});
