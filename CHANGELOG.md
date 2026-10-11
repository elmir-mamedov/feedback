# Changelog

Each release, newest first. Versions follow [semver](https://semver.org). The
protocol version is the report format's, in the URL reports are posted to;
see "Versions" in the README.

## 0.2.0 (2026-10-11)

Protocol v1, unchanged: relays built from 0.1.0 serve this release too.

- The widget's `version` option also takes a function, possibly async, asked
  each time the dialog opens.

## 0.1.0 (2026-10-11)

The first release, extracted from KB25's feedback feature. Protocol v1.

- The report format (`parseReport`, `reportForm`, `readReportForm`,
  `readReportBody`) and `sendReport()`.
- `createRelay()`: one Cloudflare Worker for many apps, each filing into its
  own private repo, with CORS for apps that post from the browser.
- `mountFeedback()`: the dialog, in its own shadow root, with screenshots,
  tab capture, kept errors, app facts and opt-in extras.
- `createOutbox()`, `logTail()` and `describeOs()` for apps that run on the
  user's machine.
