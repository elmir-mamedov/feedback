import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutbox, describeOs, logTail } from "./index.ts";
import { newReportId, parseReport, readReportBody, reportForm, type Report } from "../protocol.ts";
import { PNG, body } from "../test-fixtures.ts";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * A fetch that answers with `answers` in turn (the last one repeats),
 * recording each report it was sent, images as bytes.
 */
function fakeRelay(...answers: (Response | Error)[]) {
  const reports: Report[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const encoded = new Response(init?.body);
    const parsed = await readReportBody(await encoded.arrayBuffer(), encoded.headers.get("content-type")!);
    if (!parsed.ok) throw new Error(`the fake relay got a bad report: ${parsed.error}`);
    reports.push(parsed.report);
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    if (answer instanceof Error) throw answer;
    return answer.clone();
  }) as typeof fetch;
  return { impl, reports };
}

const created = () => new Response(JSON.stringify({ ok: true, issue: 1 }), { status: 201 });
const refused = (error: string) => new Response(JSON.stringify({ error }), { status: 400 });

function outbox(fetchImpl: typeof fetch) {
  return createOutbox({ relay: "https://relay.test", app: "kb25", dir: path.join(dir, "outbox"), fetch: fetchImpl });
}

function report(overrides: Record<string, unknown> = {}): Report {
  const parsed = parseReport(body({ id: newReportId(), images: [{ type: "image/png", data: PNG }], ...overrides }));
  assert.ok(parsed.ok);
  return parsed.report;
}

const queued = async () => (await fs.readdir(path.join(dir, "outbox")).catch(() => [] as string[])).sort();

test("a report the relay takes is sent and not kept", async () => {
  const relay = fakeRelay(created());
  const sent = report();
  assert.deepEqual(await outbox(relay.impl).submit(sent), { status: "sent" });
  assert.deepEqual(relay.reports, [sent]);
  assert.deepEqual(await queued(), []);
});

test("a report the relay would refuse is refused here, unsent and unqueued", async () => {
  const relay = fakeRelay(created());
  const result = await outbox(relay.impl).submit({ ...report(), message: "   " });
  assert.deepEqual(result, { status: "refused", error: "The message is empty." });
  assert.equal(relay.reports.length, 0);
  assert.deepEqual(await queued(), []);
});

test("the relay's own refusal reaches the person, and nothing is queued", async () => {
  const box = outbox(fakeRelay(refused("The kind must be one of: bug.")).impl);
  assert.deepEqual(await box.submit(report()), { status: "refused", error: "The kind must be one of: bug." });
  assert.deepEqual(await queued(), []);
});

test("offline, rate-limited or a relay failure: the report waits in the outbox", async () => {
  const relay = fakeRelay(
    new TypeError("fetch failed"),
    new Response("{}", { status: 429 }),
    new Response("{}", { status: 502 })
  );
  const box = outbox(relay.impl);
  const reports = [report(), report(), report()];
  for (const r of reports) assert.deepEqual(await box.submit(r), { status: "queued" });
  assert.deepEqual(await queued(), reports.map((r) => `${r.id}.json`).sort());
  assert.equal(box.size(), 3);
});

test("a flush sends the outbox oldest first, the same reports byte for byte", async () => {
  const relay = fakeRelay(new TypeError("fetch failed"), new TypeError("fetch failed"), created());
  const box = outbox(relay.impl);
  const first = report({ message: "first" });
  const second = report({ message: "second" });
  await box.submit(first);
  await new Promise((resolve) => setTimeout(resolve, 15)); // distinct mtimes
  await box.submit(second);

  assert.equal(await box.flush(), 2);
  assert.deepEqual(relay.reports.slice(2), [first, second]);
  assert.deepEqual(await queued(), []);
});

test("a flush stops at the first report that still can't go, and drops refused ones", async (t) => {
  t.mock.method(console, "warn", () => {});
  const relay = fakeRelay(
    new TypeError("fetch failed"),
    new TypeError("fetch failed"),
    refused("The report id is malformed."),
    new TypeError("fetch failed")
  );
  const box = outbox(relay.impl);
  await box.submit(report({ message: "first" }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = report({ message: "second" });
  await box.submit(second);
  assert.equal(await box.flush(), 0);
  // The first was refused and dropped; the second is still unreachable and kept.
  assert.deepEqual(await queued(), [`${second.id}.json`]);
});

test("a broken outbox file is dropped rather than retried forever", async (t) => {
  t.mock.method(console, "warn", () => {});
  await fs.mkdir(path.join(dir, "outbox"));
  await fs.writeFile(path.join(dir, "outbox", "junk.json"), "{not json");
  assert.equal(await outbox(fakeRelay(created()).impl).flush(), 0);
  assert.deepEqual(await queued(), []);
});

test("a successful send also flushes what was waiting", async () => {
  const relay = fakeRelay(new TypeError("fetch failed"), created());
  const box = outbox(relay.impl);
  await box.submit(report({ message: "queued" }));
  await box.submit(report({ message: "fresh" }));
  await box.flush(); // joins the flush the send started
  assert.deepEqual(
    relay.reports.map((r) => r.message),
    ["queued", "fresh", "queued"]
  );
  assert.deepEqual(await queued(), []);
});

test("retrying can be stopped", async () => {
  const relay = fakeRelay(new TypeError("fetch failed"), created());
  const box = outbox(relay.impl);
  await box.submit(report());
  const stop = box.startRetrying({ firstMs: 5, everyMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  stop();
  assert.equal(box.size(), 0);
});

test("a server reads what a dialog posted, and turns away what isn't a report", async () => {
  const sent = report();
  const encoded = new Response(reportForm(sent));
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  assert.deepEqual(await readReportBody(bytes, encoded.headers.get("content-type")!), { ok: true, report: sent });
  assert.deepEqual(await readReportBody("junk", "multipart/form-data; boundary=x"), {
    ok: false,
    error: "The report is malformed.",
  });
});

test("the log tail keeps the last whole lines, each cut to length, the home folder hidden", async () => {
  const file = path.join(dir, "app.log");
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} in /Users/someone/app`);
  lines.push("x".repeat(400));
  await fs.writeFile(file, lines.join("\r\n") + "\n");
  const tail = logTail([file, path.join(dir, "missing.log")], { home: "/Users/someone" })!.split("\n");
  assert.equal(tail[0], "== app.log ==");
  assert.equal(tail.length, 41);
  assert.equal(tail[1], "line 61 in ~/app");
  assert.equal(tail[40], `${"x".repeat(300)}…`);
  assert.equal(logTail([file], { home: "", lines: 1 }), `== app.log ==\n${"x".repeat(300)}…`);
  assert.equal(logTail([path.join(dir, "missing.log")]), null);
});

test("the OS reads as a person knows it", () => {
  assert.equal(describeOs("darwin", "25.6.0", "arm64"), "macOS (Darwin 25.6.0, arm64)");
  assert.equal(describeOs("win32", "10.0.26100", "x64"), "Windows (10.0.26100, x64)");
  assert.equal(describeOs("freebsd", "14.1", "x64"), "freebsd (14.1, x64)");
});
