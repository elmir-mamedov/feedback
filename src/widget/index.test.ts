import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { SendResult } from "../client.ts";
import type { Report } from "../protocol.ts";

GlobalRegistrator.register({ url: "https://fitness.example.com/log/today", width: 1280, height: 800 });
const { mountFeedback } = await import("./index.ts");
type Widget = ReturnType<typeof mountFeedback>;

let widget: Widget | null = null;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  widget?.destroy();
  widget = null;
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
});

after(async () => {
  await GlobalRegistrator.unregister();
});

/** Resolves once `check` holds, or fails the test after a second. */
async function until(check: () => boolean, what = "the condition"): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The widget's shadow root and its parts, as a person sees them. */
function parts() {
  const host = document.querySelector("feedback-widget")!;
  const root = host.shadowRoot!;
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return {
    host,
    root,
    dialog: $<HTMLDialogElement>("dialog"),
    launcher: $<HTMLButtonElement>("[data-launcher]"),
    intro: $("[data-intro]"),
    message: $<HTMLTextAreaElement>("[data-message]"),
    email: $<HTMLInputElement>("[data-email]"),
    page: $<HTMLInputElement>("[data-page]"),
    errorsRow: $("[data-errors-row]"),
    preview: $("[data-preview]"),
    status: $("[data-status]"),
    form: $<HTMLFormElement>("[data-form]"),
    done: $("[data-done]"),
    doneText: $("[data-done-text]"),
    kinds: Array.from(root.querySelectorAll<HTMLInputElement>("input[name=kind]")),
    checks: Array.from(root.querySelectorAll<HTMLLabelElement>("[data-checks] label")),
  };
}

function tick(box: HTMLInputElement, checked = true) {
  box.checked = checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

function recorder(result: SendResult = { status: "sent" }) {
  const sent: Report[] = [];
  return { sent, send: async (report: Report) => (sent.push(report), result) };
}

test("it needs an app id and somewhere to send", () => {
  assert.throws(() => mountFeedback({ app: "My App", appName: "My App", relay: "https://r.test" }), /app id/);
  assert.throws(() => mountFeedback({ app: "fitness", appName: "Fitness" }), /relay to send to/);
});

test("it sits in its own shadow root, with a button that opens the dialog", () => {
  widget = mountFeedback({ app: "fitness", appName: "Fitness", relay: "https://relay.test" });
  const p = parts();
  assert.equal(p.host.parentElement, document.body);
  assert.equal(p.launcher.hidden, false);
  assert.equal(p.launcher.dataset.position, "bottom-right");
  assert.equal(p.dialog.open, false);
  p.launcher.click();
  assert.equal(p.dialog.open, true);
  assert.match(p.intro.textContent!, /the people who make Fitness/);
  assert.deepEqual(
    p.kinds.map((k) => k.value),
    ["bug", "idea", "question"]
  );
  assert.equal(p.message.placeholder, "What happened, and what did you expect instead?");
  widget.destroy();
  widget = null;
  assert.equal(document.querySelector("feedback-widget"), null);
});

test("without a button, the app opens it, optionally with a kind and a message", () => {
  widget = mountFeedback({
    app: "fitness",
    appName: "Fitness",
    relay: "https://relay.test",
    button: false,
    kinds: [
      { id: "bug", label: "Bug" },
      { id: "feature-request", label: "Feature request", placeholder: "What should it do?" },
    ],
  });
  const p = parts();
  assert.equal(p.launcher.hidden, true);
  widget.open({ kind: "feature-request", message: "Let me log water" });
  assert.equal(p.dialog.open, true);
  assert.equal(p.kinds[1].checked, true);
  assert.equal(p.message.value, "Let me log water");
  assert.equal(p.message.placeholder, "What should it do?");
  widget.open({ message: "Something else" });
  assert.equal(p.message.value, "Let me log water", "a draft isn't overwritten");
});

test("an empty message isn't sent", async () => {
  const relay = recorder();
  widget = mountFeedback({ app: "fitness", appName: "Fitness", send: relay.send });
  widget.open();
  const p = parts();
  p.form.requestSubmit();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(p.status.textContent, "Write a message first.");
  assert.equal(relay.sent.length, 0);
});

test("a report carries what the person wrote and exactly what the preview showed", async () => {
  const relay = recorder();
  widget = mountFeedback({
    app: "fitness",
    appName: "Fitness",
    version: "2.3.0",
    send: relay.send,
    facts: async () => ({ Account: "a1b2" }),
    email: () => "signed-in@example.com",
  });
  widget.recordError(new TypeError("x is undefined"));
  widget.open();
  const p = parts();
  assert.equal(p.email.value, "signed-in@example.com");
  assert.equal(p.errorsRow.hidden, false);
  p.message.value = "The chart is empty after midnight";
  tick(p.kinds[1]);
  tick(p.page);
  await until(() => p.preview.textContent!.includes("Account"), "the app's facts");
  const preview = p.preview.textContent!;
  p.form.requestSubmit();
  await until(() => relay.sent.length === 1, "the send");

  const [report] = relay.sent;
  assert.equal(report.kind, "idea");
  assert.equal(report.message, "The chart is empty after midnight");
  assert.equal(report.email, "signed-in@example.com");
  assert.equal(report.version, "2.3.0");
  assert.equal(report.facts.Account, "a1b2");
  assert.equal(report.facts.Page, "/log/today");
  assert.equal(report.facts.Window, "1280×800 @1x");
  assert.ok(report.facts.Browser);
  assert.equal(report.errors!.length, 1);
  assert.match(report.errors![0], /^\d\d:\d\d:\d\d \/log\/today TypeError: x is undefined$/);
  for (const [name, value] of Object.entries(report.facts)) assert.ok(preview.includes(value), `${name} was previewed`);
  assert.match(preview, /^Fitness {2,}2\.3\.0$/m);

  await until(() => !p.done.hidden, "the done screen");
  assert.match(p.doneText.textContent!, /goes to signed-in@example\.com/);
  assert.equal(p.message.value, "", "a send clears the draft");
  assert.equal(p.page.checked, false);
  assert.equal(localStorage.getItem("feedback.fitness.email"), "signed-in@example.com");
  assert.equal(sessionStorage.getItem("feedback.fitness.errors"), null, "sent errors aren't sent twice");
});

test("the page's uncaught errors are kept, and can be left out", async () => {
  const relay = recorder();
  widget = mountFeedback({ app: "fitness", appName: "Fitness", send: relay.send });
  window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught RangeError: boom", filename: "https://x/app.js", lineno: 3 }));
  widget.open();
  const p = parts();
  assert.equal(p.errorsRow.hidden, false);
  assert.match(p.preview.textContent!, /RangeError: boom \(app\.js:3\)/);
  tick(p.root.querySelector<HTMLInputElement>("[data-errors]")!, false);
  assert.doesNotMatch(p.preview.textContent!, /boom/);
  p.message.value = "Something broke";
  p.form.requestSubmit();
  await until(() => relay.sent.length === 1, "the send");
  assert.equal(relay.sent[0].errors, undefined);
  assert.equal(JSON.parse(sessionStorage.getItem("feedback.fitness.errors")!).length, 1, "unsent errors are kept");
});

test("an extra shows only when it has something, and goes only when ticked", async () => {
  const relay = recorder({ status: "queued" });
  widget = mountFeedback({
    app: "kb25",
    appName: "KB25",
    send: relay.send,
    extras: [
      { label: "The last lines of KB25's log", load: async () => ({ logs: "== kb25.log ==\nlistening" }) },
      { label: "Nothing to offer", load: () => null },
    ],
  });
  widget.open();
  const p = parts();
  const [logRow, emptyRow] = p.checks.slice(-2);
  await until(() => !logRow.hidden, "the log row");
  assert.equal(emptyRow.hidden, true);
  assert.doesNotMatch(p.preview.textContent!, /listening/);
  tick(logRow.querySelector("input")!);
  assert.match(p.preview.textContent!, /listening/);
  p.message.value = "Saving fails";
  p.form.requestSubmit();
  await until(() => !p.done.hidden, "the done screen");
  assert.equal(relay.sent[0].logs, "== kb25.log ==\nlistening");
  assert.match(p.root.querySelector("[data-done-title]")!.textContent!, /sent later/);
  assert.equal(logRow.querySelector("input")!.checked, false, "a send unticks it again");
});

test("an app's facts that never arrive don't hold a report back for long", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const relay = recorder();
  widget = mountFeedback({ app: "fitness", appName: "Fitness", send: relay.send, facts: () => new Promise(() => {}) });
  widget.open();
  const p = parts();
  p.message.value = "Hello";
  p.form.requestSubmit();
  t.mock.timers.tick(5_000);
  t.mock.timers.reset();
  await until(() => relay.sent.length === 1, "the send");
  assert.equal(relay.sent[0].facts.Account, undefined);
});

test("straight to the relay: sent to the app's path, and a failure keeps the draft", async () => {
  const urls: string[] = [];
  let answer = new Response("{}", { status: 502 });
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return answer;
  }) as typeof fetch;
  widget = mountFeedback({ app: "fitness", appName: "Fitness", relay: "https://relay.test" });
  widget.open();
  const p = parts();
  p.message.value = "It won't load";
  p.form.requestSubmit();
  await until(() => p.status.classList.contains("is-error"), "the error");
  assert.deepEqual(urls, ["https://relay.test/v1/fitness/reports"]);
  assert.match(p.status.textContent!, /couldn't be reached/);
  assert.equal(p.message.value, "It won't load");

  answer = new Response(JSON.stringify({ error: "The kind must be one of: bug." }), { status: 400 });
  p.form.requestSubmit();
  await until(() => p.status.textContent === "The kind must be one of: bug.", "the refusal");
  assert.equal(p.message.value, "It won't load");

  answer = new Response(JSON.stringify({ ok: true, issue: 3 }), { status: 201 });
  p.email.value = "";
  p.form.requestSubmit();
  await until(() => !p.done.hidden, "the done screen");
  assert.match(p.doneText.textContent!, /without a reply address/);
});
