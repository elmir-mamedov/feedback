import { isObject, reportForm, reportsUrl, type Report } from "./protocol.ts";

/**
 * Posting a report to a relay, from anywhere fetch runs: a browser, a Node
 * server, a Worker.
 */

/** What became of a report, as a dialog shows it. */
export type SendResult = { status: "sent" } | { status: "queued" } | { status: "refused"; error: string };

/** "retry" for anything that might go through later; a refusal is final and says why. */
export type Delivery = "sent" | "retry" | { refused: string };

export interface RelayTarget {
  /** Where the relay is, such as "https://feedback.example.workers.dev". */
  relay: string;
  /** The app's id there: its key in the relay's `apps`. */
  app: string;
  fetch?: typeof fetch;
  /** How long to wait for an answer; a minute unless set. */
  timeoutMs?: number;
}

/**
 * Post one report. Offline, rate-limited, or the relay or GitHub down all
 * come back "retry"; anything else the relay turns away comes back with its
 * reason.
 */
export async function sendReport(report: Report, target: RelayTarget): Promise<Delivery> {
  const fetchImpl = target.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(reportsUrl(target.relay, target.app), {
      method: "POST",
      body: reportForm(report),
      signal: AbortSignal.timeout(target.timeoutMs ?? 60_000),
    });
  } catch {
    return "retry";
  }
  if (response.ok) return "sent";
  if (response.status === 429 || response.status >= 500) return "retry";
  const answer: unknown = await response.json().catch(() => null);
  const error = isObject(answer) && typeof answer.error === "string" ? answer.error : "";
  return { refused: error || `The feedback service refused the report (${response.status}).` };
}
