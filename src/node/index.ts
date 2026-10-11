import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendReport, type RelayTarget, type SendResult } from "../client.ts";
import { LIMITS, isObject, parseReport, type Parsed, type Report } from "../protocol.ts";

/**
 * For apps that run on the person's own machine, like a local server with a
 * web UI: an outbox that holds reports while the relay can't take them, and
 * the facts only such a server knows (its OS, its log). Node only.
 */

export interface OutboxOptions extends RelayTarget {
  /** Where waiting reports are kept, one JSON file each. */
  dir: string;
}

export interface Outbox {
  /** Check a report, then send it, or keep it when the relay can't take it right now. */
  submit(report: Report): Promise<SendResult>;
  /** Send what the outbox holds, oldest first; resolves to how many went. */
  flush(): Promise<number>;
  /** How many reports are waiting. */
  size(): number;
  /**
   * Retry the outbox now and then, without keeping the process alive for it:
   * soon after starting, then every half hour unless told otherwise.
   * Returns a function that stops it.
   */
  startRetrying(options?: { firstMs?: number; everyMs?: number }): () => void;
}

/**
 * Images as JSON carries them in an outbox file, base64, turned back into
 * bytes. Anything else passes through for parseReport to refuse in its own
 * words.
 */
function decodeImages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((img) =>
    isObject(img) && typeof img.data === "string" ? { type: img.type, data: Buffer.from(img.data, "base64") } : img
  );
}

export function createOutbox(options: OutboxOptions): Outbox {
  const { dir } = options;
  let flushing: Promise<number> | null = null;

  function files(): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  function queue(report: Report): void {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${report.id}.json`);
    const images = report.images.map((img) => ({ type: img.type, data: Buffer.from(img.data).toString("base64") }));
    // Written aside and renamed in, so a flush never reads half a report.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...report, images }));
    fs.renameSync(`${file}.tmp`, file);
  }

  async function flushOnce(): Promise<number> {
    const waiting = files()
      .map((file) => ({ file, mtime: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .sort((a, b) => a.mtime - b.mtime);
    let sent = 0;
    for (const { file } of waiting) {
      let parsed: Parsed;
      try {
        const stored: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        parsed = parseReport(isObject(stored) ? { ...stored, images: decodeImages(stored.images) } : stored);
      } catch {
        parsed = { ok: false, error: "unreadable" };
      }
      if (!parsed.ok) {
        console.warn(`Dropping a queued feedback report the relay would refuse: ${parsed.error}`);
        fs.rmSync(file, { force: true });
        continue;
      }
      const outcome = await sendReport(parsed.report, options);
      if (outcome === "retry") break; // still unreachable; the rest wait too
      if (outcome !== "sent") console.warn(`The relay refused a queued feedback report: ${outcome.refused}`);
      fs.rmSync(file, { force: true });
      if (outcome === "sent") sent++;
    }
    return sent;
  }

  function flush(): Promise<number> {
    flushing ??= flushOnce().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  return {
    async submit(report) {
      const checked = parseReport(report);
      if (!checked.ok) return { status: "refused", error: checked.error };
      const outcome = await sendReport(checked.report, options);
      if (outcome === "sent") {
        // The relay is reachable again: a good moment for anything waiting.
        if (files().length) void flush().catch(() => {});
        return { status: "sent" };
      }
      if (outcome === "retry") {
        queue(checked.report);
        return { status: "queued" };
      }
      return { status: "refused", error: outcome.refused };
    },

    flush,

    size: () => files().length,

    startRetrying({ firstMs = 30_000, everyMs = 30 * 60_000 } = {}) {
      const tick = () => void flush().catch(() => {});
      const first = setTimeout(tick, firstMs).unref();
      const every = setInterval(tick, everyMs).unref();
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    },
  };
}

/** "macOS (Darwin 25.6.0, arm64)": the name a person knows, and the version that pins it down. */
export function describeOs(
  platform: NodeJS.Platform = process.platform,
  release = os.release(),
  arch: string = process.arch
): string {
  const names: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
  return `${names[platform] ?? platform} (${platform === "darwin" ? "Darwin " : ""}${release}, ${arch})`;
}

/** The last bytes of a file, from the first whole line in them. */
function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export interface LogTailOptions {
  /** Shown as ~, so a report doesn't carry the account name. The home folder unless set; "" to keep paths. */
  home?: string;
  /** Lines kept from each log; 40 unless set. */
  lines?: number;
  /** Longer lines are cut; 300 characters unless set. */
  lineChars?: number;
}

/**
 * The last lines of each log, under its name, in a form a report can carry.
 * Missing logs are skipped; null when none has any lines.
 */
export function logTail(files: string[], options: LogTailOptions = {}): string | null {
  const { home = os.homedir(), lines: keep = 40, lineChars = 300 } = options;
  const parts: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readTail(file, Math.max(16 * 1024, keep * (lineChars + 1) * 4));
    } catch {
      continue;
    }
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-keep)
      .map((line) => (line.length > lineChars ? `${line.slice(0, lineChars)}…` : line));
    if (lines.length) parts.push(`== ${path.basename(file)} ==\n${lines.join("\n")}`);
  }
  if (!parts.length) return null;
  const joined = home ? parts.join("\n\n").split(home).join("~") : parts.join("\n\n");
  return joined.length > LIMITS.logs ? joined.slice(-LIMITS.logs) : joined;
}
