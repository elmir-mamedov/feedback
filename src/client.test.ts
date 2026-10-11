import { test } from "node:test";
import assert from "node:assert/strict";
import { sendReport } from "./client.ts";
import { parseReport, type Report } from "./protocol.ts";
import { body } from "./test-fixtures.ts";

function report(): Report {
  const parsed = parseReport(body());
  assert.ok(parsed.ok);
  return parsed.report;
}

function relayAnswering(answer: Response | Error, seen: string[] = []) {
  return {
    relay: "https://relay.test/",
    app: "fitness",
    fetch: (async (input: string | URL | Request) => {
      seen.push(String(input));
      if (answer instanceof Error) throw answer;
      return answer;
    }) as typeof fetch,
  };
}

test("a report goes to the app's path on the relay", async () => {
  const seen: string[] = [];
  assert.equal(await sendReport(report(), relayAnswering(new Response("{}", { status: 201 }), seen)), "sent");
  assert.deepEqual(seen, ["https://relay.test/v1/fitness/reports"]);
});

test("whatever might pass later is a retry", async () => {
  assert.equal(await sendReport(report(), relayAnswering(new TypeError("fetch failed"))), "retry");
  assert.equal(await sendReport(report(), relayAnswering(new Response("{}", { status: 429 }))), "retry");
  assert.equal(await sendReport(report(), relayAnswering(new Response("{}", { status: 502 }))), "retry");
});

test("a refusal carries the relay's reason, or the status when it gave none", async () => {
  const reason = new Response(JSON.stringify({ error: "The kind is malformed." }), { status: 400 });
  assert.deepEqual(await sendReport(report(), relayAnswering(reason)), { refused: "The kind is malformed." });
  assert.deepEqual(await sendReport(report(), relayAnswering(new Response("nope", { status: 404 }))), {
    refused: "The feedback service refused the report (404).",
  });
});
