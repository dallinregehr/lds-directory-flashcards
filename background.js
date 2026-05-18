const api = typeof browser !== 'undefined' ? browser : chrome;

api.action.onClicked.addListener((tab) => {
    api.scripting.executeScript({
        target: {tabId: tab.id},
        files: ['content.js']
    });
});
