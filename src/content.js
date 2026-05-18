// ------------------------------------------------
// LDS Directory Flashcards
//
// When the browser extension is activated:
// - wait until the household list has loaded
// - iterate over household list and save id, img url, etc
// - create and display popup with loading text
// - traverse image urls and prefetch them so navigating flashcards is snappy (can take a few seconds)
// - keep user up-to-date on progress so program doesn't appear to be hung
// - load first household with image, name, and controls
// - respond as indicated by user's interactions with buttons or keybindings
// ------------------------------------------------

// wrap whole extension so retriggering extension after it has been closed doesn't error
// on everthing below being redeclared
function runExtension() {

    const containerId = 'quiz-container'
    const flashcardNameDisplayId = 'flashcard-display-name'

    // Prevent stacking duplicate overlays / listeners on repeat clicks
    if (document.getElementById(containerId)) return;

    let fullData = [];
    let workingData = [];
    let currentListIndex = -1;
    let allHouseholdCount = 0;

    // Shared by both the Redux and DOM startup paths.
    const keydownListener = function(event) {
        if (event.key === 'ArrowRight') {
            nextFamily()
        } else if (event.key === 'ArrowLeft') {
            previousFamily()
        } else if (event.key === ' ') {
            showDisplayName()
        }
    }

    const keyupListener = function(event) {
        if (event.key === ' ') {
            hideDisplayName()
        }
    }

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

    function getQuerySelector() {
        return document.querySelectorAll('#app-page section div[data-scroll=true] div a[role=link]')
    }

    function checkIfImagesExist() {

        // keep track of how many images checked so user can see progress
        let loadingImgCount = 0;

        function checkIfImageExists(url, callback) {
            const img = new Image();
            img.onload = () => callback(true);
            img.onerror = () => callback(false);
            img.src = url;
        }

        const container = document.getElementById(containerId)

        fullData.forEach(familyData => {
            checkIfImageExists(familyData.photoUrls[0], function(didLoad) {
                familyData.hasImage = didLoad
                loadingImgCount = loadingImgCount + 1;
                container.innerText = `Loading ${loadingImgCount}/${allHouseholdCount} flashcards...`

                // display once all images have been checked
                if (loadingImgCount === allHouseholdCount) {
                    resetList()
                }
            })
        })
    }


    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    // create a new full randomized family list
    function resetList() {
        currentListIndex = -1;
        workingData = fullData.filter(f => f.hasImage)
        shuffleArray(workingData)
        nextFamily()
    }

    function nextFamily() {
        if ((currentListIndex + 1) < workingData.length) {
            currentListIndex++
            loadFamily(workingData[currentListIndex])
        }
    }

    function previousFamily() {
        if ((currentListIndex - 1) >= 0) {
            currentListIndex--;
            loadFamily(workingData[currentListIndex])
        }
    }

    function showDisplayName() {
        document.getElementById(flashcardNameDisplayId).classList.add('revealed')
    }

    function hideDisplayName() {
        document.getElementById(flashcardNameDisplayId).classList.remove('revealed')
    }

    function closeQuiz() {
        // cleanup
        document.body.removeEventListener('keyup', keyupListener)
        document.body.removeEventListener('keydown', keydownListener)
        document.getElementById(containerId).remove()
    }

    function el(tag, props, ...children) {
        const node = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (k === 'className') node.className = v;
                else if (k === 'textContent') node.textContent = v;
                else node.setAttribute(k, v);
            }
        }
        for (const child of children) {
            if (child == null) continue;
            node.append(child);
        }
        return node;
    }

    function preloadFlashcard(familyData) {
        if (!familyData) return;
        for (const url of familyData.photoUrls) {
            const img = new Image();
            img.src = url;
        }
    }

    function loadFamily(familyData) {
        const container = document.getElementById(containerId);
        container.replaceChildren();

        const imageRow = el('div', { className: 'image-row' });
        for (const url of familyData.photoUrls) {
            const img = el('img');
            img.src = url;
            imageRow.append(img);
        }

        preloadFlashcard(workingData[currentListIndex + 1]);
        preloadFlashcard(workingData[currentListIndex + 2]);

        const imageContainer = el('div', { className: 'image-container' },
            imageRow
        );

        const nameDisplay = el('div', { id: flashcardNameDisplayId, className: 'display-name' });
        nameDisplay.textContent = familyData.householdName;

        const prevBtn = el('button', { id: 'quiz-prev-btn', className: 'prev-next-btn', textContent: '❮' });
        const nextBtn = el('button', { id: 'quiz-next-btn', className: 'prev-next-btn', textContent: '❯' });
        const reshuffleBtn = el('button', { id: 'quiz-reshuffle-btn', className: 'reshuffle-btn', textContent: '↩ Reshuffle' });
        const closeBtn = el('button', { id: 'quiz-close-btn', className: 'close-btn', title: 'close flashcards', 'aria-label': 'Close flashcards', textContent: '✕' });

        const progress = el('div', null,
            el('div', { textContent: `${currentListIndex + 1} / ${workingData.length}` })
        );

        const help = el('div');
        help.append(
            el('b', { textContent: 'Navigate:' }), ' use buttons or ',
            el('kbd', { textContent: '←' }), ' ', el('kbd', { textContent: '→' }), ' arrow keys', el('br'),
            el('b', { textContent: 'Reveal Name:' }), ' press ',
            el('kbd', { textContent: 'space' }), ' or hover over the blurred name', el('br'),
            el('div', { className: 'help-note', textContent: `Note: there are ${allHouseholdCount - workingData.length} households without photos.` }),
            reshuffleBtn
        );

        const controls = el('div', { className: 'controls-container' },
            nameDisplay, prevBtn, nextBtn, progress, el('br'), help, closeBtn
        );

        container.append(imageContainer, controls);

        nameDisplay.addEventListener('mouseover', showDisplayName);
        nameDisplay.addEventListener('mouseout', hideDisplayName);
        prevBtn.addEventListener('click', previousFamily);
        nextBtn.addEventListener('click', nextFamily);
        reshuffleBtn.addEventListener('click', resetList);
        closeBtn.addEventListener('click', closeQuiz);
    }


    function processSelectorAndStart(selector) {

        // scrape household name, image, url, and identifier
        fullData = [...selector].map(function(link) {
            // link looks like
            // https://directory.churchofjesuschrist.org/433608/households/d0b1daaa-5155-4e80-9b53-da19b7fa029e
            const id = link.href.split('/').pop() // last has the id
            return {
                householdHref: link.href,
                householdName: link.children[0].innerText,
                photoUrls: ['/api/v4/photos/households/' + id],
                householdId: id,
                hasImage: null, // populated later
            }
        })

        allHouseholdCount = fullData.length

        document.body.addEventListener('keyup', keyupListener)
        document.body.addEventListener('keydown', keydownListener)


        const container = document.createElement('div')
        container.id = containerId
        container.className = 'container'
        container.innerText = 'Loading...'
        document.body.append(container)

        // Startup
        checkIfImagesExist()
    }

    // Wait for the INIT message from background before doing anything.
    chrome.runtime.onMessage.addListener(function initListener(message) {
        if (message?.type !== 'INIT') return;
        chrome.runtime.onMessage.removeListener(initListener);
        start(message.payload);
    });

    async function start(payload) {
        if (payload?.source === 'redux') {
            console.info(
                'LDS Directory Flashcards: received Redux payload',
                payload.unitNumber,
                'with',
                payload.households.length,
                'households'
            );

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
