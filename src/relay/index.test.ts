import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRelay, type RelayEnv } from "./index.ts";
import { MAX_BODY_BYTES } from "../protocol.ts";
import { PNG, WEBP, body } from "../test-fixtures.ts";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let calls: Call[];
/** What the fake GitHub answers, in call order; the last one repeats. */
let answers: Response[];

beforeEach(() => {
  calls = [];
  answers = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    return answer?.clone() ?? new Response(JSON.stringify({ number: 1 }), { status: 201 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const relay = createRelay({
  apps: {
    kb25: { repo: "owner/kb25-feedback", name: "KB25" },
    fitness: {
      repo: "owner/fitness-feedback",
      origins: ["https://fitness.example.com"],
      kinds: ["bug", "feature-request"],
    },
  },
});

function env(allowed = true): RelayEnv {
  return { GITHUB_TOKEN: "test-token", RATE_LIMIT: { limit: async () => ({ success: allowed }) } };
}

type Image = { type: string; data: Uint8Array };

/** A multipart report request, sized as a real client sends it. */
async function post(
  report: unknown,
  { app = "kb25", images = [{ type: "image/png", data: PNG }] as Image[], headers = {} as Record<string, string> } = {}
): Promise<Request> {
  const form = new FormData();
  form.append("report", typeof report === "string" ? report : JSON.stringify(report));
  images.forEach((img, i) =>
    form.append("image", new Blob([img.data as Uint8Array<ArrayBuffer>], { type: img.type }), `${i + 1}`)
  );
  const encoded = new Response(form);
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  return new Request(`https://relay.test/v1/${app}/reports`, {
    method: "POST",
    headers: {
      "content-type": encoded.headers.get("content-type")!,
      "content-length": String(bytes.length),
      ...headers,
    },
    body: bytes,
  });
}

async function send(request: Request, e = env()) {
  const response = await relay.fetch(request, e);
  return {
    status: response.status,
    cors: response.headers.get("access-control-allow-origin"),
    body: (await response.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

test("a relay with a bad config refuses to start", () => {
  assert.throws(() => createRelay({ apps: {} }), /no apps/);
  assert.throws(() => createRelay({ apps: { "My App": { repo: "o/r" } } }), /can't be an app id/);
  assert.throws(() => createRelay({ apps: { app: { repo: "just-a-name" } } }), /owner\/name/);
  assert.throws(() => createRelay({ apps: { app: { repo: "o/r", origins: ["https://x.test/"] } } }), /isn't one/);
});

test("the root says which protocol versions the relay speaks", async () => {
  const result = await send(new Request("https://relay.test/"));
  assert.deepEqual(result.body, { protocols: [1] });
});

test("only reports to a known app under a known version are served", async () => {
  assert.equal((await send(new Request("https://relay.test/reports"))).status, 404);
  const v9 = await send(new Request("https://relay.test/v9/kb25/reports", { method: "POST" }));
  assert.equal(v9.status, 404);
  assert.match(String(v9.body?.error), /protocol v9/);
  const unknown = await send(await post(body(), { app: "nope" }));
  assert.deepEqual(unknown.body, { error: "Unknown app." });
  const inherited = await send(await post(body(), { app: "constructor" }));
  assert.deepEqual(inherited.body, { error: "Unknown app." });
  assert.equal((await send(new Request("https://relay.test/v1/kb25/reports"))).status, 405);
  assert.equal(calls.length, 0);
});

test("a page on an allowed origin may post, and reads the answer", async () => {
  const preflight = await relay.fetch(
    new Request("https://relay.test/v1/fitness/reports", {
      method: "OPTIONS",
      headers: { origin: "https://fitness.example.com" },
    }),
    env()
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://fitness.example.com");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");

  const result = await send(await post(body(), { app: "fitness", headers: { origin: "https://fitness.example.com" } }));
  assert.equal(result.status, 201);
  assert.equal(result.cors, "https://fitness.example.com");

  const refused = await send(
    await post(body({ kind: "idea" }), { app: "fitness", headers: { origin: "https://fitness.example.com" } })
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.cors, "https://fitness.example.com", "so the dialog can show why");
});

test("a page on any other origin is turned away before its report is read", async () => {
  const other = await send(await post(body(), { app: "fitness", headers: { origin: "https://evil.test" } }));
  assert.equal(other.status, 403);
  assert.equal(other.cors, null);
  const serverOnly = await send(await post(body(), { app: "kb25", headers: { origin: "https://fitness.example.com" } }));
  assert.equal(serverOnly.status, 403);
  assert.equal(calls.length, 0);
});

test("a body that is too large or unsized is refused unread", async () => {
  const large = await post(body(), { headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
  assert.equal((await send(large)).status, 413);
  const unsized = new Request("https://relay.test/v1/kb25/reports", { method: "POST", body: "{}" });
  assert.equal((await send(unsized)).status, 411);
  assert.equal(calls.length, 0);
});

test("a sender over the rate limit is told to wait, and no limit applies without a binding", async () => {
  assert.equal((await send(await post(body()), env(false))).status, 429);
  assert.equal(calls.length, 0);
  assert.equal((await send(await post(body()), { GITHUB_TOKEN: "test-token" })).status, 201);
});

test("a report that isn't multipart is refused", async () => {
  const json = JSON.stringify(body());
  const request = new Request("https://relay.test/v1/kb25/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(json.length) },
    body: json,
  });
  assert.equal((await send(request)).status, 415);
});

test("a malformed report, or a kind the app doesn't offer, is refused with the reason", async () => {
  assert.equal((await send(await post("not json"))).status, 400);
  const fake = await send(await post(body(), { images: [{ type: "image/png", data: Uint8Array.from([1, 2, 3]) }] }));
  assert.match(String(fake.body?.error), /isn't the PNG it claims to be/);
  const kind = await send(await post(body({ kind: "rant" })));
  assert.equal(kind.status, 400);
  assert.equal(kind.body?.error, "The kind must be one of: bug, idea, question.");
  assert.equal(calls.length, 0);
});

test("a report commits its images, then opens a labelled issue in its app's repo", async () => {
  answers = [
    new Response("{}", { status: 201 }),
    new Response("{}", { status: 201 }),
    new Response(JSON.stringify({ number: 7 }), { status: 201 }),
  ];
  const payload = body({ kind: "feature-request" });
  const result = await send(
    await post(payload, {
      app: "fitness",
      images: [
        { type: "image/png", data: PNG },
        { type: "image/webp", data: WEBP },
      ],
    })
  );
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { ok: true, issue: 7 });

  const [first, second, issue] = calls;
  const repo = "https://api.github.com/repos/owner/fitness-feedback";
  assert.equal(first.method, "PUT");
  assert.equal(first.url, `${repo}/contents/reports/${payload.id}/1.png`);
  assert.equal(first.body.content, Buffer.from(PNG).toString("base64"));
  assert.equal(first.body.message, `Add image 1 of report ${payload.id}`);
  assert.equal(second.url, `${repo}/contents/reports/${payload.id}/2.webp`);
  assert.equal(issue.method, "POST");
  assert.equal(issue.url, `${repo}/issues`);
  assert.deepEqual(issue.body.labels, ["feature-request"]);
  assert.equal(issue.body.title, "Search finds nothing");
  assert.match(String(issue.body.body), /\*\*Feature request\*\* · fitness 1\.4\.0/, "named by its id without a name");
  assert.match(
    String(issue.body.body),
    new RegExp(`!\\[Screenshot 2\\]\\(https://github\\.com/owner/fitness-feedback/blob/HEAD/reports/${payload.id}/2\\.webp\\?raw=true\\)`)
  );
});

test("an image already committed by an earlier try counts as done", async () => {
  answers = [new Response("{}", { status: 422 }), new Response(JSON.stringify({ number: 8 }), { status: 201 })];
  assert.equal((await send(await post(body()))).status, 201);
  assert.equal(calls.length, 2);
});

test("a commit that loses a race is retried once", async () => {
  answers = [
    new Response("{}", { status: 409 }),
    new Response("{}", { status: 201 }),
    new Response(JSON.stringify({ number: 9 }), { status: 201 }),
  ];
  assert.equal((await send(await post(body()))).status, 201);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["PUT", "PUT", "POST"]
  );
});

test("a GitHub failure is a 502, which the sender retries later", async (t) => {
  t.mock.method(console, "error", () => {});
  answers = [new Response("{}", { status: 201 }), new Response("Bad credentials", { status: 401 })];
  const result = await send(await post(body()));
  assert.equal(result.status, 502);
  assert.match(String(result.body?.error), /retried/);
});
