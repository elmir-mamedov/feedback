/**
 * The report format: what a client sends a relay, checked field by field.
 * Both sides import this file, so a client refuses exactly what the relay
 * would, before anything leaves. Nothing here touches the network or a
 * particular runtime; it runs in browsers, Node and Workers alike.
 *
 * The protocol version lives in the URL a report is posted to
 * (/v1/<app>/reports), not in the report. Within a version every change is
 * additive: a new optional field, or a looser limit once the relay has it.
 * Never a renamed, removed or newly required field, and never a tighter
 * limit. Anything else is a new version, and a relay keeps serving every
 * version it ever served, so an app built against an old one keeps working.
 */

/** The protocol version this file describes. */
export const PROTOCOL = 1;

/** Kinds a dialog offers unless told otherwise; each becomes an issue label. */
export const DEFAULT_KINDS = ["bug", "idea", "question"] as const;

/** Image types a report may carry, and the extension each is stored under. */
export const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;
export type ImageType = keyof typeof IMAGE_TYPES;

export const LIMITS = {
  message: 10_000,
  email: 254,
  images: 5,
  imageBytes: 2 * 1024 * 1024,
  totalImageBytes: 6 * 1024 * 1024,
  version: 100,
  facts: 20,
  factName: 40,
  factValue: 500,
  errors: 10,
  error: 1_000,
  logs: 20_000,
} as const;

/**
 * The largest request body a valid report can make: its images, and room for
 * its text at the worst JSON escaping (six characters for one), plus the
 * multipart framing around it all.
 */
export const MAX_BODY_BYTES =
  LIMITS.totalImageBytes +
  6 *
    (LIMITS.message +
      LIMITS.email +
      LIMITS.version +
      LIMITS.facts * (LIMITS.factName + LIMITS.factValue) +
      LIMITS.errors * LIMITS.error +
      LIMITS.logs) +
  64 * 1024;

export interface ReportImage {
  type: ImageType;
  data: Uint8Array;
}

/** Short facts shown as a table in the issue, in order: { OS: "macOS 15.1", ... }. */
export type Facts = Record<string, string>;

export interface Report {
  /** Chosen by the sender, so a retried report lands on the same image paths. */
  id: string;
  /** A short slug, such as "bug"; the relay checks it against the app's kinds. */
  kind: string;
  message: string;
  /** Where a reply can go, when the person gave one. */
  email?: string;
  images: ReportImage[];
  /** The app's version, shown beside its name. */
  version?: string;
  facts: Facts;
  /** Errors the app ran into before the report, newest last. */
  errors?: string[];
  /** A log tail, when the person chose to include one. */
  logs?: string;
}

export type Parsed = { ok: true; report: Report } | { ok: false; error: string };

/** An app's id on a relay, which is part of the URL reports are posted to. */
export const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Where a client posts `app`'s reports on the relay at `relay`. */
export function reportsUrl(relay: string, app: string): string {
  return `${relay.replace(/\/+$/, "")}/v${PROTOCOL}/${encodeURIComponent(app)}/reports`;
}

/** A fresh report id. crypto.randomUUID needs a secure context; this works on plain http too. */
export function newReportId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function startsWith(data: Uint8Array, bytes: number[], at = 0): boolean {
  return data.length >= at + bytes.length && bytes.every((byte, i) => data[at + i] === byte);
}

/** How each image type starts, to turn away a file that only claims to be one. */
const SIGNATURES: Record<ImageType, (data: Uint8Array) => boolean> = {
  "image/png": (data) => startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (data) => startsWith(data, [0xff, 0xd8, 0xff]),
  "image/gif": (data) => startsWith(data, [0x47, 0x49, 0x46, 0x38]),
  "image/webp": (data) => startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8),
};

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") fail(`${name} must be text.`);
  if (value.length > max) fail(`${name} is longer than ${max} characters.`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, name, max);
}

function image(value: unknown, index: number): ReportImage {
  const name = `Image ${index + 1}`;
  if (!isObject(value) || !(value.data instanceof Uint8Array) || !value.data.length) fail(`${name} is malformed.`);
  if (typeof value.type !== "string" || !Object.hasOwn(IMAGE_TYPES, value.type)) {
    fail(`${name} must be a PNG, JPEG, WebP or GIF.`);
  }
  const type = value.type as ImageType;
  if (value.data.length > LIMITS.imageBytes) fail(`${name} is larger than 2 MB.`);
  if (!SIGNATURES[type](value.data)) fail(`${name} isn't the ${IMAGE_TYPES[type].toUpperCase()} it claims to be.`);
  return { type, data: value.data };
}

/** Facts with empty values dropped. Built with fromEntries so a "__proto__" name stays a plain fact. */
function facts(value: unknown): Facts {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) fail("Facts are malformed.");
  const entries = Object.entries(value);
  if (entries.length > LIMITS.facts) fail(`A report carries at most ${LIMITS.facts} facts.`);
  const kept: [string, string][] = [];
  for (const [name, fact] of entries) {
    if (!name.trim() || name.length > LIMITS.factName) fail(`A fact's name must be 1 to ${LIMITS.factName} characters.`);
    const checked = optionalText(fact, `The fact "${name}"`, LIMITS.factValue);
    if (checked !== undefined) kept.push([name, checked]);
  }
  return Object.fromEntries(kept);
}

function errors(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > LIMITS.errors) fail(`A report carries at most ${LIMITS.errors} errors.`);
  const checked = value.map((entry) => text(entry, "An error", LIMITS.error));
  return checked.length ? checked : undefined;
}

/**
 * Check an untrusted report, its images as bytes. A refusal says what to fix,
 * for the sender to show. Fields this version doesn't know are dropped.
 */
export function parseReport(body: unknown): Parsed {
  try {
    if (!isObject(body)) fail("The report is malformed.");
    if (typeof body.id !== "string" || !UUID.test(body.id)) fail("The report id is malformed.");
    if (typeof body.kind !== "string" || !KIND.test(body.kind)) fail("The kind is malformed.");
    const message = text(body.message, "The message", LIMITS.message);
    if (!message.trim()) fail("The message is empty.");
    const email = optionalText(body.email, "The email address", LIMITS.email)?.trim();
    if (email && !EMAIL.test(email)) fail("The email address doesn't look right.");
    const rawImages = body.images ?? [];
    if (!Array.isArray(rawImages)) fail("Images are malformed.");
    if (rawImages.length > LIMITS.images) fail(`A report carries at most ${LIMITS.images} images.`);
    const images = rawImages.map(image);
    const total = images.reduce((sum, img) => sum + img.data.length, 0);
    if (total > LIMITS.totalImageBytes) fail("The images add up to more than 6 MB.");
    return {
      ok: true,
      report: {
        id: body.id,
        kind: body.kind,
        message,
        email: email || undefined,
        images,
        version: optionalText(body.version, "The version", LIMITS.version),
        facts: facts(body.facts),
        errors: errors(body.errors),
        logs: optionalText(body.logs, "The log", LIMITS.logs),
      },
    };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * A report as it travels: multipart, its text as JSON in a "report" field and
 * each image as an "image" file, in order. Raw bytes, not base64 inside JSON:
 * parsing megabytes of JSON costs a Worker far more CPU than the runtime's own
 * multipart parser does.
 */
export function reportForm(report: Report): FormData {
  const { images, ...text } = report;
  const form = new FormData();
  form.append("report", JSON.stringify(text));
  images.forEach((img, i) => {
    form.append("image", new Blob([img.data as Uint8Array<ArrayBuffer>], { type: img.type }), `${i + 1}.${IMAGE_TYPES[img.type]}`);
  });
  return form;
}

/** The report a reportForm() body carries, checked. */
export async function readReportForm(form: FormData): Promise<Parsed> {
  const text = form.get("report");
  let body: unknown;
  try {
    body = typeof text === "string" ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!isObject(body)) return { ok: false, error: "The report is malformed." };
  const images = await Promise.all(
    form
      .getAll("image")
      .map(async (file) =>
        typeof file === "string" ? file : { type: file.type, data: new Uint8Array(await file.arrayBuffer()) }
      )
  );
  return parseReport({ ...body, images });
}

/**
 * The report in a reportForm() request body, checked: for an app's own
 * server, when its dialog sends reports there rather than to the relay.
 */
export async function readReportBody(body: Uint8Array | ArrayBuffer | string, contentType: string): Promise<Parsed> {
  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return { ok: false, error: "The report is malformed." };
  }
  return readReportForm(form);
}
