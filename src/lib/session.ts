import type { Context } from "../types.js";

interface MessageLike {
  id: string;
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
}

export function getActiveSessionID(ctx: Context): string | null {
  try {
    const route = ctx.ui.router.current() as { type?: string; sessionID?: string } | undefined;
    if (route?.type === "session" && route.sessionID) return route.sessionID;
  } catch {
    // Router not available yet or not mounted.
  }
  return null;
}

/**
 * Get the title of a specific session by ID. Returns "" if unknown or on error.
 */
export async function getSessionTitle(ctx: Context, sessionID: string | null): Promise<string> {
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
export async function getActiveSessionTitle(ctx: Context): Promise<string> {
  const id = getActiveSessionID(ctx);
  if (!id) return "";
  return getSessionTitle(ctx, id);
}

/**
 * Resolve the trailing assistant turn's text for a session.
 */
export async function getTurnAssistantText(
  ctx: Context,
  sessionID: string | null,
): Promise<{ lastMessageID: string; text: string } | null> {
  if (!sessionID) return null;

  try {
    await ctx.data.session.message.sync(sessionID).catch(() => {});
    const messages = ctx.data.session.message.list(sessionID) as unknown as
      | MessageLike[]
      | undefined;
    if (!messages || messages.length === 0) return null;

    const assistantIDs: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") break;
      if (messages[i].role === "assistant") {
        assistantIDs.unshift(messages[i].id);
      }
    }
    if (assistantIDs.length === 0) return null;

    const allText: string[] = [];
    for (const msgID of assistantIDs) {
      let msg: MessageLike | undefined;
      try {
        await ctx.data.session.message.sync(sessionID).catch(() => {});
        msg = ctx.data.session.message.get(sessionID, msgID) as unknown as MessageLike | undefined;
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
