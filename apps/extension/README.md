# Jobber — Cover Letter Companion (Chrome extension)

Scan any job-description page, get a one-paragraph cover letter drafted by
**your** Jobber API (the key never leaves the server), edit it in a sidebar,
then copy it, download it as a PDF, or attach the PDF straight into the page's
"upload cover letter" widget.

## Build

```sh
pnpm --filter extension build      # bundles src/ → apps/extension/dist/
```

## Install (once)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. **Load unpacked** → pick `apps/extension/dist`.
3. Pin the extension. Rebuild + press the ↻ refresh icon on the card after
   code changes.

## Use

1. Make sure the API is running (`pnpm --filter api dev`).
2. On a job posting page, (optionally) select the description text, then click
   the toolbar button — the sidebar opens.
3. **Scan page → Generate** → edit the letter in the textarea.
4. **Copy**, **Download PDF**, or **Attach to page** (fills the page's file
   input); for drag-and-drop upload zones, drag the **⠿ chip** onto the zone.

Always verify the page actually shows the attached file before you hit the
site's submit button — the extension never submits anything for you.

## Settings (top of the sidebar)

- **API** — base URL of the Jobber API. Default `http://localhost:3001`. If
  the API runs on another LAN machine, also add that origin to
  `host_permissions` in `manifest.json` and rebuild (match patterns can't
  wildcard IPs, so it must be listed explicitly, e.g.
  `"http://192.168.1.50/*"`).
- **Name** — who signs the letter. Default "Michael Brown".
