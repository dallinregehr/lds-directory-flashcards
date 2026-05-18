# LDS Directory Flashcards

A browser extension that helps you learn the names of members in your ward.
When activated on `directory.churchofjesuschrist.org`, it shuffles through
household photos and lets you reveal each family's name.

Supports Chrome and Firefox (including Zen) from a single source tree.

## Developing

Prerequisites: Node 18 or newer. No npm dependencies are installed.

Build both browsers into `dist/`:

```sh
npm run build
```

Watch mode (rebuild on save):

```sh
npm run watch
```

### Loading the unpacked extension

**Chrome.** Open `chrome://extensions`, enable Developer mode, click
"Load unpacked", and select `dist/chrome/`. After a rebuild, click the
reload icon on the extension's card.

**Firefox.** Open `about:debugging`, click "This Firefox", click
"Load Temporary Add-on…", and select `dist/firefox/manifest.json`. After
a rebuild, click the extension's "Reload" button on that page.

### Packaging for the stores

```sh
npm run package
```

Produces `dist/chrome-<version>.zip` and `dist/firefox-<version>.zip`,
ready to upload to the Chrome Web Store and Firefox AMO respectively.

## Layout

- `src/` — source of truth.
  - `manifest.base.json` — shared manifest keys.
  - `manifest.chrome.json`, `manifest.firefox.json` — per-browser overrides
    deep-merged onto the base at build time.
  - `background.js`, `content.js`, `styles.css` — extension code.
- `build.mjs` — ~80-line build script. No dependencies.
- `dist/` — build output (gitignored).
