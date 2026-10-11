import { test } from "node:test";
import assert from "node:assert/strict";
import { defuseMentions, fenced, imagePath, issueBody, issueTitle, kindLabel } from "./issue.ts";
import { parseReport, type Report } from "../protocol.ts";
import { ID, PNG, WEBP, body } from "../test-fixtures.ts";

function parsed(overrides: Record<string, unknown> = {}): Report {
  const result = parseReport(body({ images: [{ type: "image/png", data: PNG }], ...overrides }));
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.report;
}

test("image paths are keyed by the report id, so a retry lands on the same paths", () => {
  const report = parsed({
    images: [
      { type: "image/webp", data: WEBP },
      { type: "image/jpeg", data: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]) },
    ],
  });
  assert.equal(imagePath(report, 0), `reports/${ID}/1.webp`);
  assert.equal(imagePath(report, 1), `reports/${ID}/2.jpg`);
});

test("mentions are defused, a plain @ left readable", () => {
  assert.equal(defuseMentions("cc @octocat"), "cc @​octocat");
  assert.equal(defuseMentions("@org/team"), "@​org/team");
  assert.equal(defuseMentions("a @ b"), "a @ b");
});

test("a fence outlasts any backtick run inside it", () => {
  assert.equal(fenced("plain"), "```text\nplain\n```");
  assert.equal(fenced("has ``` inside"), "````text\nhas ``` inside\n````");
});

test("a kind reads as a heading", () => {
  assert.equal(kindLabel("bug"), "Bug");
  assert.equal(kindLabel("feature-request"), "Feature request");
});

test("the title is the first non-blank line, cut to fit", () => {
  assert.equal(issueTitle(parsed({ message: "\n  Search finds nothing  \nmore" })), "Search finds nothing");
  const long = issueTitle(parsed({ message: "word ".repeat(40) }));
  assert.ok(long.length <= 80 && long.endsWith("…"));
  assert.equal(issueTitle(parsed({ message: "@octocat look" })), "@​octocat look");
});

test("the body carries the message, screenshots and everything sent with them", () => {
  const report = parsed({
    message: "It broke, cc @octocat",
    facts: { OS: "macOS 15", Page: "/log/today", Weird: "two\nlines" },
    errors: ["TypeError: x is undefined"],
    logs: "listening on 4000",
  });
  const md = issueBody(report, "Fitness", ["https://github.com/o/r/blob/HEAD/reports/x/1.png?raw=true"]);
  assert.match(md, /^It broke, cc @​octocat/);
  assert.match(md, /\*\*Bug\*\* · Fitness 1\.4\.0 · reply to someone@​example\.com/);
  assert.match(md, /!\[Screenshot 1\]\(https:\/\/github\.com\/o\/r\/blob\/HEAD\/reports\/x\/1\.png\?raw=true\)/);
  assert.match(md, /Fitness {2}1\.4\.0\nOS {7}macOS 15\nPage {5}\/log\/today\nWeird {4}two lines\n/);
  assert.match(md, /Errors before the report \(1\)[\s\S]*TypeError: x is undefined/);
  assert.match(md, /Log tail[\s\S]*listening on 4000/);
  assert.match(md, new RegExp(`Report ${ID} · protocol v1`));
});

test("a report without extras says so and skips their sections", () => {
  const report = parsed({ email: undefined, version: undefined, facts: {}, images: [] });
  const md = issueBody(report, "Fitness", []);
  assert.match(md, /\*\*Bug\*\* · Fitness · no reply address/);
  assert.doesNotMatch(md, /Screenshots|Details|Errors before|Log tail/);
});
