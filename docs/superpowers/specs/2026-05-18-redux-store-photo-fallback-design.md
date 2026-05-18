# Redux Store Source of Truth + Member Photo Fallback

**Status:** Draft
**Date:** 2026-05-18

## Goal

Make the extension more robust by sourcing household data from the directory site's Next.js Redux store instead of scraping the DOM, and improve flashcard coverage by falling back to head-of-household member photos when no group photo exists.

## Motivation

Today's `content.js` scrapes the household list with a CSS selector (`#app-page section div[data-scroll=true] div a[role=link]`) and reads the household name from `link.children[0].innerText`. Any class-name reshuffle by Next.js breaks the extension. Additionally, households with no group photo are silently dropped from the deck even when individual photos of the parents exist.

The directory site exposes its full state at `window.__NEXT_REDUX_STORE__`, including stable household UUIDs, member UUIDs, and a `head` flag identifying parents. Using that data gives us a more stable contract and unlocks the photo fallback.

## Non-goals

- Replacing the DOM-scrape path entirely. The current selector-based scrape is retained as a fallback for the case where the Redux store is unavailable, malformed, or shape-changed.
- Showing photos of members other than heads of household.
- Compositing multiple photos into a single image. Each flashcard renders 1 or 2 plain `<img>` elements side-by-side.
- Caching probe results across activations.
- Any change to the user-facing keybindings, blurred-name reveal, reshuffle, or navigation flow.

## High-level architecture

```
User clicks toolbar action
        │
        ▼
background.js
   ├─ executeScript(world: 'MAIN',  func: readReduxHouseholds)  ──▶ snapshot | null
   ├─ executeScript(files: ['content.js'])
   └─ tabs.sendMessage(tabId, { type: 'INIT', payload })
                                       │
                                       ▼
                              content.js (isolated world)
                                 ├─ payload.source === 'redux' ─▶ buildFlashcardsFromRedux
                                 └─ payload.source === 'dom'   ─▶ buildFlashcardsFromDom
```

Only the `world: 'MAIN'` step ever touches `window.__NEXT_REDUX_STORE__`. The content script remains a pure renderer and probe runner; it has no knowledge of Next.js or Redux.

## Components

### `src/background.js`

Currently 8 lines, ends up ~40. On `action.onClicked`:

1. Run `chrome.scripting.executeScript` with `world: 'MAIN'` and a function literal `readReduxHouseholds` (see below). The function returns a serializable snapshot or `null`.
2. Run `chrome.scripting.executeScript({ files: ['content.js'] })`.
3. Send `chrome.tabs.sendMessage(tabId, { type: 'INIT', payload })` where `payload` is one of:
   - `{ source: 'redux', unitNumber, households }` when step 1 succeeded.
   - `{ source: 'dom' }` when step 1 returned `null`.

The send must occur after step 2 resolves so the content script's message listener is registered. The content script confirms registration by responding to the message; the background retries the send up to ~5 times at 100ms intervals if the first send rejects with "Receiving end does not exist."

### `readReduxHouseholds` (runs in page main world)

Async polling loop, mirrors the existing 30s readiness timeout:

```js
async function readReduxHouseholds({ timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const store = window.__NEXT_REDUX_STORE__;
    const state = store?.getState?.();
    const unitKey = state ? Object.keys(state.households || {})[0] : null;
    const households = unitKey ? state.households[unitKey]?.households : null;
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
```

Handles three races:
1. `window.__NEXT_REDUX_STORE__` not yet attached — loop re-reads each tick.
2. Store attached but households slice not yet populated — wait for `length > 0`.
3. Store recreation on navigation — never holds a stale reference.

`JSON.parse(JSON.stringify(...))` ensures the result is structured-cloneable across the `executeScript` boundary and gives the content script a frozen snapshot.

### `src/content.js` — Redux path: `buildFlashcardsFromRedux(payload)`

A concurrency limiter (limit 5) operates *across households* — each task is a full per-household resolve. Within a household, probes are sequential:

1. Probe `/api/v4/photos/households/${household.uuid}`.
   - If 200 → `photoUrls = [<that URL>]`. Done.
   - If non-200 → continue to step 2.
2. Collect the head members: `household.members.filter(m => m.head === true)` in the member array's natural order (no extra sort). For each, probe `/api/v4/photos/members/${member.uuid}` and keep the URLs that return 200. Result is a `photoUrls` array of length 0, 1, or 2.
3. If `photoUrls.length === 0`, drop the household from the deck.
4. Otherwise, the per-household record is:
   ```js
   {
     householdUuid,
     householdName,    // from Redux `household.name`
     photoUrls,        // string[] of length 1 or 2
   }
   ```

With limit 5 and up to 3 sequential probes per household, the worst-case in-flight HEAD count is 5.

### `src/content.js` — DOM fallback path: `buildFlashcardsFromDom()`

Identical to today's `processSelectorAndStart`: selector scrape, household-photo URL only, `Image()` probe. Member fallback is not available without Redux UUIDs. Each record's `photoUrls` is a single-element array, normalizing the shape so the renderer doesn't branch.

A one-time `console.info('LDS Directory Flashcards: Redux store unavailable, falling back to DOM scrape')` runs before the DOM probe so the fallback is debuggable.

### `photoExists(url)`

```js
async function photoExists(url) {
  const resp = await fetch(url, { method: 'HEAD', credentials: 'include' });
  return resp.status === 200;
}
```

If during implementation HEAD returns 405 against the live API, swap the implementation for an `Image()`-based probe (same logic as today, two URLs per household).

### Concurrency limiter

A small helper that takes an array of task-producing thunks and a limit (5), runs them with at most `limit` outstanding, and returns results in completion order. Results are sorted back into household order at the end via a uuid→index map.

### Render layer

The current renderer (`loadFamily`) reads `familyData.householdImgUrl` (a single string) and creates one `<img>`. After the change:

- Each record exposes `photoUrls` (array of length 1 or 2).
- `loadFamily` creates one `<img>` per URL inside a flex row container.
- Single-image cards visually match today; two-image cards show equal-width images with a small gap.

### `src/styles.css`

Add the flex row container, equal-width children (`flex: 1 1 0`), and a small `gap`. No other style changes.

### `src/manifest.base.json`

No change. `scripting` + `activeTab` already cover both `executeScript` calls and the message send.

## Data flow per household

```
Redux household ─▶ candidate URLs ─▶ photoExists probes (limit=5) ─▶ photoUrls[]
                                                                       │
                                                                       ▼
                                                          { householdName, photoUrls }
                                                                       │
                                                                       ▼
                                                                shuffle + render
```

## UX changes

- Flashcard image area renders 1 *or* 2 images side-by-side. Single-image case visually unchanged.
- Household name is unchanged (still `household.name`). Blurred reveal, space-to-show, hover-to-show: all unchanged.
- The "Households without photos" note count goes down whenever a household had no group photo but at least one head member with a photo.
- `Loading X/N flashcards...` increments per household (not per photo), so progress matches the household total regardless of how many candidate URLs a household needed to probe.

## Error handling

- **Redux read times out (30s):** return `null`, content script runs DOM fallback.
- **Redux read throws:** background wraps the `executeScript` call in try/catch, treats throw as `null`, runs DOM fallback.
- **`tabs.sendMessage` rejects with no receiver:** retry up to 5× at 100ms; if still failing, log and abort silently. The content script's overlay won't appear, matching today's failure mode.
- **All `photoExists` probes fail for a household:** drop it from the deck (same as today).
- **HEAD returns 405 in the live environment:** swap `photoExists` for an `Image()` probe during implementation. Not a spec change.

## Things to verify during implementation

These are not blockers — each has a defined fallback — but they should be confirmed against the live site:

1. HEAD support on `/api/v4/photos/households/:uuid` and `/api/v4/photos/members/:uuid`. If 405, switch to `Image()` probe.
2. The `head` field exists on member objects in the live store as `head === true`. Guard: `m.head === true` so missing field = not head.
3. The state path `state.households[unitNumber].households` matches across all directory routes the extension targets. If a route uses a different path, `readReduxHouseholds` returns `null` and DOM fallback takes over.

## Testing approach

Manual, since the extension talks to a live authenticated site and has no existing test harness.

- Load the directory, click the action — verify Redux path. Confirm count of flashcards is ≥ today's count.
- Spot-check a household that had no group photo previously: should now appear with 1 or 2 parent photos.
- Spot-check a single-parent household: should appear with exactly 1 parent photo.
- Block `window.__NEXT_REDUX_STORE__` (DevTools: `delete window.__NEXT_REDUX_STORE__` before clicking) — verify DOM fallback runs and matches today's behavior.
- Click the action immediately on page load (before list renders) — verify the 30s polling wait works.
- Keyboard nav, reveal, reshuffle, close — verify unchanged.

## Out of scope / future work

- Caching probe results across activations.
- Showing non-head member photos.
- Image compositing.
- A real test harness.
