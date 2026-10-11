import { LIMITS } from "../protocol.ts";

/**
 * Errors the page runs into, kept per tab in session storage, so a report
 * can carry the ones from before the dialog opened, even across a reload.
 */

export interface ErrorLog {
  read(): string[];
  add(text: string): void;
  clear(): void;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function errorLog(key: string): ErrorLog {
  const read = (): string[] =>
    safe(() => {
      const stored: unknown = JSON.parse(sessionStorage.getItem(key) || "[]");
      return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
    }, []);
  return {
    read,
    add(text) {
      const entry = `${new Date().toISOString().slice(11, 19)} ${location.pathname} ${text}`.slice(0, LIMITS.error);
      safe(() => sessionStorage.setItem(key, JSON.stringify([...read(), entry].slice(-LIMITS.errors))), undefined);
    },
    clear() {
      safe(() => sessionStorage.removeItem(key), undefined);
    },
  };
}

/** "TypeError: x is undefined" for an Error, the value as text for anything else thrown. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null) return safe(() => JSON.stringify(error), String(error));
  return String(error);
}

/** Keep the page's uncaught errors and unhandled rejections; returns a function that stops. */
export function watchErrors(log: ErrorLog): () => void {
  const onError = (event: ErrorEvent) => {
    if (!event.message) return; // a resource that failed to load, not a script error
    const where = event.filename ? ` (${event.filename.split("/").pop()}:${event.lineno})` : "";
    log.add(event.message + where);
  };
  const onRejection = (event: PromiseRejectionEvent) => log.add(`Unhandled rejection: ${describeError(event.reason)}`);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
