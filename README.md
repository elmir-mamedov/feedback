# feedback

A **Send feedback** dialog for any web app, and a relay that turns what people
send into issues in a private GitHub repo, screenshots included. There's no
SaaS account and no database: the relay is a Cloudflare Worker that fits the
free plan, and the reports live in your GitHub.

```
your app ──── report ────▶ relay ─────────────────────▶ private GitHub repo
(the dialog)               (Cloudflare Worker,          an issue per report,
                            holds the GitHub token)      images committed beside it
```

A report is a message, a kind (bug, idea, question, or your own), an optional
reply address, up to five screenshots (pasted, dropped, picked, or a capture
of the tab), and whatever else the person chose to include: the app's version,
their browser, the page they were on, errors the app ran into, a log tail.
The dialog shows exactly what goes before anything is sent.

| Import                            | Runs in            | What it is                                                 |
| --------------------------------- | ------------------ | ---------------------------------------------------------- |
| `@elmir-mamedov/feedback/widget`  | the browser        | `mountFeedback()`, the dialog                              |
| `@elmir-mamedov/feedback/relay`   | Cloudflare Workers | `createRelay()`, the relay                                 |
| `@elmir-mamedov/feedback/node`    | Node               | `createOutbox()` and friends, for apps on the user's machine |
| `@elmir-mamedov/feedback`         | anywhere           | the report format, `parseReport()`, `sendReport()`         |

## Set up the relay (once)

One relay serves all your apps, each filing into its own repo.

1. Create a private repo for each app's reports, such as `you/fitness-feedback`.
   Each kind becomes an issue label.
2. Create a fine-grained token at
   <https://github.com/settings/personal-access-tokens/new> with access to
   only those repos, and **Contents** and **Issues** set to read and write.
3. Copy [`examples/relay`](examples/relay) somewhere of its own and list your
   apps in `src/index.ts`:

   ```ts
   import { createRelay } from "@elmir-mamedov/feedback/relay";

   export default createRelay({
     apps: {
       fitness: {
         repo: "you/fitness-feedback",
         name: "Fitness",
         // Pages that post straight from the browser; include the dev server.
         origins: ["https://fitness.example.com", "http://localhost:5173"],
       },
       kb25: { repo: "you/kb25-feedback", name: "KB25" }, // posts from its own server
     },
   });
   ```

4. `npm install`, store the token with `npx wrangler secret put GITHUB_TOKEN`,
   then `npm run deploy`.

To add an app later, add its entry, give the token access to its repo, and
deploy again. To swap the token, run step 4's `secret put` again; that takes
effect without a deploy.

GitHub doesn't notify you about issues your own token opens. To get an email
for each report, watch the repo (All Activity) and turn on **Include your own
updates** under Settings → Notifications → Email.

## Add the dialog to a web app

```bash
npm install github:elmir-mamedov/feedback#v0.1.0
```

```ts
import { mountFeedback } from "@elmir-mamedov/feedback/widget";

const feedback = mountFeedback({
  app: "fitness", // its id on the relay
  appName: "Fitness",
  relay: "https://feedback-relay.you.workers.dev",
  version: import.meta.env.VITE_APP_VERSION,
});
```

That adds a round button in the bottom-right corner that opens the dialog. In
React, mount it once near the root:

```tsx
export function Feedback() {
  const { user } = useAuth();
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    const feedback = mountFeedback({
      app: "fitness",
      appName: "Fitness",
      relay: import.meta.env.VITE_FEEDBACK_RELAY,
      // Read when the dialog opens, so signing in doesn't remount it and lose a draft.
      email: () => userRef.current?.email,
      facts: () => ({ Account: userRef.current?.id ?? "signed out" }),
    });
    return () => feedback.destroy();
  }, []);

  return null;
}
```

The dialog lives in a shadow root, so the app's CSS (Tailwind included) and its
own never touch. It follows the system's light or dark theme; pass `theme` to
follow the app's instead, and set any of `--feedback-accent`, `--feedback-fg`,
`--feedback-muted`, `--feedback-surface`, `--feedback-field`, `--feedback-line`,
`--feedback-code`, `--feedback-hover`, `--feedback-error` or `--feedback-radius`
on `:root` to match its colours. The font is the page's.

### Options

| Option          | What it does                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `app`           | The app's id on the relay. Required.                                                                           |
| `appName`       | The app's name as people know it, used in the dialog's text. Required.                                          |
| `relay`         | The relay's URL. Required unless `send` is given.                                                              |
| `send`          | `(report) => Promise<SendResult>`: send some other way, such as through the app's own server.                  |
| `version`       | The app's version, sent with every report. A function, possibly async, is asked each time the dialog opens.     |
| `kinds`         | `{ id, label, placeholder? }[]`; bug, idea and question unless set. The relay's `kinds` for the app must match. |
| `facts`         | `() => Facts`, possibly async: facts that always go, shown before sending. Asked each time the dialog opens.   |
| `extras`        | `{ label, checked?, load }[]`: things a person may tick, such as a log tail. `load` returns `{ facts?, logs? }` or nothing to hide the row. |
| `email`         | `() => string`: a reply address to offer, such as the signed-in person's.                                       |
| `button`        | `"bottom-right"` (the default), `"bottom-left"`, `"top-right"`, `"top-left"`, or `false` to open it yourself.   |
| `theme`         | `"auto"` (the default), `"light"`, `"dark"`, or a function asked each time the dialog opens.                   |
| `captureErrors` | Keep the page's uncaught errors so a report can carry them. On unless `false`.                                  |
| `captureTab`    | Offer to capture the tab where the browser can (desktop browsers). On unless `false`.                          |
| `container`     | Where the widget is attached; `document.body` unless set.                                                      |

`mountFeedback()` returns `{ open(prefill?), close(), recordError(error), destroy() }`.
`open({ kind: "bug", message: "…" })` starts a report, for a "Report this
problem" button on an error screen, and `recordError()` keeps an error the app
caught itself, such as one an error boundary saw, for the next report.

Every report also carries the browser (its user agent) and the window's size.
The page's address goes only when ticked, and errors are ticked by default but
can be unticked.

## Apps that run on the user's machine

An app like KB25 runs as a local server with a web UI, on each user's own
machine. Its dialog sends reports to that server, which knows things the page
doesn't (the OS, the server's log) and can keep a report while the relay is
unreachable:

```ts
// The page
import { reportForm } from "@elmir-mamedov/feedback";
import { mountFeedback } from "@elmir-mamedov/feedback/widget";

const info = () => fetch("/_feedback").then((res) => res.json());

mountFeedback({
  app: "kb25",
  appName: "KB25",
  button: false,
  send: (report) => fetch("/_feedback", { method: "POST", body: reportForm(report) }).then((res) => res.json()),
  facts: () => info().then((i) => i.facts),
  extras: [{ label: "The last lines of KB25's log", load: () => info().then((i) => i.logs && { logs: i.logs }) }],
});
```

```ts
// The server
import { readReportBody } from "@elmir-mamedov/feedback";
import { createOutbox, describeOs, logTail } from "@elmir-mamedov/feedback/node";

const outbox = createOutbox({ relay: RELAY_URL, app: "kb25", dir: path.join(dataDir, "feedback-outbox") });
outbox.startRetrying();

// GET /_feedback answers what the page shows and sends:
//   { facts: { OS: describeOs(), Node: process.version }, logs: logTail([logFile]) }

// POST /_feedback reads the raw body as bytes:
const parsed = await readReportBody(rawBody, contentType);
return parsed.ok ? outbox.submit(parsed.report) : { status: "refused", error: parsed.error };
```

`submit()` answers `{ status: "queued" }` when the relay couldn't take the
report, and the dialog tells the person it will be sent later. `logTail()`
shows the home folder as `~`, so a report doesn't carry the account name.

## Versions

### Each app keeps the version it was built with

Install a tagged release, and that app stays on it until you choose to move:

```bash
npm install github:elmir-mamedov/feedback#v0.1.0
```

`package.json` records the tag and `package-lock.json` the exact commit, so a
fresh clone, CI or a new machine gets the same code. A newer release changes
nothing in an app until you install it there, and each app upgrades on its own
schedule. Tags are never moved or deleted, so every release stays installable.
Installing from git needs `git` where you install, and builds the package on
install.

Releases follow [semver](https://semver.org): a patch fixes, a minor adds, a
major needs something changed in the app. [CHANGELOG.md](CHANGELOG.md) says
what each one changed.

### The relay keeps every protocol version

The relay is the one shared piece: every app posts to the same deployment, so
updating it must not break an app still on an old release. That's why the
report format has a **protocol version** of its own, in the URL reports are
posted to (`/v1/<app>/reports`), separate from the package's version.

- Within a protocol version, changes are additive only: a new optional field,
  or a looser limit. Never a renamed, removed or newly required field, and
  never a tighter limit.
- Anything else is a new protocol version, `/v2/`, and the relay serves it
  beside `/v1/`. A release of this package never takes a protocol version out
  of `createRelay()`, so a relay built from the newest release still serves
  apps built with the oldest.
- Update the relay first, then the apps: an app can only use what its relay
  already speaks. `GET /` on a relay lists its versions.

Most releases (the dialog's look, new options, fixes) don't touch the protocol
at all.

## Security

The relay's URL ships in apps' public code, so anyone can post to it. It holds
the GitHub token, which never leaves it, and enforces every limit itself:
body and image sizes, image types checked against their file signatures, field
lengths, each app's kinds, and five reports a minute per address (the
`RATE_LIMIT` binding). @-mentions are defused, so nobody can ping GitHub users
through it.

`origins` keeps other websites from posting through a visitor's browser. It
isn't authentication: anything but a browser can claim any origin.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests run on Node's own runner (Node 22.18 or later), with
[happy-dom](https://github.com/capricorn86/happy-dom) for the widget. To see the
dialog, build, serve this folder (`python3 -m http.server`) and open
`/examples/demo/?open`; add `&theme=dark` for the dark theme. The demo sends
nothing, it logs reports to the console.

## License

MIT
