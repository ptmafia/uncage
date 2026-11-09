// Clicking the toolbar icon opens the side panel.
// eslint-disable-next-line no-undef
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
