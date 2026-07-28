/**
 * Structured logging helpers.
 *
 * Only bounded, non-sensitive diagnostic values may be logged. Raw user
 * expressions, sample text, metadata bodies, secrets and sandbox file contents
 * must never be passed to these functions — log hashes instead.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const MAX_FIELD_LENGTH = 200;

function sanitize(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > MAX_FIELD_LENGTH) {
      out[key] = `${value.slice(0, MAX_FIELD_LENGTH)}…`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const record = {
    level,
    event,
    time: new Date().toISOString(),
    ...sanitize(fields),
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
};
