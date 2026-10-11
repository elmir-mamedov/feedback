import { sendReport, type SendResult } from "../client.ts";
import {
  APP_ID,
  LIMITS,
  newReportId,
  parseReport,
  type Facts,
  type ImageType,
  type Report,
} from "../protocol.ts";
import { describeError, errorLog, watchErrors } from "./errors.ts";
import { canCaptureTab, captureTab, prepareImage } from "./images.ts";
import { STYLES } from "./styles.ts";

export { describeError } from "./errors.ts";
export type { SendResult } from "../client.ts";
export type { Facts, Report } from "../protocol.ts";

/**
 * The feedback dialog, for any web page and any framework: a message, a
 * kind, up to five screenshots (pasted, dropped, picked, or a capture of the
 * tab), an optional reply address, and an opt-in list of what else goes with
 * it, previewed exactly. It lives in a shadow root, so the page's styles and
 * its own never meet. Closing keeps the draft; only a send clears it.
 */

export interface KindOption {
  /** The slug sent to the relay, which becomes the issue's label. */
  id: string;
  label: string;
  /** The message box's hint while this kind is picked. */
  placeholder?: string;
}

/** What an extra adds to a report when it's ticked. */
export interface ExtraValue {
  facts?: Facts;
  logs?: string;
}

/** Something a person may choose to include, such as a log tail. */
export interface Extra {
  /** The checkbox's text, such as "The last lines of the server's log". */
  label: string;
  /** Ticked from the start; unticked unless set. */
  checked?: boolean;
  /** What it adds, loaded each time the dialog opens; nothing leaves it out of the list. */
  load(): ExtraValue | null | undefined | Promise<ExtraValue | null | undefined>;
}

export interface FeedbackOptions {
  /** The app's id on the relay: its key in the relay's `apps`. */
  app: string;
  /** The app's name as people know it, used in the dialog's text. */
  appName: string;
  /** Where the relay is, such as "https://feedback.example.workers.dev". */
  relay?: string;
  /**
   * Send reports some other way instead of straight to `relay`, such as
   * through the app's own server (see readReportBody and createOutbox).
   */
  send?: (report: Report) => Promise<SendResult>;
  /**
   * The app's version, which goes with every report. A function is asked each
   * time the dialog opens, for a page that has to look its version up.
   */
  version?: string | (() => string | null | undefined | Promise<string | null | undefined>);
  /** The kinds offered, in order; bug, idea and question unless set. They must match the relay's. */
  kinds?: KindOption[];
  /** Facts that always go with a report, loaded each time the dialog opens and shown before sending. */
  facts?: () => Facts | Promise<Facts>;
  /** Things a person may choose to include. */
  extras?: Extra[];
  /** A reply address to offer, such as the signed-in person's, when they haven't typed one. */
  email?: () => string | null | undefined;
  /** A floating button that opens the dialog, and where; "bottom-right" unless set. False to open it yourself. */
  button?: false | "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** "auto" follows the system unless set; a function is asked each time the dialog opens. */
  theme?: "auto" | "light" | "dark" | (() => "light" | "dark");
  /** Keep errors this tab runs into, so a report can carry them; on unless false. */
  captureErrors?: boolean;
  /** Offer to capture the tab, where the browser can; on unless false. */
  captureTab?: boolean;
  /** Where the widget is attached; the document's body unless set. */
  container?: HTMLElement;
}

export interface FeedbackWidget {
  /** Open the dialog, picking a kind or starting the message if asked and it's still empty. */
  open(prefill?: { kind?: string; message?: string }): void;
  close(): void;
  /** Keep an error for the next report, such as one an error boundary caught. */
  recordError(error: unknown): void;
  /** Take the widget off the page and stop watching for errors. */
  destroy(): void;
}

const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>`;

/** Static markup only: everything from the app or the person goes in through textContent. */
const MARKUP = `
<button type="button" class="launcher" part="button" aria-label="Send feedback" title="Send feedback" data-launcher hidden>${ICON}</button>
<dialog class="dialog" aria-labelledby="fb-title" data-dialog>
  <div class="head">
    <h2 id="fb-title">Send feedback</h2>
    <button type="button" class="close" aria-label="Close" data-close>&times;</button>
  </div>
  <form class="body" novalidate data-form>
    <p class="intro" data-intro></p>
    <fieldset class="kinds" data-kinds>
      <legend class="label">What is it?</legend>
    </fieldset>
    <label class="label" for="fb-message">Message</label>
    <textarea id="fb-message" rows="6" maxlength="${LIMITS.message}" data-message></textarea>
    <div class="drop" data-drop>
      <div class="thumbs" data-thumbs></div>
      <p class="hint">Paste or drop screenshots here, <button type="button" class="link" data-pick>choose images</button><span data-capture-wrap hidden>, or <button type="button" class="link" data-capture>capture this tab</button></span>. Up to ${LIMITS.images}.</p>
      <input type="file" accept="image/*" multiple hidden data-file />
    </div>
    <label class="label" for="fb-email">Your email <span class="optional">(optional, if you'd like a reply)</span></label>
    <input type="email" id="fb-email" maxlength="${LIMITS.email}" autocomplete="email" data-email />
    <details class="details">
      <summary>What else is sent</summary>
      <p class="hint">What's shown below goes with every report. Tick anything else that could help:</p>
      <div class="checks" data-checks>
        <label><input type="checkbox" data-page /> <span>This page's address <code data-page-path></code></span></label>
        <label data-errors-row hidden><input type="checkbox" checked data-errors /> <span data-errors-label></span></label>
      </div>
      <pre class="preview" data-preview></pre>
    </details>
    <p class="status" role="status" aria-live="polite" data-status></p>
    <div class="actions">
      <button type="button" class="button" data-close>Close</button>
      <button type="submit" class="button primary" data-send>Send</button>
    </div>
  </form>
  <div class="body" data-done hidden>
    <p class="done-title" data-done-title></p>
    <p class="intro" data-done-text></p>
    <div class="actions">
      <button type="button" class="button primary" data-close>Done</button>
    </div>
  </div>
</dialog>`;

/** Wait for `promise`, or give up after `ms` with `fallback`, so a slow app can't hold a report back. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** Call an app's function, treating a throw or a rejection as nothing. */
async function attempt<T>(fn: (() => T | Promise<T>) | undefined): Promise<T | undefined> {
  try {
    return fn ? await within(Promise.resolve(fn()), 5_000, undefined) : undefined;
  } catch {
    return undefined;
  }
}

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function mountFeedback(options: FeedbackOptions): FeedbackWidget {
  if (!APP_ID.test(options.app)) throw new Error(`"${options.app}" can't be an app id: use lowercase letters, digits and hyphens.`);
  if (!options.relay && !options.send) throw new Error("mountFeedback needs a relay to send to, or a send function.");

  const { appName } = options;
  const kinds: KindOption[] = options.kinds ?? [
    { id: "bug", label: "Bug", placeholder: "What happened, and what did you expect instead?" },
    { id: "idea", label: "Idea", placeholder: `What would you like ${appName} to do?` },
    { id: "question", label: "Question", placeholder: "What would you like to know?" },
  ];
  if (!kinds.length) throw new Error("mountFeedback needs at least one kind.");
  const extras = options.extras ?? [];
  const emailKey = `feedback.${options.app}.email`;
  const errors = errorLog(`feedback.${options.app}.errors`);
  const stopWatching = options.captureErrors === false ? () => {} : watchErrors(errors);

  const host = document.createElement("feedback-widget");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLES}</style>${MARKUP}`;
  (options.container ?? document.body).append(host);

  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const dialog = $<HTMLDialogElement>("[data-dialog]");
  const form = $<HTMLFormElement>("[data-form]");
  const done = $("[data-done]");
  const message = $<HTMLTextAreaElement>("[data-message]");
  const email = $<HTMLInputElement>("[data-email]");
  const thumbs = $("[data-thumbs]");
  const drop = $("[data-drop]");
  const fileInput = $<HTMLInputElement>("[data-file]");
  const pageBox = $<HTMLInputElement>("[data-page]");
  const errorsBox = $<HTMLInputElement>("[data-errors]");
  const checks = $("[data-checks]");
  const preview = $("[data-preview]");
  const status = $("[data-status]");
  const sendBtn = $<HTMLButtonElement>("[data-send]");
  const launcher = $<HTMLButtonElement>("[data-launcher]");

  $("[data-intro]").textContent =
    `Report a bug, suggest an idea or ask a question. It goes to the people who make ${appName}, ` +
    "and nothing is sent until you press Send.";

  const kindsBox = $("[data-kinds]");
  for (const [i, option] of kinds.entries()) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "kind";
    input.value = option.id;
    input.checked = i === 0;
    label.append(input, ` ${option.label}`);
    kindsBox.append(label);
  }

  /** The extras' rows, each with what it loaded when the dialog last opened. */
  const extraRows = extras.map((extra) => {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = Boolean(extra.checked);
    const text = document.createElement("span");
    text.textContent = extra.label;
    label.append(box, text);
    label.hidden = true;
    checks.append(label);
    return { extra, label, box, value: null as ExtraValue | null };
  });

  let images: { blob: Blob; url: string }[] = [];
  let sending = false;
  let appFacts: Facts = {};
  let appVersion = typeof options.version === "string" ? options.version : undefined;
  let loading: Promise<void> = Promise.resolve();

  const kind = () => form.querySelector<HTMLInputElement>("input[name=kind]:checked")?.value ?? kinds[0].id;
  const setStatus = (text: string, isError = false) => {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  };

  function applyTheme() {
    const theme = typeof options.theme === "function" ? options.theme() : (options.theme ?? "auto");
    host.dataset.theme = theme;
  }

  /** Everything besides what the person writes and the images, as it will be sent. */
  function details(): Pick<Report, "facts" | "errors" | "logs"> {
    const facts: Facts = {
      Browser: navigator.userAgent,
      Window: `${innerWidth}×${innerHeight} @${Math.round(devicePixelRatio * 100) / 100}x`,
      ...appFacts,
    };
    if (pageBox.checked) facts.Page = location.pathname;
    const logs: string[] = [];
    for (const row of extraRows) {
      if (!row.box.checked || !row.value) continue;
      Object.assign(facts, row.value.facts);
      if (row.value.logs) logs.push(row.value.logs);
    }
    const recent = errorsBox.checked ? errors.read() : [];
    const joined = logs.join("\n\n");
    return {
      facts,
      errors: recent.length ? recent : undefined,
      logs: joined ? joined.slice(-LIMITS.logs) : undefined,
    };
  }

  function renderPreview() {
    const { facts, errors: recent, logs } = details();
    const rows: [string, string][] = [];
    if (appVersion) rows.push([appName, appVersion]);
    rows.push(...Object.entries(facts));
    const width = Math.max(...rows.map(([name]) => name.length)) + 2;
    const lines = rows.map(([name, value]) => name.padEnd(width) + value);
    if (recent) lines.push("", "Errors:", ...recent);
    if (logs) lines.push("", logs);
    preview.textContent = lines.join("\n");
  }

  function renderThumbs() {
    thumbs.replaceChildren(
      ...images.map((image, i) => {
        const figure = document.createElement("figure");
        figure.className = "thumb";
        const img = document.createElement("img");
        img.src = image.url;
        img.alt = `Screenshot ${i + 1}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove screenshot ${i + 1}`);
        remove.addEventListener("click", () => {
          URL.revokeObjectURL(image.url);
          images.splice(i, 1);
          renderThumbs();
          setStatus("");
        });
        figure.append(img, remove);
        return figure;
      })
    );
  }

  async function addImages(blobs: Blob[]) {
    for (const blob of blobs) {
      if (images.length >= LIMITS.images) return setStatus(`A report can carry up to ${LIMITS.images} images.`, true);
      let prepared: Blob;
      try {
        prepared = await prepareImage(blob);
      } catch (error) {
        return setStatus(error instanceof Error ? error.message : "That image couldn't be added.", true);
      }
      if (prepared.size > LIMITS.imageBytes) return setStatus("That image is too large, even shrunk. Try a smaller one.", true);
      const total = images.reduce((sum, image) => sum + image.blob.size, prepared.size);
      if (total > LIMITS.totalImageBytes) return setStatus("These images add up to too much. Remove one to add another.", true);
      images.push({ blob: prepared, url: URL.createObjectURL(prepared) });
      renderThumbs();
      setStatus("");
    }
  }

  async function capture() {
    dialog.close(); // out of the shot
    try {
      const shot = await captureTab();
      if (!dialog.open) dialog.showModal();
      if (shot) await addImages([shot]);
    } catch {
      if (!dialog.open) dialog.showModal();
      setStatus("The tab couldn't be captured. Try a screenshot instead.", true);
    }
  }

  function showDone(title: string, text: string) {
    $("[data-done-title]").textContent = title;
    $("[data-done-text]").textContent = text;
    form.hidden = true;
    done.hidden = false;
  }

  function reset() {
    images.forEach((image) => URL.revokeObjectURL(image.url));
    images = [];
    renderThumbs();
    message.value = "";
    pageBox.checked = false;
    for (const row of extraRows) row.box.checked = Boolean(row.extra.checked);
    setStatus("");
  }

  async function deliver(report: Report): Promise<SendResult> {
    if (options.send) return options.send(report);
    const outcome = await sendReport(report, { relay: options.relay!, app: options.app });
    if (outcome === "sent") return { status: "sent" };
    if (outcome === "retry") {
      return {
        status: "refused",
        error: "The feedback service couldn't be reached. Check your connection and try again; your message is still here.",
      };
    }
    return { status: "refused", error: outcome.refused };
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (sending) return;
    if (!message.value.trim()) {
      setStatus("Write a message first.", true);
      return message.focus();
    }
    const address = email.value.trim();
    if (address && !email.checkValidity()) {
      setStatus("That email address doesn't look right.", true);
      return email.focus();
    }
    sending = true;
    sendBtn.disabled = true;
    setStatus("Sending…");
    try {
      await loading;
      const sentErrors = errorsBox.checked;
      const checked = parseReport({
        id: newReportId(),
        kind: kind(),
        message: message.value,
        email: address || undefined,
        images: await Promise.all(
          images.map(async (image) => ({
            type: image.blob.type as ImageType,
            data: new Uint8Array(await image.blob.arrayBuffer()),
          }))
        ),
        version: appVersion,
        ...details(),
      });
      if (!checked.ok) return setStatus(checked.error, true);
      const result = await deliver(checked.report);
      if (result.status === "refused") return setStatus(result.error, true);
      try {
        if (address) storage()?.setItem(emailKey, address);
        else storage()?.removeItem(emailKey);
      } catch {}
      if (sentErrors) errors.clear();
      reset();
      if (result.status === "sent") {
        showDone(
          "Thanks, it's sent.",
          address
            ? `If there's a reply, it goes to ${address}.`
            : "It went without a reply address, so there's no way to answer it, but it will be read."
        );
      } else {
        showDone("Saved, and sent later.", "The feedback service couldn't be reached just now. It will be sent once it can.");
      }
    } catch (error) {
      setStatus(`That didn't go through (${describeError(error)}). Try again.`, true);
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }

  /** Load what the app adds; the preview fills in as it arrives. */
  function load() {
    loading = (async () => {
      const version = options.version;
      const [facts, values, looked] = await Promise.all([
        attempt(options.facts),
        Promise.all(extraRows.map((row) => attempt(() => row.extra.load()))),
        typeof version === "function" ? attempt(version) : undefined,
      ]);
      appFacts = facts ?? {};
      if (typeof version === "function") appVersion = looked ?? undefined;
      extraRows.forEach((row, i) => {
        row.value = values[i] ?? null;
        row.label.hidden = !row.value;
      });
      if (dialog.open) renderPreview();
    })();
  }

  function open(prefill: { kind?: string; message?: string } = {}) {
    applyTheme();
    form.hidden = false;
    done.hidden = true;
    if (prefill.kind) {
      const radios = Array.from(form.querySelectorAll<HTMLInputElement>("input[name=kind]"));
      const radio = radios.find((r) => r.value === prefill.kind);
      if (radio) radio.checked = true;
    }
    message.placeholder = kinds.find((k) => k.id === kind())?.placeholder ?? "";
    if (prefill.message && !message.value) message.value = prefill.message;
    if (!email.value) email.value = storage()?.getItem(emailKey) || options.email?.() || "";
    $("[data-page-path]").textContent = location.pathname;
    const recent = errors.read();
    $("[data-errors-row]").hidden = !recent.length;
    $("[data-errors-label]").textContent = `Errors ${appName} ran into in this tab (${recent.length})`;
    if (!dialog.open) dialog.showModal();
    message.focus();
    load();
    renderPreview();
  }

  // Wiring. Every listener is on the widget's own nodes, so taking the host
  // off the page takes them with it.
  if (options.button !== false) {
    launcher.dataset.position = options.button ?? "bottom-right";
    launcher.hidden = false;
    launcher.addEventListener("click", () => open());
  }
  root.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => dialog.close()));
  form.addEventListener("submit", submit);
  form.addEventListener("change", (event) => {
    if ((event.target as HTMLInputElement).name === "kind") {
      message.placeholder = kinds.find((k) => k.id === kind())?.placeholder ?? "";
    }
    renderPreview();
  });
  $("[data-pick]").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    void addImages(Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });
  if (options.captureTab !== false && canCaptureTab()) {
    $("[data-capture-wrap]").hidden = false;
    $("[data-capture]").addEventListener("click", () => void capture());
  }
  dialog.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const files = (
      data.files?.length
        ? Array.from(data.files)
        : Array.from(data.items ?? [])
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
    ).filter((file): file is File => Boolean(file?.type.startsWith("image/")));
    if (!files.length) return; // text goes where it was pasted
    event.preventDefault();
    void addImages(files);
  });
  dialog.addEventListener("dragover", (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    drop.classList.add("is-over");
  });
  dialog.addEventListener("dragleave", (event) => {
    if (!dialog.contains(event.relatedTarget as Node | null)) drop.classList.remove("is-over");
  });
  dialog.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    drop.classList.remove("is-over");
    void addImages(Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/")));
  });
  applyTheme();

  return {
    open,
    close: () => dialog.close(),
    recordError: (error) => errors.add(describeError(error)),
    destroy() {
      stopWatching();
      if (dialog.open) dialog.close();
      images.forEach((image) => URL.revokeObjectURL(image.url));
      host.remove();
    },
  };
}
