import { IMAGE_TYPES, PROTOCOL, type Report } from "../protocol.ts";

/**
 * The GitHub issue a report becomes. Pure text in, text out, so it is tested
 * without a network or a Worker.
 */

/** Where a report's image is committed in the app's feedback repo. */
export function imagePath(report: Report, index: number): string {
  return `reports/${report.id}/${index + 1}.${IMAGE_TYPES[report.images[index].type]}`;
}

/**
 * An @-mention in a report would have GitHub notify that user from the token
 * owner's account, so anyone could ping anyone through a relay. A zero-width
 * space after the @ keeps the text and drops the mention.
 */
export function defuseMentions(value: string): string {
  return value.replace(/@(?=[A-Za-z0-9])/g, "@​");
}

/** A fenced block that the text inside cannot close early. */
export function fenced(value: string, info = "text"): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${value.replace(/\s+$/, "")}\n${fence}`;
}

/** "feature-request" as a heading: "Feature request". */
export function kindLabel(kind: string): string {
  const words = kind.replace(/-+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The message's first non-blank line, cut to fit an issue title. */
export function issueTitle(report: Report): string {
  const line = report.message.split("\n").find((l) => l.trim())?.trim() ?? kindLabel(report.kind);
  const title = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  return defuseMentions(title);
}

/** One line per fact, whatever the sender put in it. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The issue body: the message as written, a line of who and what, the
 * screenshots, then everything else that came with it.
 */
export function issueBody(report: Report, appName: string, imageUrls: string[]): string {
  const parts: string[] = [defuseMentions(report.message.trim())];

  const app = report.version ? `${appName} ${oneLine(report.version)}` : appName;
  const summary = [`**${kindLabel(report.kind)}**`, app];
  summary.push(report.email ? `reply to ${report.email}` : "no reply address");
  parts.push(`---\n${defuseMentions(summary.join(" · "))}`);

  if (imageUrls.length) {
    parts.push("### Screenshots\n\n" + imageUrls.map((url, i) => `![Screenshot ${i + 1}](${url})`).join("\n\n"));
  }

  const rows: [string, string][] = [];
  if (report.version) rows.push([oneLine(appName), oneLine(report.version)]);
  for (const [name, value] of Object.entries(report.facts)) rows.push([oneLine(name), oneLine(value)]);
  if (rows.length) {
    const width = Math.max(...rows.map(([name]) => name.length)) + 2;
    const table = rows.map(([name, value]) => name.padEnd(width) + value).join("\n");
    parts.push(`### Details\n\n${fenced(table)}`);
  }

  if (report.errors?.length) {
    parts.push(
      `<details><summary>Errors before the report (${report.errors.length})</summary>\n\n${fenced(report.errors.join("\n"))}\n\n</details>`
    );
  }
  if (report.logs) {
    parts.push(`<details><summary>Log tail</summary>\n\n${fenced(report.logs)}\n\n</details>`);
  }

  parts.push(`<sub>Report ${report.id} · protocol v${PROTOCOL}</sub>`);
  return parts.join("\n\n");
}
