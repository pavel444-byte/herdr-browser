chrome.action.onClicked.addListener(tab => {
  if (!tab.incognito && Number.isInteger(tab.windowId)) {
    chrome.windows.create({
      url: chrome.runtime.getURL("share.html") + "?window=" + tab.windowId,
      type: "popup",
      width: 550,
      height: 650,
    }).catch(console.error);
  }
});
