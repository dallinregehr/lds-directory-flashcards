const api = typeof browser !== 'undefined' ? browser : chrome;

api.action.onClicked.addListener(async (tab) => {
    let payload = { source: 'dom' };
    try {
        const [{ result } = {}] = await api.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: readReduxHouseholds,
            args: [{ storeTimeoutMs: 3000, dataTimeoutMs: 15000, intervalMs: 200 }],
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

async function readReduxHouseholds({ storeTimeoutMs, dataTimeoutMs, intervalMs }) {
    const start = Date.now();
    const storeDeadline = start + storeTimeoutMs;
    const dataDeadline = start + dataTimeoutMs;

    // Phase 1: wait for the Redux store to attach to window.
    while (Date.now() < storeDeadline) {
        const candidate = window.__NEXT_REDUX_STORE__;
        if (candidate && typeof candidate.getState === 'function') break;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (!window.__NEXT_REDUX_STORE__ || typeof window.__NEXT_REDUX_STORE__.getState !== 'function') {
        return null;
    }

    // Phase 2: wait for the households slice to populate. Re-read the store
    // each tick in case the SPA recreates it during navigation.
    while (Date.now() < dataDeadline) {
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
