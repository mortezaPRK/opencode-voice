import type { Logger, LogLevel } from "../types.js";

interface AppLogger {
  app?: {
    log?: (input: {
      body: { service: string; level: string; message: string; extra: { scope: string } };
    }) => Promise<unknown>;
  };
}

export function createLogger(client: unknown): Logger {
  async function log(scope: string, message: string, level: LogLevel = "debug"): Promise<void> {
    try {
      await (client as AppLogger | undefined)?.app?.log?.({
        body: {
          service: "opencode-voice",
          level,
          message,
          extra: { scope },
        },
      });
    } catch {
      // Logging should never interrupt voice features.
    }
  }

  return { log };
}
