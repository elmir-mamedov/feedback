/**
 * The widget's styles. They live in its shadow root, so the page's CSS and
 * these never touch. Colours come from --feedback-* custom properties, which
 * the page may set on :root (they inherit into the shadow root); each falls
 * back to a default for the light or dark theme. The font is the page's.
 */

const LIGHT = `
  color-scheme: light;
  --fb-accent: var(--feedback-accent, #0969da);
  --fb-on-accent: var(--feedback-on-accent, #ffffff);
  --fb-fg: var(--feedback-fg, #1f2328);
  --fb-muted: var(--feedback-muted, #59636e);
  --fb-surface: var(--feedback-surface, #ffffff);
  --fb-field: var(--feedback-field, #ffffff);
  --fb-line: var(--feedback-line, #d1d9e0);
  --fb-code: var(--feedback-code, #f6f8fa);
  --fb-hover: var(--feedback-hover, rgba(31, 35, 40, 0.06));
  --fb-error: var(--feedback-error, #cf222e);
  --fb-backdrop: rgba(31, 35, 40, 0.45);
  --fb-shadow: 0 16px 48px rgba(31, 35, 40, 0.2);
`;

const DARK = `
  color-scheme: dark;
  --fb-accent: var(--feedback-accent, #4493f8);
  --fb-on-accent: var(--feedback-on-accent, #ffffff);
  --fb-fg: var(--feedback-fg, #f0f6fc);
  --fb-muted: var(--feedback-muted, #9198a1);
  --fb-surface: var(--feedback-surface, #151b23);
  --fb-field: var(--feedback-field, #0d1117);
  --fb-line: var(--feedback-line, #3d444d);
  --fb-code: var(--feedback-code, #0d1117);
  --fb-hover: var(--feedback-hover, rgba(240, 246, 252, 0.08));
  --fb-error: var(--feedback-error, #f85149);
  --fb-backdrop: rgba(1, 4, 9, 0.7);
  --fb-shadow: 0 16px 48px rgba(1, 4, 9, 0.6);
`;

export const STYLES: string = `
:host {
  all: initial;
  ${LIGHT}
  --fb-radius: var(--feedback-radius, 10px);
  font-family: inherit;
}
:host([data-theme="dark"]) { ${DARK} }
@media (prefers-color-scheme: dark) {
  :host([data-theme="auto"]) { ${DARK} }
}

[hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }

.launcher {
  position: fixed; z-index: 2147483000; width: 44px; height: 44px; padding: 0;
  display: grid; place-items: center; border: 1px solid var(--fb-line); border-radius: 50%;
  color: var(--fb-fg); background: var(--fb-surface); box-shadow: var(--fb-shadow); cursor: pointer;
}
.launcher:hover { color: var(--fb-accent); }
.launcher:focus-visible { outline: 2px solid var(--fb-accent); outline-offset: 2px; }
.launcher[data-position$="right"] { right: max(16px, env(safe-area-inset-right)); }
.launcher[data-position$="left"] { left: max(16px, env(safe-area-inset-left)); }
.launcher[data-position^="bottom"] { bottom: max(16px, env(safe-area-inset-bottom)); }
.launcher[data-position^="top"] { top: max(16px, env(safe-area-inset-top)); }
.launcher svg { display: block; }

.dialog {
  width: min(560px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto;
  margin: auto; padding: 0; border: 1px solid var(--fb-line); border-radius: var(--fb-radius);
  color: var(--fb-fg); background: var(--fb-surface); box-shadow: var(--fb-shadow);
  font-family: inherit; font-size: 14px; line-height: 1.5; text-align: start;
}
.dialog::backdrop { background: var(--fb-backdrop); }

.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px 0; }
.head h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.3; }
.close {
  width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: none;
  color: var(--fb-muted); font: inherit; font-size: 22px; line-height: 1; cursor: pointer;
}
.close:hover { background: var(--fb-hover); color: var(--fb-fg); }

.body { display: flex; flex-direction: column; gap: 12px; padding: 12px 20px 20px; }
.intro { margin: 0; color: var(--fb-muted); }
.label { margin: 0 0 -6px; padding: 0; font-size: 13px; font-weight: 600; }
.optional { font-weight: 400; color: var(--fb-muted); }

.kinds { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.kinds legend { margin-bottom: 8px; padding: 0; }
.kinds label {
  position: relative; padding: 4px 12px; border: 1px solid var(--fb-line); border-radius: 999px;
  color: var(--fb-muted); font-size: 13px; cursor: pointer;
}
.kinds input { position: absolute; opacity: 0; pointer-events: none; }
.kinds label:hover { background: var(--fb-hover); }
.kinds label:has(input:checked) {
  border-color: var(--fb-accent); color: var(--fb-accent);
  background: color-mix(in srgb, var(--fb-accent) 12%, transparent);
}
.kinds label:has(input:focus-visible) { outline: 2px solid var(--fb-accent); outline-offset: 1px; }

textarea, input[type="email"] {
  display: block; width: 100%; margin: 0; padding: 8px 10px; border: 1px solid var(--fb-line); border-radius: 6px;
  color: var(--fb-fg); background: var(--fb-field); font: inherit; font-size: 14px; line-height: 1.5;
}
textarea { min-height: 120px; resize: vertical; }
textarea:focus, input[type="email"]:focus {
  outline: 2px solid color-mix(in srgb, var(--fb-accent) 35%, transparent); border-color: var(--fb-accent);
}
textarea::placeholder, input::placeholder { color: var(--fb-muted); opacity: 0.8; }

.drop { padding: 10px 12px; border: 1px dashed var(--fb-line); border-radius: 8px; }
.drop.is-over { border-color: var(--fb-accent); background: color-mix(in srgb, var(--fb-accent) 8%, transparent); }
.hint { margin: 0; color: var(--fb-muted); font-size: 13px; }
.link { padding: 0; border: 0; background: none; color: var(--fb-accent); font: inherit; text-decoration: underline; cursor: pointer; }

.thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
.thumbs:not(:empty) { margin-bottom: 8px; }
.thumb {
  position: relative; width: 96px; height: 72px; margin: 0; overflow: hidden;
  border: 1px solid var(--fb-line); border-radius: 6px; background: var(--fb-code);
}
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.thumb button {
  position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%;
  background: rgba(0, 0, 0, 0.65); color: #fff; font: inherit; font-size: 15px; line-height: 22px; cursor: pointer;
}

.details summary { color: var(--fb-muted); font-size: 13px; cursor: pointer; }
.details[open] summary { margin-bottom: 8px; }
.checks { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
.checks label { display: flex; align-items: baseline; gap: 6px; color: var(--fb-muted); font-size: 13px; }
.checks code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.preview {
  max-height: 180px; margin: 0; padding: 8px 10px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  border: 1px solid var(--fb-line); border-radius: 6px; background: var(--fb-code); color: var(--fb-muted);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.status { margin: 0; color: var(--fb-muted); font-size: 13px; }
.status:empty { display: none; }
.status.is-error { color: var(--fb-error); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.button {
  padding: 6px 14px; border: 1px solid var(--fb-line); border-radius: 6px;
  color: var(--fb-fg); background: var(--fb-surface); font: inherit; font-size: 14px; font-weight: 500; line-height: 1.5; cursor: pointer;
}
.button:hover { background: var(--fb-hover); }
.button.primary { border-color: var(--fb-accent); color: var(--fb-on-accent); background: var(--fb-accent); }
.button.primary:hover { background: color-mix(in srgb, var(--fb-accent) 88%, black); }
.button:disabled { opacity: 0.6; cursor: default; }
.button:focus-visible, .link:focus-visible, .close:focus-visible { outline: 2px solid var(--fb-accent); outline-offset: 2px; }
.done-title { margin: 0; font-size: 16px; font-weight: 600; }

/* Phones zoom into any field under 16px. */
@media (max-width: 640px) {
  textarea, input[type="email"] { font-size: 16px; }
}
`;
