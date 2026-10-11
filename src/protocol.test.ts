import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  MAX_BODY_BYTES,
  newReportId,
  parseReport,
  readReportForm,
  reportForm,
  reportsUrl,
  type Report,
} from "./protocol.ts";
import { PNG, WEBP, body, fakeImage } from "./test-fixtures.ts";

const png = { type: "image/png", data: PNG };

function parsed(overrides: Record<string, unknown> = {}): Report {
  const result = parseReport(body({ images: [png], ...overrides }));
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.report;
}

function refusal(overrides: Record<string, unknown>): string {
  const result = parseReport(body({ images: [png], ...overrides }));
  assert.equal(result.ok, false);
  return result.ok ? "" : result.error;
}

test("reports for an app go to its path under the protocol version", () => {
  assert.equal(reportsUrl("https://relay.test", "fitness"), "https://relay.test/v1/fitness/reports");
  assert.equal(reportsUrl("https://relay.test/", "kb25"), "https://relay.test/v1/kb25/reports");
});

test("a fresh id is a v4 uuid, with or without randomUUID", () => {
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(newReportId(), v4);
  // As on a page served over plain http, where randomUUID isn't offered.
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    assert.match(newReportId(), v4);
  } finally {
    delete (crypto as { randomUUID?: unknown }).randomUUID;
  }
});

test("a well-formed report parses, blanks dropped", () => {
  const report = parsed({ email: "  ", version: "", errors: [], logs: "", facts: { OS: "macOS", Page: "" } });
  assert.equal(report.kind, "bug");
  assert.equal(report.email, undefined);
  assert.equal(report.version, undefined);
  assert.equal(report.errors, undefined);
  assert.equal(report.logs, undefined);
  assert.deepEqual(report.facts, { OS: "macOS" });
  assert.equal(report.images.length, 1);
});

test("only the message, kind and id are required", () => {
  const report = parsed({ email: undefined, version: undefined, facts: undefined, images: undefined });
  assert.deepEqual(report.images, []);
  assert.deepEqual(report.facts, {});
});

test("facts keep their order, and a __proto__ name stays a plain fact", () => {
  const report = parsed({ facts: JSON.parse('{"Zed":"1","Alpha":"2","__proto__":"3"}') });
  assert.deepEqual(Object.keys(report.facts), ["Zed", "Alpha", "__proto__"]);
  assert.equal(Object.getPrototypeOf(report.facts), Object.prototype);
  assert.equal(JSON.parse(JSON.stringify(report.facts)).__proto__, "3");
});

test("fields this version doesn't know are dropped", () => {
  assert.equal((parsed({ mood: "grumpy" }) as unknown as Record<string, unknown>).mood, undefined);
});

test("refusals say what is wrong", () => {
  assert.match(refusal({ id: "../../etc" }), /id/);
  assert.match(refusal({ kind: "Rant!" }), /kind/);
  assert.match(refusal({ kind: "x".repeat(33) }), /kind/);
  assert.match(refusal({ message: "  \n " }), /empty/);
  assert.match(refusal({ message: "x".repeat(LIMITS.message + 1) }), /longer than/);
  assert.match(refusal({ email: "not an address" }), /email/);
  assert.match(refusal({ version: "v".repeat(LIMITS.version + 1) }), /version/);
  assert.match(refusal({ facts: ["OS"] }), /Facts are malformed/);
  assert.match(refusal({ facts: { " ": "x" } }), /name/);
  assert.match(refusal({ facts: { ["n".repeat(LIMITS.factName + 1)]: "x" } }), /name/);
  assert.match(refusal({ facts: { OS: 15 } }), /"OS" must be text/);
  assert.match(refusal({ facts: { OS: "x".repeat(LIMITS.factValue + 1) } }), /"OS" is longer/);
  const many = Object.fromEntries(Array.from({ length: LIMITS.facts + 1 }, (_, i) => [`F${i}`, "x"]));
  assert.match(refusal({ facts: many }), /at most 20 facts/);
  assert.match(refusal({ errors: Array(LIMITS.errors + 1).fill("e") }), /at most 10 errors/);
  assert.match(refusal({ errors: ["x".repeat(LIMITS.error + 1)] }), /error is longer/);
  assert.match(refusal({ logs: "x".repeat(LIMITS.logs + 1) }), /log is longer/);
  assert.match(refusal({ images: [{ type: "image/svg+xml", data: PNG }] }), /PNG, JPEG, WebP or GIF/);
  assert.match(refusal({ images: [{ type: "image/png", data: "iVBORw0KGgo=" }] }), /malformed/);
  assert.match(refusal({ images: [{ type: "image/png", data: new Uint8Array() }] }), /malformed/);
  assert.match(refusal({ images: [{ type: "image/jpeg", data: PNG }] }), /isn't the JPG it claims to be/);
  assert.match(refusal({ images: [{ type: "image/webp", data: fakeImage(WEBP.subarray(0, 4), 12) }] }), /WEBP/);
  assert.match(refusal({ images: Array(LIMITS.images + 1).fill(png) }), /at most/);
  assert.equal(parseReport("a string").ok, false);
  assert.equal(parseReport(null).ok, false);
});

test("image size is limited per image and in total", () => {
  const justOver = fakeImage(PNG, LIMITS.imageBytes + 1);
  assert.match(refusal({ images: [{ type: "image/png", data: justOver }] }), /larger than 2 MB/);
  const big = { type: "image/png", data: fakeImage(PNG, LIMITS.imageBytes) };
  assert.equal(parseReport(body({ images: [big, big, big] })).ok, true);
  assert.match(refusal({ images: [big, big, big, png] }), /more than 6 MB/);
});

test("the largest valid report fits the body limit", async () => {
  const big = { type: "image/png", data: fakeImage(PNG, LIMITS.imageBytes) };
  // Control characters are what JSON escapes the longest.
  const worst = (length: number) => "\u0001".repeat(length);
  const report = parsed({
    images: [big, big, big],
    message: worst(LIMITS.message),
    email: `${"a".repeat(LIMITS.email - 6)}@ex.co`,
    version: worst(LIMITS.version),
    facts: Object.fromEntries(
      Array.from({ length: LIMITS.facts }, (_, i) => [`${i}`.padEnd(LIMITS.factName, "\u0001"), worst(LIMITS.factValue)])
    ),
    errors: Array(LIMITS.errors).fill(worst(LIMITS.error)),
    logs: worst(LIMITS.logs),
  });
  const bytes = (await new Response(reportForm(report)).arrayBuffer()).byteLength;
  assert.ok(bytes <= MAX_BODY_BYTES, `${bytes} > ${MAX_BODY_BYTES}`);
});

test("a report survives the trip as multipart, images in order and byte for byte", async () => {
  const report = parsed({ images: [png, { type: "image/webp", data: WEBP }], errors: ["TypeError"], logs: "ready" });
  // Through real multipart bytes, as the relay receives it.
  const received = await new Response(reportForm(report)).formData();
  const back = await readReportForm(received);
  assert.ok(back.ok);
  assert.deepEqual(back.report, report);
});

test("a multipart body without its report text, or with a text image, is refused", async () => {
  assert.deepEqual(await readReportForm(new FormData()), { ok: false, error: "The report is malformed." });
  const textImage = new FormData();
  textImage.append("report", JSON.stringify(body()));
  textImage.append("image", "not a file");
  const result = await readReportForm(textImage);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /Image 1 is malformed/);
});
