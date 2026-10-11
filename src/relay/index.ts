import { Buffer } from "node:buffer";
import { APP_ID, DEFAULT_KINDS, MAX_BODY_BYTES, PROTOCOL, readReportForm, type Report } from "../protocol.ts";
import { imagePath, issueBody, issueTitle } from "./issue.ts";

export { defuseMentions, fenced, imagePath, issueBody, issueTitle, kindLabel } from "./issue.ts";

/**
 * The relay: a Cloudflare Worker that apps POST reports to, and that files
 * each one as an issue in that app's private GitHub repo, its images
 * committed beside it. The GitHub token lives only in the Worker's secrets;
 * the apps hold nothing but the relay's URL, which is public, so every limit
 * is enforced here.
 *
 * Reports arrive at /v<protocol>/<app>/reports. A relay keeps answering every
 * protocol version it ever answered, so an app pinned to an old version of
 * this package keeps working after the relay is updated.
 */

export interface AppConfig {
  /** "owner/name" of the private repo this app's reports land in. */
  repo: string;
  /** The app's name in issues; its id unless set. */
  name?: string;
  /**
   * Origins whose pages may post straight from the browser, such as
   * "https://fitness.example.com". Requests from other sites are refused.
   * Leave it out for an app that posts from its own server. This keeps other
   * websites from using a visitor's browser to post; it is not
   * authentication, since anything but a browser can claim any origin.
   */
  origins?: string[];
  /** The kinds this app's dialog offers; each becomes an issue label. Bug, idea and question unless set. */
  kinds?: string[];
}

export interface RelayConfig {
  /** Each app by its id, the name the app uses to post here. */
  apps: Record<string, AppConfig>;
}

/** Workers' rate-limit binding, typed by shape so tests can stand in for it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RelayEnv {
  /** Fine-grained token: Contents and Issues, read and write, on every app's repo. */
  GITHUB_TOKEN: string;
  /** A [[ratelimits]] binding; without one, nothing slows a sender down. */
  RATE_LIMIT?: RateLimiter;
}

export interface Relay {
  fetch(request: Request, env: RelayEnv): Promise<Response>;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ROUTE = /^\/v(\d+)\/([^/]+)\/reports$/;

/** Protocol versions this relay answers. A new version is added here, and the old ones stay. */
const PROTOCOLS = [PROTOCOL];

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Check the config once, when the Worker starts, rather than on someone's report. */
function checkConfig(config: RelayConfig): void {
  const ids = Object.keys(config.apps ?? {});
  if (!ids.length) throw new Error("The relay has no apps.");
  for (const id of ids) {
    const app = config.apps[id];
    if (!APP_ID.test(id)) throw new Error(`"${id}" can't be an app id: use lowercase letters, digits and hyphens.`);
    if (!REPO.test(app.repo)) throw new Error(`App "${id}" needs its repo as "owner/name".`);
    for (const origin of app.origins ?? []) {
      if (origin !== new URL(origin).origin) throw new Error(`App "${id}" has an origin that isn't one: "${origin}".`);
    }
  }
}

export function createRelay(config: RelayConfig): Relay {
  checkConfig(config);

  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname === "/") return json(200, { protocols: PROTOCOLS }, { "access-control-allow-origin": "*" });

      const route = ROUTE.exec(pathname);
      if (!route) return json(404, { error: "Not found." });
      const version = Number(route[1]);
      if (!PROTOCOLS.includes(version)) return json(404, { error: `This relay doesn't speak protocol v${version}.` });
      const appId = route[2];
      const app = Object.hasOwn(config.apps, appId) ? config.apps[appId] : undefined;
      if (!app) return json(404, { error: "Unknown app." });

      // A browser always names the page's origin; a server posting for itself
      // names none.
      const origin = request.headers.get("origin");
      if (origin && !app.origins?.includes(origin)) return json(403, { error: "Posting from this site isn't allowed." });
      const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...cors,
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "86400",
          },
        });
      }
      if (request.method !== "POST") return json(405, { error: "POST a report here." }, cors);

      // Refuse an oversized body before reading it; a sender that won't say
      // how big its body is gets refused too.
      const length = Number(request.headers.get("content-length"));
      if (!Number.isFinite(length) || length <= 0) return json(411, { error: "Send a Content-Length." }, cors);
      if (length > MAX_BODY_BYTES) return json(413, { error: "The report is too large." }, cors);

      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (env.RATE_LIMIT && !(await env.RATE_LIMIT.limit({ key: ip })).success) {
        return json(429, { error: "Too many reports from here. Try again in a minute." }, cors);
      }

      if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
        return json(415, { error: "Send the report as multipart/form-data." }, cors);
      }
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return json(400, { error: "The report is malformed." }, cors);
      }
      const parsed = await readReportForm(form);
      if (!parsed.ok) return json(400, { error: parsed.error }, cors);
      const kinds: readonly string[] = app.kinds ?? DEFAULT_KINDS;
      if (!kinds.includes(parsed.report.kind)) {
        return json(400, { error: `The kind must be one of: ${kinds.join(", ")}.` }, cors);
      }

      try {
        const issue = await fileIssue(parsed.report, app.repo, app.name ?? appId, env);
        return json(201, { ok: true, issue }, cors);
      } catch (error) {
        console.error(`${appId} report ${parsed.report.id}:`, error);
        return json(502, { error: "The report could not be filed. It will be retried." }, cors);
      }
    },
  };
}

function github(env: RelayEnv, repo: string, method: string, path: string, body: string): Promise<Response> {
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "feedback-relay",
      "x-github-api-version": "2022-11-28",
    },
    body,
  });
}

async function failure(response: Response, what: string): Promise<Error> {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  return new Error(`${what}: GitHub answered ${response.status} ${detail}`);
}

/**
 * Commit one image to the repo's default branch. One at a time: commits to
 * the same branch race, and GitHub answers the loser 409, which gets one
 * retry. 422 means the path is taken, which only a retried report hits (the
 * paths are keyed by its id), so the image is already there.
 */
async function commitImage(env: RelayEnv, repo: string, report: Report, index: number): Promise<string> {
  const path = imagePath(report, index);
  const { data } = report.images[index];
  // Spliced in rather than passed through JSON.stringify, which would scan the
  // megabytes of base64 again for characters it never contains.
  const content = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
  const message = JSON.stringify(`Add image ${index + 1} of report ${report.id}`);
  const body = `{"message":${message},"content":"${content}"}`;
  for (let attempt = 0; ; attempt++) {
    const response = await github(env, repo, "PUT", `/contents/${path}`, body);
    if (response.ok || response.status === 422) break;
    if (response.status !== 409 || attempt > 0) throw await failure(response, `image ${index + 1}`);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  // Opened on github.com, a private repo's file loads with the viewer's own
  // session, so the screenshot shows inline for the owner and nobody else.
  return `https://github.com/${repo}/blob/HEAD/${path}?raw=true`;
}

async function fileIssue(report: Report, repo: string, appName: string, env: RelayEnv): Promise<number> {
  const urls: string[] = [];
  for (let i = 0; i < report.images.length; i++) urls.push(await commitImage(env, repo, report, i));
  const response = await github(
    env,
    repo,
    "POST",
    "/issues",
    JSON.stringify({ title: issueTitle(report), body: issueBody(report, appName, urls), labels: [report.kind] })
  );
  if (!response.ok) throw await failure(response, "issue");
  const issue = (await response.json()) as { number: number };
  return issue.number;
}
