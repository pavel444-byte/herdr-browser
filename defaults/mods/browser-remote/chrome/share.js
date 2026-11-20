const $ = id => document.getElementById(id);
const { chunkSize, maxFrame, maxText, peer, description, code, send, copy } = BrowserRemote;
const windowId = Number(new URLSearchParams(location.search).get("window"));
const selectable = url => url === "about:blank" || /^https?:\/\//i.test(url ?? "");
const allowed = tab => tab && tab.windowId === windowId && !tab.incognito && selectable(tab.url)
  && (!tab.pendingUrl || selectable(tab.pendingUrl));
const finite = (value, limit) => Number.isFinite(value) && Math.abs(value) <= limit;
const selection = `(() => {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (el?.tagName === "IFRAME" || el?.type === "password") return "";
  if (typeof el?.selectionStart === "number") {
    return el.value.slice(el.selectionStart, el.selectionEnd).slice(0, ${maxText});
  }
  return (el?.getRootNode()?.getSelection?.() ?? window.getSelection())?.toString().slice(0, ${maxText}) ?? "";
})()`;

let session;
let cleanup = Promise.resolve();

function stop(message) {
  const stopped = session;
  session = undefined;
  if (stopped) {
    clearTimeout(stopped.timer);
    stopped.pc.close();
    cleanup = clearTarget(stopped);
  }
  $("reply").hidden = true;
  $("share").hidden = false;
  $("approve").disabled = false;
  $("offer").value = "";
  $("answer").value = "";
  $("copy-status").textContent = "";
  $("status").textContent = message;
}

function target(tabId) {
  return { tabId };
}

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand(target(tabId), method, params);
}

async function clearTarget(s) {
  const active = s.active;
  s.active = null;
  if (active) await chrome.debugger.detach(target(active.id)).catch(() => {});
}

function report(s, message) {
  $("status").textContent = message;
  send(s.channel, { type: "status", message });
}

async function tabs() {
  return (await chrome.tabs.query({ windowId })).filter(allowed);
}

async function refresh(s) {
  const visible = await tabs();
  if (s !== session) return;
  const current = visible.find(tab => tab.active);
  if (s.active && s.active.id !== current?.id) await clearTarget(s);
  if (s !== session) return;

  if (current && !s.active) {
    const id = current.id;
    try {
      await chrome.debugger.attach(target(id), "1.3");
      if (s !== session) {
        await chrome.debugger.detach(target(id)).catch(() => {});
        return;
      }
      s.active = { id, token: ++s.token };
      publishTabs(s, visible, current);
      await cdp(id, "Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1440, maxHeight: 1000 });
      if (s !== session) return;
      report(s, "Sharing the selected Chrome window.");
    } catch {
      await clearTarget(s);
      if (s === session) report(s, "Chrome could not share this tab. Select another web tab or close its DevTools.");
    }
  } else if (!current) {
    report(s, "Select a web tab in the shared window or open a new tab.");
  } else {
    s.active.paused = false;
  }

  publishTabs(s, visible, current);
}

function publishTabs(s, visible, current) {
  if (s !== session) return;
  s.publishedToken = s.active?.token;
  send(s.channel, {
    type: "tabs",
    active: current?.id ?? null,
    token: s.active?.token ?? null,
    tabs: visible.map(({ id, title, url }) => ({ id, title: title?.slice(0, 256), url: url.slice(0, 8192) })),
  });
}

function enqueue(s, action) {
  if (s !== session || s.pending >= 128) return false;
  s.pending++;
  s.queue = s.queue.then(async () => {
    if (s === session) await action();
  }).catch(() => {
    if (s === session) report(s, "Chrome could not complete that action.");
  }).finally(() => { s.pending--; });
  return true;
}

function sync() {
  const s = session;
  if (!s || s.channel?.readyState !== "open" || s.syncing) return;
  s.syncing = enqueue(s, async () => {
    s.syncing = false;
    await refresh(s);
  });
}

async function onMessage(s, m) {
  if (!m || typeof m !== "object") return;
  const id = s.active?.id;
  switch (m.type) {
    case "new":
      await chrome.tabs.create({ windowId, url: "about:blank" });
      await refresh(s);
      return;
    case "select":
    case "close":
      if (!Number.isInteger(m.id)) return;
      if (!allowed(await chrome.tabs.get(m.id)) || s !== session) return;
      if (m.type === "select") await chrome.tabs.update(m.id, { active: true });
      else await chrome.tabs.remove(m.id);
      await refresh(s);
      return;
  }

  // A gesture from an old frame must never land on the newly selected tab.
  if (!id || m.token !== s.active.token) return;
  const tab = await chrome.tabs.get(id);
  if (s !== session || !allowed(tab) || !tab.active) return;
  switch (m.type) {
    case "navigate":
      if (typeof m.url === "string" && m.url.length <= 8192 && selectable(m.url)) {
        await chrome.tabs.update(id, { url: m.url });
      }
      break;
    case "back":
      await chrome.tabs.goBack(id);
      break;
    case "forward":
      await chrome.tabs.goForward(id);
      break;
    case "reload":
      await chrome.tabs.reload(id);
      break;
    case "mouse": {
      const { width, height } = s.active;
      if (!width || !height || ![m.x, m.y].every(n => Number.isFinite(n) && n >= 0 && n < 1)) return;
      const { event, button, buttons, modifiers, count, dx, dy } = m;
      if (!["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(event)) return;
      if (!["none", "left", "right", "middle"].includes(button)) return;
      if (![buttons, modifiers, count].every(Number.isInteger) || buttons < 0 || buttons > 7
          || modifiers < 0 || modifiers > 15 || count < 0 || count > 3) return;
      const params = { type: event, x: m.x * width, y: m.y * height, button, buttons, modifiers, clickCount: count };
      if (event === "mouseWheel") {
        if (!finite(dx, 10000) || !finite(dy, 10000)) return;
        Object.assign(params, { deltaX: dx, deltaY: dy });
      }
      await cdp(id, "Input.dispatchMouseEvent", params);
      break;
    }
    case "key": {
      const { event, key, keyCode, modifiers, repeat, text, location } = m;
      if (!["rawKeyDown", "keyDown", "keyUp"].includes(event) || typeof key !== "string"
          || key.length > 40 || typeof m.code !== "string" || m.code.length > 40
          || typeof text !== "string" || text.length > 8 || !Number.isInteger(keyCode) || keyCode < 0 || keyCode > 255
          || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15
          || !Number.isInteger(location) || location < 0 || location > 3) return;
      const params = {
        type: event, key, code: m.code, windowsVirtualKeyCode: keyCode, modifiers, autoRepeat: repeat === true,
        isKeypad: location === 3, location: location === 3 ? 0 : location,
      };
      if (event === "keyDown") params.text = text;
      if (event !== "keyUp" && (modifiers & 6) && key.toLowerCase() === "a") params.commands = ["SelectAll"];
      if (event !== "keyUp" && (modifiers & 6) && key.toLowerCase() === "z") {
        params.commands = [modifiers & 8 ? "Redo" : "Undo"];
      }
      await cdp(id, "Input.dispatchKeyEvent", params);
      break;
    }
    case "text":
      if (typeof m.text === "string" && m.text.length <= maxText) {
        await cdp(id, "Input.insertText", { text: m.text });
      }
      break;
    case "copy": {
      const result = await cdp(id, "Runtime.evaluate", { expression: selection, returnByValue: true });
      send(s.channel, { type: "clipboard", token: m.token, text: result.result?.value ?? "" });
      break;
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, frame) => {
  const s = session;
  if (method !== "Page.screencastFrame" || !s?.active || s.active.id !== source.tabId) return;
  cdp(source.tabId, "Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  const { deviceWidth, deviceHeight, pageScaleFactor } = frame.metadata;
  const channel = s.channel;
  if (s.active.paused || s.publishedToken !== s.active.token || channel?.readyState !== "open"
      || channel.bufferedAmount > chunkSize * 4 || frame.data.length > maxFrame
      || !(deviceWidth > 0 && deviceHeight > 0 && pageScaleFactor > 0)) return;
  s.active.width = deviceWidth / pageScaleFactor;
  s.active.height = deviceHeight / pageScaleFactor;
  send(channel, { type: "frame", token: s.active.token, size: frame.data.length });
  for (let start = 0; start < frame.data.length; start += chunkSize) {
    channel.send(frame.data.slice(start, start + chunkSize));
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (session?.active?.id === source.tabId) {
    if (reason === "canceled_by_user") stop("Sharing stopped in Chrome.");
    else { session.active = null; sync(); }
  }
});

chrome.tabs.onActivated.addListener(info => { if (info.windowId === windowId) sync(); });
chrome.tabs.onCreated.addListener(tab => { if (tab.windowId === windowId) sync(); });
chrome.tabs.onRemoved.addListener((_id, info) => { if (info.windowId === windowId) sync(); });
chrome.tabs.onAttached.addListener((_id, info) => { if (info.newWindowId === windowId) sync(); });
chrome.tabs.onDetached.addListener((id, info) => {
  if (info.oldWindowId !== windowId) return;
  if (session?.active?.id === id) session.active.paused = true;
  sync();
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (tab.windowId !== windowId) return;
  if (session?.active?.id === id && !allowed(tab)) session.active.paused = true;
  if ("url" in change || "title" in change || change.status) sync();
});
chrome.windows.onRemoved.addListener(id => { if (id === windowId) stop("The shared Chrome window was closed."); });
window.addEventListener("pagehide", () => stop("Sharing stopped."));

$("share").addEventListener("submit", async event => {
  event.preventDefault();
  if (session) return;
  $("approve").disabled = true;
  $("status").textContent = "Creating a reply…";
  const s = { pc: peer(), token: 0, pending: 0, queue: Promise.resolve() };
  session = s;
  try {
    await cleanup;
    if (s !== session) return;
    const sharedWindow = await chrome.windows.get(windowId);
    if (sharedWindow.incognito || sharedWindow.type !== "normal") throw new Error("Open the extension from a regular Chrome window.");
    s.pc.addEventListener("datachannel", ({ channel }) => {
      if (session !== s || s.channel || channel.label !== "herdr-browser") {
        channel.close();
        return;
      }
      s.channel = channel;
      channel.addEventListener("open", () => {
        clearTimeout(s.timer);
        sync();
      });
      channel.addEventListener("close", () => { if (session === s) stop("The viewer disconnected."); });
      channel.addEventListener("message", ({ data }) => {
        if (typeof data !== "string" || data.length > maxText * 6 + 128) return;
        try {
          const message = JSON.parse(data);
          enqueue(s, () => onMessage(s, message));
        } catch {}
      });
    });
    s.pc.addEventListener("connectionstatechange", () => {
      if (session === s && s.pc.connectionState === "failed") stop("The connection failed. Create a new invite to try again.");
    });
    await s.pc.setRemoteDescription(description($("offer").value, "offer"));
    const answer = await code(s.pc, await s.pc.createAnswer());
    if (session !== s) return;
    $("answer").value = answer;
    $("share").hidden = true;
    $("reply").hidden = false;
    $("status").textContent = "Send the reply to the viewer and wait for it to connect.";
    if (s.channel?.readyState !== "open") {
      s.timer = setTimeout(() => stop("The invite expired. Ask the viewer for a new invite."), 5 * 60 * 1000);
    }
  } catch (error) {
    if (session === s) stop(error.message);
  }
});
$("copy").addEventListener("click", () => copy($("answer"), $("copy-status")));
$("stop").addEventListener("click", () => stop("Sharing stopped."));
