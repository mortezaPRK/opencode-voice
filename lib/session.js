// Shared session helpers for the OpenCode V2 CLI plugin.

/**
 * Get the currently focused session ID from the router. Returns null when the
 * view is not a session (e.g. home).
 */
export function getActiveSessionID(ctx) {
  try {
    const route = ctx.ui.router.current();
    if (route && route.type === "session" && route.sessionID) return route.sessionID;
  } catch {
    // Router not available yet or not mounted.
  }
  return null;
}

/**
 * Get the title of a specific session by ID. Returns "" if unknown or on error.
 */
export async function getSessionTitle(ctx, sessionID) {
  if (!sessionID) return "";
  try {
    let session = ctx.data.session.get(sessionID);
    if (!session) {
      await ctx.data.session.sync(sessionID).catch(() => {});
      session = ctx.data.session.get(sessionID);
    }
    return session?.title || "";
  } catch {
    return "";
  }
}

/**
 * Get the title of the currently focused session. Returns "" on error or when
 * there is no active session route.
 */
export function getActiveSessionTitle(ctx) {
  const id = getActiveSessionID(ctx);
  if (!id) return "";
  return getSessionTitle(ctx, id);
}

/**
 * Resolve the trailing assistant turn's text for a session. Returns
 * { lastMessageID, text } or null.
 */
export async function getTurnAssistantText(ctx, sessionID) {
  if (!sessionID) return null;

  try {
    await ctx.data.session.message.sync(sessionID).catch(() => {});
    const messages = ctx.data.session.message.list(sessionID);
    if (!messages || messages.length === 0) return null;

    const assistantIDs = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") break;
      if (messages[i].role === "assistant") {
        assistantIDs.unshift(messages[i].id);
      }
    }
    if (assistantIDs.length === 0) return null;

    const allText = [];
    for (const msgID of assistantIDs) {
      let msg;
      try {
        await ctx.data.session.message.sync(sessionID).catch(() => {});
        msg = ctx.data.session.message.get(sessionID, msgID);
      } catch {
        continue;
      }
      const textParts = (msg?.parts || []).filter((p) => p.type === "text");
      const text = textParts
        .map((p) => p.text || "")
        .join("\n\n")
        .trim();
      if (text) allText.push(text);
    }

    if (allText.length === 0) return null;

    return {
      lastMessageID: assistantIDs[assistantIDs.length - 1],
      text: allText.join("\n\n"),
    };
  } catch {
    return null;
  }
}
