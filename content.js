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

    let fullData = [];
    let workingData = [];
    let currentListIndex = -1;
    let allHouseholdCount = 0;
    const containerId = 'quiz-container'
    const flashcardNameDisplayId = 'flashcard-display-name'

    // Wait for full list of households to load
    const interval = setInterval(() => {
        // this is the path to the anchor containing the household name and unique id
        // luckily no part of the list is shown until the entire list has loaded
        const selector = getQuerySelector()
        if (selector.length) {
            clearInterval(interval)
            initialize()
        }
    }, 500)

    function initialize() {
        processSelectorAndStart(getQuerySelector())
    }

    function getQuerySelector() {
        return document.querySelectorAll('#app-page section div[data-scroll=true] div a[role=link]')
    }

    function checkIfImagesExist() {
        
        // keep track of how many images checked so user can see progress
        let loadingImgCount = 0;

        function checkIfImageExists(url, callback) {
            const img = new Image();
            img.src = url;
            if (img.complete) {
                loadingImgCount = loadingImgCount + 1;
                callback(true);
            } else {
                img.onload = () => {
                    callback(true);
                    loadingImgCount = loadingImgCount + 1;
                };
            
                img.onerror = () => {
                    callback(false);
                    loadingImgCount = loadingImgCount + 1;
                };
            }
        }

        const container = document.getElementById(containerId)
        const allHouseholdCountDisplay = allHouseholdCount - 1 // zero indexed

        fullData.forEach(familyData => {
            checkIfImageExists(familyData.householdImgUrl, function(didLoad) {
                familyData.hasImage = didLoad
                container.innerText = `Loading ${loadingImgCount}/${allHouseholdCountDisplay} flashcards...`
                
                // display once all images have been checked
                if (loadingImgCount === allHouseholdCountDisplay) {
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
        workingData = fullData.filter(f => f.hasImage).slice(0)
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
        document.getElementById(flashcardNameDisplayId).style.filter = ''
    }

    function hideDisplayName() {
        document.getElementById(flashcardNameDisplayId).style.filter = 'blur(10px)'
    }


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

    function closeQuiz() {
        // cleanup
        document.body.removeEventListener('keyup', keyupListener)
        document.body.removeEventListener('keydown', keydownListener)
        document.body.removeEventListener('click', closeQuiz)
        document.getElementById(containerId).remove()
    }

    function loadFamily(familyData) {
        let container = document.getElementById(containerId)
        container.setHTMLUnsafe(`
            <div class="image-container">
                <div>
                    <img src="${familyData.householdImgUrl}">
                </div>
            </div>
            <div class="controls-container">
                <div id="${flashcardNameDisplayId}" class="display-name" style="filter: blur(10px)">${familyData.householdName}</div>
                <button id="quiz-prev-btn" class="prev-next-btn">❮</button>
                <button id="quiz-next-btn" class="prev-next-btn">❯</button>
                
                <div>
                    <div>${currentListIndex + 1} / ${workingData.length}</div>
                </div>
                <br>
                <div>
                    <b>Navigate:</b> use buttons or right/left arrow keys<br/>
                    <b>Reveal Name:</b> press space or hover over the blurred name<br/>
                    <i>Note: there are ${allHouseholdCount - workingData.length} households without photos.</i><br/>
                    <button id="quiz-reshuffle-btn" style="cursor: pointer;">↩ Reshuffle</button>
                </div>

                <div id="quiz-close-btn" class="close-btn" title="close flashcards">
                    X
                </div>
            </div>
        `)

        document.getElementById(flashcardNameDisplayId).addEventListener('mouseover', showDisplayName);
        document.getElementById(flashcardNameDisplayId).addEventListener('mouseout', hideDisplayName);
        document.getElementById('quiz-prev-btn').addEventListener('click', previousFamily);
        document.getElementById('quiz-next-btn').addEventListener('click', nextFamily);
        document.getElementById('quiz-reshuffle-btn').addEventListener('click', resetList);
        document.getElementById('quiz-close-btn').addEventListener('click', closeQuiz);
        
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
                householdImgUrl: '/api/v4/photos/households/' + id,
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
}
runExtension()