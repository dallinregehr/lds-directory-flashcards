# Redux Store Source of Truth + Member Photo Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repo uses inline execution; do not dispatch Agent subagents.

**Goal:** Source household data from `window.__NEXT_REDUX_STORE__` instead of DOM scraping, and add a head-of-household member-photo fallback for flashcards.

**Architecture:** A background-script orchestrator runs an MV3 `executeScript({ world: 'MAIN' })` to snapshot the page's Redux state, injects the content script, then sends the data over `chrome.tabs.sendMessage`. Content script becomes message-driven: a `redux` source path builds flashcards with multi-photo support and HEAD probes; a `dom` source path preserves today's behavior as a fallback. The render layer accepts an array of 1–2 photo URLs per flashcard.

**Tech Stack:** Manifest V3 browser extension, vanilla JS, `chrome.scripting` + `chrome.tabs.sendMessage`, plain `fetch` for HEAD probes.

**Spec:** `docs/superpowers/specs/2026-05-18-redux-store-photo-fallback-design.md`

**No test framework exists in this repo.** Each task ends with a manual verification step performed against the live directory site by loading the unpacked extension in Chrome (and/or Firefox). No `git commit` steps are included — committing is left to the developer between tasks.

**Build/load workflow used throughout:**
```bash
node build.mjs chrome           # rebuild dist/chrome
```
Then in `chrome://extensions` with Developer Mode on, click "Reload" on the LDS Directory Flashcards extension. Open `https://directory.churchofjesuschrist.org/`, sign in, navigate to the household list, then click the extension toolbar icon.

To inspect logs:
- **Content script logs** appear in the directory tab's DevTools console.
- **Background script logs** appear in the extension's service worker DevTools — open via `chrome://extensions` → click "service worker" link under the extension.

---

## File structure

- **Modify:** `src/background.js` — becomes an orchestrator. Reads Redux from the page main world, injects `content.js`, sends an `INIT` message with the payload.
- **Modify:** `src/content.js` — wraps existing logic in a `chrome.runtime.onMessage` listener. Adds Redux path (`buildFlashcardsFromRedux`), shared helpers (`photoExists`, `withConcurrency`), renderer support for 1–2 photos. Preserves DOM path as fallback.
- **Modify:** `src/styles.css` — flex-row tweaks so 2 images sit side-by-side.

No new files; no manifest changes (existing `scripting` + `activeTab` cover both `executeScript` calls).

---

## Task 1: Make content.js message-driven and normalize data shape

Goal: Without changing behavior, refactor content.js so startup is triggered by an `INIT` message from background, and each flashcard record holds `photoUrls: string[]` (length 1) instead of `householdImgUrl: string`. Background sends `{ source: 'dom' }` to preserve today's behavior. This task isolates the plumbing change from the feature change.

**Files:**
- Modify: `src/background.js`
- Modify: `src/content.js`

- [ ] **Step 1: Rewrite `src/background.js` to inject content.js then send INIT**

Replace the entire file with:

```js
const api = typeof browser !== 'undefined' ? browser : chrome;

api.action.onClicked.addListener(async (tab) => {
    await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
    });
    await sendInitWithRetry(tab.id, { source: 'dom' });
});

async function sendInitWithRetry(tabId, payload, attempts = 5, delayMs = 100) {
    for (let i = 0; i < attempts; i++) {
        try {
            await api.tabs.sendMessage(tabId, { type: 'INIT', payload });
            return;
        } catch (err) {
            if (i === attempts - 1) {
                console.warn('LDS Directory Flashcards: sendMessage failed', err);
                return;
            }
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}
```

The retry loop covers the brief gap between `executeScript` resolving and the content script's message listener being registered.

- [ ] **Step 2: Wrap content.js startup in an INIT message listener**

In `src/content.js`, change the bottom of the file from:

```js
}
runExtension()
```

to:

```js
    // Wait for the INIT message from background before doing anything.
    chrome.runtime.onMessage.addListener(function initListener(message) {
        if (message?.type !== 'INIT') return;
        chrome.runtime.onMessage.removeListener(initListener);
        start(message.payload);
    });

    function start(payload) {
        if (payload?.source === 'redux') {
            // Implemented in a later task.
            console.warn('LDS Directory Flashcards: redux source not yet implemented; falling back to dom');
            startDom();
        } else {
            startDom();
        }
    }

    function startDom() {
        const READY_TIMEOUT_MS = 30000;
        const tryStart = () => {
            const selector = getQuerySelector();
            if (selector.length) {
                observer.disconnect();
                clearTimeout(readyTimeout);
                processSelectorAndStart(selector);
                return true;
            }
            return false;
        };
        const observer = new MutationObserver(tryStart);
        const readyTimeout = setTimeout(() => {
            observer.disconnect();
            console.warn('LDS Directory Flashcards: household list did not load within %dms', READY_TIMEOUT_MS);
        }, READY_TIMEOUT_MS);
        if (!tryStart()) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }
}
runExtension()
```

Then **delete the original startup block** that lives mid-file (the one currently at `content.js:49-67`, beginning `// Wait for the household list to render.` and ending with the `if (!tryStart())` call). It has been moved into `startDom()`. The `getQuerySelector` and `processSelectorAndStart` functions stay where they are.

- [ ] **Step 3: Change the data record shape from `householdImgUrl` to `photoUrls`**

In `processSelectorAndStart` (`content.js:210` area), update the mapping:

```js
fullData = [...selector].map(function(link) {
    const id = link.href.split('/').pop()
    return {
        householdHref: link.href,
        householdName: link.children[0].innerText,
        photoUrls: ['/api/v4/photos/households/' + id],
        householdId: id,
        hasImage: null,
    }
})
```

In `checkIfImagesExist`, update the probe to use the first (and only) URL in `photoUrls`:

```js
fullData.forEach(familyData => {
    checkIfImageExists(familyData.photoUrls[0], function(didLoad) {
        familyData.hasImage = didLoad
        loadingImgCount = loadingImgCount + 1;
        container.innerText = `Loading ${loadingImgCount}/${allHouseholdCount} flashcards...`

        if (loadingImgCount === allHouseholdCount) {
            resetList()
        }
    })
})
```

In `loadFamily`, update the image creation to use the first URL (still single-image rendering in this task):

```js
const img = el('img');
img.src = familyData.photoUrls[0];

const imageContainer = el('div', { className: 'image-container' },
    el('div', null, img)
);
```

- [ ] **Step 4: Manual verification — behavior unchanged**

Rebuild and reload:

```bash
node build.mjs chrome
```

Reload the extension in `chrome://extensions`. Open the directory, navigate to the household list, click the toolbar icon. Verify:

- Loading text appears (`Loading X/N flashcards...`).
- Deck shuffles and shows household photos with names.
- Arrow keys, space-to-reveal, hover-to-reveal, reshuffle button, close button all work.
- Console shows no errors.

If anything regressed, fix before moving on.

---

## Task 2: Renderer + CSS support for 1 or 2 images

Goal: Make `loadFamily` render one `<img>` per URL in `photoUrls`, and add CSS so two images sit side-by-side with equal width. Single-image case stays visually identical.

**Files:**
- Modify: `src/content.js`
- Modify: `src/styles.css`

- [ ] **Step 1: Update `loadFamily` to render an `<img>` per URL**

In `content.js`, replace the image-creation block in `loadFamily` (the section that starts `const img = el('img');`) with:

```js
const imageRow = el('div', { className: 'image-row' });
for (const url of familyData.photoUrls) {
    const img = el('img');
    img.src = url;
    imageRow.append(img);
}

const imageContainer = el('div', { className: 'image-container' },
    imageRow
);
```

- [ ] **Step 2: Add CSS for the image row**

In `src/styles.css`, replace the rule:

```css
.image-container div {
    display: flex;
    justify-content: center;
    width: 100%;
}
```

with:

```css
.image-row {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    gap: 12px;
}
.image-row img {
    flex: 1 1 0;
    min-width: 0;
    max-height: 100%;
    object-fit: contain;
}
```

The `.image-container img` rule already in the file (`max-height: 100%; object-fit: contain;`) becomes redundant once `.image-row img` covers it. Delete the old `.image-container img` rule.

- [ ] **Step 3: Manual verification — single-image case unchanged**

Rebuild + reload:

```bash
node build.mjs chrome
```

Open the directory, click the toolbar icon. Verify each flashcard still shows a single photo at the same apparent size and aspect ratio as before. (Two-image rendering is exercised in Task 5 — no visible difference expected yet.)

- [ ] **Step 4: Visual smoke test of the 2-image path**

In the directory tab's DevTools console, temporarily mutate a record to force a two-image render:

```js
// Find the flashcard's running data via the global if exposed,
// otherwise reload after editing one record at the source.
```

Easier alternative: temporarily change one record in `processSelectorAndStart` to:

```js
photoUrls: ['/api/v4/photos/households/' + id, '/api/v4/photos/households/' + id],
```

Rebuild, reload, navigate to that flashcard. Confirm two side-by-side, equally-sized images render correctly. Then **revert the temporary change** and rebuild once more before continuing.

---

## Task 3: Background reads Redux store and sends source='redux'

Goal: From `background.js`, run an MV3 `executeScript` with `world: 'MAIN'` that snapshots the Redux state, and pass it to content.js. Content.js logs receipt; no flashcard logic yet wired to the Redux payload.

**Files:**
- Modify: `src/background.js`
- Modify: `src/content.js`

- [ ] **Step 1: Add `readReduxHouseholds` and dual executeScript flow to `src/background.js`**

Replace the file with:

```js
const api = typeof browser !== 'undefined' ? browser : chrome;

api.action.onClicked.addListener(async (tab) => {
    let payload = { source: 'dom' };
    try {
        const [{ result } = {}] = await api.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: readReduxHouseholds,
            args: [{ timeoutMs: 30000, intervalMs: 200 }],
        });
        if (result) {
            payload = { source: 'redux', unitNumber: result.unitNumber, households: result.households };
        }
    } catch (err) {
        console.warn('LDS Directory Flashcards: Redux read failed', err);
    }

    await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
    });
    await sendInitWithRetry(tab.id, payload);
});

async function readReduxHouseholds({ timeoutMs, intervalMs }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const store = window.__NEXT_REDUX_STORE__;
        const state = store && typeof store.getState === 'function' ? store.getState() : null;
        const unitKey = state ? Object.keys(state.households || {})[0] : null;
        const households = unitKey ? state.households[unitKey] && state.households[unitKey].households : null;
        if (Array.isArray(households) && households.length > 0) {
            return {
                unitNumber: unitKey,
                households: JSON.parse(JSON.stringify(households)),
            };
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
}

async function sendInitWithRetry(tabId, payload, attempts = 5, delayMs = 100) {
    for (let i = 0; i < attempts; i++) {
        try {
            await api.tabs.sendMessage(tabId, { type: 'INIT', payload });
            return;
        } catch (err) {
            if (i === attempts - 1) {
                console.warn('LDS Directory Flashcards: sendMessage failed', err);
                return;
            }
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}
```

`readReduxHouseholds` is a named top-level function so MV3 can serialize and inject it as the script function. Avoid closures over outer-scope identifiers — the function runs in the page's main world.

- [ ] **Step 2: Update content.js `start()` to log the Redux payload (still routes to DOM path)**

In `src/content.js`, update `start()`:

```js
function start(payload) {
    if (payload?.source === 'redux') {
        console.info(
            'LDS Directory Flashcards: received Redux payload',
            payload.unitNumber,
            'with',
            payload.households.length,
            'households'
        );
        // Still falls back to DOM rendering until Task 5 wires this up.
        startDom();
    } else {
        console.info('LDS Directory Flashcards: Redux store unavailable, falling back to DOM scrape');
        startDom();
    }
}
```

- [ ] **Step 3: Manual verification — Redux payload arrives**

Rebuild + reload:

```bash
node build.mjs chrome
```

Open the directory, household list visible, click the toolbar icon. In the **directory tab's** DevTools console, expect a line like:

```
LDS Directory Flashcards: received Redux payload 2270870 with 136 households
```

Inspect the payload structure by adding a temporary `console.log(payload)` in `start()` and confirming members have a `head` field on at least some entries.

- [ ] **Step 4: Manual verification — DOM fallback when Redux is unavailable**

In the directory tab's DevTools console, before clicking the icon:

```js
delete window.__NEXT_REDUX_STORE__;
```

Then click the icon. Expect in the directory console:

```
LDS Directory Flashcards: Redux store unavailable, falling back to DOM scrape
```

And the extension should run normally via the DOM path. Reload the page after this test to restore the store.

---

## Task 4: Add `photoExists` + concurrency helpers in content.js

Goal: Introduce reusable helpers, no behavior change yet. Sanity-check HEAD support against the live API.

**Files:**
- Modify: `src/content.js`

- [ ] **Step 1: Add helpers near the top of `runExtension()` (after the constants, before `tryStart`-related code)**

Add:

```js
async function photoExists(url) {
    try {
        const resp = await fetch(url, { method: 'HEAD', credentials: 'include' });
        return resp.status === 200;
    } catch (_err) {
        return false;
    }
}

async function withConcurrency(tasks, limit = 5) {
    const results = [];
    const executing = new Set();
    for (const task of tasks) {
        const p = task().then((r) => { results.push(r); executing.delete(p); });
        executing.add(p);
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
}
```

- [ ] **Step 2: Sanity-check HEAD support against the live API**

In the directory tab's DevTools console (signed in), run:

```js
const r = await fetch('/api/v4/photos/households/REPLACE_WITH_REAL_UUID', { method: 'HEAD', credentials: 'include' });
console.log(r.status);
```

Replace `REPLACE_WITH_REAL_UUID` with any household uuid visible in `window.__NEXT_REDUX_STORE__.getState().households[<unit>].households[0].uuid`.

- If status is `200` (photo exists) or `204` (no photo) → HEAD works. Proceed.
- If status is `405` → HEAD is unsupported. Replace `photoExists` with an `Image()`-based probe **before continuing to Task 5**:

  ```js
  function photoExists(url) {
      return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = url;
      });
  }
  ```

  Note: the `Image()` form does not distinguish 204 from 404 — both arrive as `onerror`. That's fine; both mean "no photo."

- [ ] **Step 3: Manual verification — extension still runs**

Rebuild + reload + click the icon. Confirm the extension behaves exactly as in Task 3 (helpers exist but are not wired up).

---

## Task 5: Implement `buildFlashcardsFromRedux` and wire the Redux path

Goal: Replace the Redux-path stub from Task 3 with real flashcard construction: probe household photo, fall back to head member photos, drop households with no available photo, render with 1 or 2 photos.

**Files:**
- Modify: `src/content.js`

- [ ] **Step 1: Add `buildFlashcardsFromRedux` to content.js**

Add inside `runExtension()`, near the other helpers:

```js
async function buildFlashcardsFromRedux(payload) {
    const BASE = '/api/v4/photos';
    const householdsIn = payload.households;
    const container = document.getElementById(containerId);

    let completed = 0;
    function bumpProgress() {
        completed += 1;
        container.innerText = `Loading ${completed}/${householdsIn.length} flashcards...`;
    }

    const tasks = householdsIn.map((hh) => async () => {
        const hhUrl = `${BASE}/households/${hh.uuid}`;
        if (await photoExists(hhUrl)) {
            bumpProgress();
            return {
                householdUuid: hh.uuid,
                householdName: hh.name,
                photoUrls: [hhUrl],
            };
        }

        const heads = (hh.members || []).filter((m) => m.head === true);
        const memberUrls = [];
        for (const m of heads) {
            const memUrl = `${BASE}/members/${m.uuid}`;
            if (await photoExists(memUrl)) memberUrls.push(memUrl);
        }
        bumpProgress();

        if (memberUrls.length === 0) {
            return {
                householdUuid: hh.uuid,
                householdName: hh.name,
                photoUrls: [],
            };
        }
        return {
            householdUuid: hh.uuid,
            householdName: hh.name,
            photoUrls: memberUrls,
        };
    });

    const results = await withConcurrency(tasks, 5);

    const order = new Map(householdsIn.map((hh, i) => [hh.uuid, i]));
    results.sort((a, b) => order.get(a.householdUuid) - order.get(b.householdUuid));

    return results;
}
```

- [ ] **Step 2: Wire the Redux path in `start()` to build the deck**

Replace `start()` with:

```js
async function start(payload) {
    if (payload?.source === 'redux') {
        document.body.addEventListener('keyup', keyupListener);
        document.body.addEventListener('keydown', keydownListener);

        const container = document.createElement('div');
        container.id = containerId;
        container.className = 'container';
        container.innerText = 'Loading...';
        document.body.append(container);

        try {
            const results = await buildFlashcardsFromRedux(payload);
            allHouseholdCount = results.length;
            fullData = results.map((r) => ({
                householdName: r.householdName,
                photoUrls: r.photoUrls,
                hasImage: r.photoUrls.length > 0,
            }));
            resetList();
        } catch (err) {
            console.error('LDS Directory Flashcards: redux path failed; falling back to DOM', err);
            // Tear down what we created so startDom() can build fresh.
            document.body.removeEventListener('keyup', keyupListener);
            document.body.removeEventListener('keydown', keydownListener);
            document.getElementById(containerId)?.remove();
            startDom();
        }
        return;
    }

    console.info('LDS Directory Flashcards: Redux store unavailable, falling back to DOM scrape');
    startDom();
}
```

This duplicates the small setup/teardown that today lives in `processSelectorAndStart` (overlay container, keybinding listeners) so the two paths are independent. `resetList()` will filter on `hasImage`, which is `true` for any record with at least one photo URL (so already-filtered Redux records pass through), and shuffle + render.

- [ ] **Step 3: Manual verification — Redux happy path**

Rebuild + reload + click the icon on the household list page. Verify:

- Loading text increments smoothly toward the total household count.
- Final deck size is **≥ today's deck size** (households that previously lacked group photos but have head photos now appear).
- Flashcards using member-photo fallback show 1 or 2 photos side-by-side, with the household name shown on reveal.
- A single-parent household (one `head === true` member) shows one photo.
- Arrow keys, space-to-reveal, hover-to-reveal, reshuffle, and close all behave as before.
- The "Households without photos" note count is lower than before.

- [ ] **Step 4: Manual verification — DOM fallback still works**

In the directory console, before clicking the icon: `delete window.__NEXT_REDUX_STORE__`.

Click the icon. Confirm the DOM path runs (log message in console) and the deck loads with household-only photos as in the original behavior.

Reload the directory page to restore the store.

- [ ] **Step 5: Manual verification — early click on cold load**

Hard-reload the directory tab. **Immediately** click the toolbar icon while the page is still loading and `__NEXT_REDUX_STORE__` may not yet be attached.

Verify:

- Loading text appears.
- After page finishes loading and households populate, the deck builds and renders.
- No errors in the console.

This exercises the 30s polling loop in `readReduxHouseholds`.

---

## Task 6: End-to-end verification matrix

Goal: One pass that covers every promised behavior from the spec. No code changes unless a regression is found.

- [ ] **Step 1: Re-verify each scenario in the matrix below**

Build:

```bash
node build.mjs chrome
```

Reload extension. For each row, perform the action and confirm the expected result:

| # | Scenario | Action | Expected |
|---|----------|--------|----------|
| 1 | Redux happy path | Open directory, click icon | Deck loads from Redux; count ≥ baseline |
| 2 | Household with no group photo, both parents have photos | Find such a household in deck | Two photos side-by-side, household name |
| 3 | Single-parent household, parent has photo | Find such a household | One photo, household name |
| 4 | Household with no group photo and no head photos | Should NOT appear in deck | Confirmed missing from cycling |
| 5 | DOM fallback | `delete window.__NEXT_REDUX_STORE__` then click | DOM path runs; household-only photos |
| 6 | Early click | Hard reload, click icon immediately | Polls 30s, then renders |
| 7 | Keybindings | Cycle deck with ← → arrows | Works |
| 8 | Reveal | Hover and press space | Name reveals while held; hides on release |
| 9 | Reshuffle | Click reshuffle button | New shuffle order, deck reset to first card |
| 10 | Close | Click X | Overlay removed; keybindings detached |

- [ ] **Step 2: Build the Firefox target and smoke-test (if Firefox is installed)**

```bash
node build.mjs firefox
```

Load `dist/firefox` as a temporary extension in `about:debugging`. Repeat scenarios 1 and 5. Note any cross-browser issues — `world: 'MAIN'` is supported in Firefox ≥ 128.

- [ ] **Step 3: Final cleanup pass**

Re-read `src/content.js` and `src/background.js`:

- Remove any temporary `console.log` calls added during debugging.
- Confirm no dead code (e.g., orphaned helpers from earlier tasks).
- Confirm `processSelectorAndStart`, `getQuerySelector`, and `checkIfImagesExist` are still wired to the DOM path and untouched in semantics.

---

## Notes for the implementer

- **Why no `git commit` steps:** This repo's workflow has the developer commit manually between tasks. Don't auto-commit.
- **`world: 'MAIN'` and serialization:** Functions passed via `func:` in `executeScript` are stringified and re-parsed in the target world. They cannot close over outer-scope variables and must be top-level functions in the background file.
- **Why polling instead of `store.subscribe`:** Subscribe would require a long-lived MAIN-world script and a postMessage channel. Polling inside a single async `executeScript` invocation is simpler and the latency floor (200ms) is invisible against page-load times.
- **Member-photo URL format:** The spec assumes `/api/v4/photos/members/<uuid>` returns 200 for "photo exists" and 204 for "no photo." If Task 4 step 2 reveals different status semantics, adjust `photoExists` to treat the appropriate range as success.
- **`head` field guard:** `m.head === true` (strict equality) is intentional — a missing field is treated as not-a-head, never undefined-truthy nonsense.
