const $ = id => document.getElementById(id);
const { chunkSize, maxFrame, maxText, peer, description, code, send, copy } = BrowserRemote;
let session;
let tabState = { active: null, token: null };
let pendingFrame;
let frameUrl;
let clipboardToken;
let dragging;

function clearFrame() {
  pendingFrame = undefined;
  $("frame").hidden = true;
  $("frame").removeAttribute("src");
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = undefined;
  dragging = undefined;
}

function stop(message) {
  const stopped = session;
  session = undefined;
  if (stopped) {
    clearTimeout(stopped.timer);
    stopped.pc.close();
  }
  clearFrame();
  tabState = { active: null, token: null };
  $("clipboard").close();
  $("pair").hidden = false;
  $("browser").hidden = true;
  $("codes").hidden = true;
  $("invite").disabled = false;
  $("connect-button").disabled = false;
  $("offer").value = "";
  $("answer").value = "";
  $("copy-status").textContent = "";
  $("browser-status").textContent = "";
  $("status").textContent = message;
}

function command(message, withTab = false) {
  if (withTab && !tabState.token) return;
  send(session?.channel, withTab ? { ...message, token: tabState.token } : message);
}

function button(label, title, handler) {
  const node = document.createElement("button");
  node.textContent = label;
  node.title = title;
  node.addEventListener("click", handler);
  return node;
}

function updateTabs(message) {
  const { active, tabs, token } = message;
  const changed = active !== tabState.active || token !== tabState.token;
  if (changed) {
    clearFrame();
    clipboardToken = undefined;
    $("clipboard").close();
  }
  tabState = message;
  if (document.activeElement !== $("address") || changed) {
    $("address").value = tabs.find(tab => tab.id === active)?.url ?? "";
  }
  for (const id of ["back", "forward", "reload", "copy-selection", "paste-text", "address"]) {
    $(id).disabled = token === null;
  }
  if (token && changed) $("screen").focus();
  const list = $("tabs");
  const previous = list.querySelector(":focus")?.dataset.action;
  const scroll = list.scrollLeft;
  list.replaceChildren(...tabs.map(tab => {
    const group = document.createElement("div");
    group.className = "tab";
    const select = button(tab.title || (tab.url === "about:blank" ? "New tab" : tab.url), tab.url,
      () => command({ type: "select", id: tab.id }));
    select.dataset.action = "select-" + tab.id;
    select.setAttribute("role", "tab");
    select.setAttribute("aria-selected", String(tab.id === active));
    const closeLabel = "Close " + (tab.title || "tab");
    const close = button("×", closeLabel, () => command({ type: "close", id: tab.id }));
    close.setAttribute("aria-label", closeLabel);
    close.dataset.action = "close-" + tab.id;
    group.append(select, close);
    return group;
  }));
  list.scrollLeft = scroll;
  if (!changed && previous) list.querySelector(`[data-action="${previous}"]`)?.focus();
}

function renderChunk(chunk) {
  const frame = pendingFrame;
  if (chunk.length === 0 || chunk.length > chunkSize || chunk.length > frame.remaining) {
    pendingFrame = undefined;
    return;
  }
  frame.parts.push(chunk);
  frame.remaining -= chunk.length;
  if (frame.remaining !== 0) return;
  pendingFrame = undefined;
  if (frame.token !== tabState.token || !session) return;
  try {
    const bytes = Uint8Array.from(atob(frame.parts.join("")), char => char.charCodeAt(0));
    const nextUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    const img = $("frame");
    img.src = nextUrl;
    img.hidden = false;
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = nextUrl;
  } catch {
    $("browser-status").textContent = "Waiting for a valid page image…";
  }
}

function receive(data) {
  if (typeof data !== "string") return;
  if (pendingFrame) {
    renderChunk(data);
    return;
  }
  try {
    const message = JSON.parse(data);
    switch (message.type) {
      case "tabs":
        if (Array.isArray(message.tabs)) updateTabs(message);
        break;
      case "status":
        $("browser-status").textContent = message.message;
        break;
      case "frame":
        if (Number.isInteger(message.size) && message.size > 0 && message.size <= maxFrame) {
          pendingFrame = { token: message.token, remaining: message.size, parts: [] };
        }
        break;
      case "clipboard":
        if (message.token === clipboardToken && message.token === tabState.token && typeof message.text === "string") {
          clipboardToken = undefined;
          if (message.text) showClipboard("copy", message.text.slice(0, maxText));
          else $("browser-status").textContent = "Select some text on the remote page first.";
        }
        break;
    }
  } catch {}
}

$("invite").addEventListener("click", async () => {
  $("invite").disabled = true;
  $("status").textContent = "Creating an invite…";
  try {
    const pc = peer();
    const channel = pc.createDataChannel("herdr-browser");
    const s = { pc, channel };
    session = s;
    channel.addEventListener("open", () => {
      if (session !== s) return;
      clearTimeout(s.timer);
      $("pair").hidden = true;
      $("browser").hidden = false;
      updateTabs({ active: null, tabs: [], token: null });
      $("browser-status").textContent = "Waiting for Chrome…";
    });
    channel.addEventListener("message", ({ data }) => { if (session === s) receive(data); });
    channel.addEventListener("close", () => { if (session === s) stop("The shared session ended."); });
    pc.addEventListener("connectionstatechange", () => {
      if (session === s && pc.connectionState === "failed") stop("The direct connection failed. Check that both devices can reach each other and try again.");
    });
    const offer = await code(pc, await pc.createOffer());
    if (session !== s) return;
    $("offer").value = offer;
    $("codes").hidden = false;
    $("status").textContent = "Send the invite to the person sharing Chrome.";
    s.timer = setTimeout(() => stop("The invite expired. Create a new one to connect."), 5 * 60 * 1000);
  } catch (error) {
    stop(error.message);
  }
});

$("connect").addEventListener("submit", async event => {
  event.preventDefault();
  const s = session;
  if (!s) return;
  $("connect-button").disabled = true;
  try {
    await s.pc.setRemoteDescription(description($("answer").value, "answer"));
    if (session !== s) return;
    clearTimeout(s.timer);
    if (s.channel.readyState !== "open") {
      s.timer = setTimeout(() => stop("The direct connection timed out. Check that both devices can reach each other and try again."), 25_000);
    }
    $("status").textContent = "Connecting to Chrome…";
  } catch (error) {
    if (session !== s) return;
    $("status").textContent = error.message;
    $("connect-button").disabled = false;
  }
});

$("copy").addEventListener("click", () => copy($("offer"), $("copy-status")));
$("cancel").addEventListener("click", () => stop("Invite canceled."));
$("disconnect").addEventListener("click", () => stop("Disconnected."));
window.addEventListener("pagehide", () => stop("Disconnected."));
$("new-tab").addEventListener("click", () => command({ type: "new" }));
for (const type of ["back", "forward", "reload"]) {
  $(type).addEventListener("click", () => command({ type }, true));
}
$("navigation").addEventListener("submit", event => {
  event.preventDefault();
  let url = $("address").value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && url !== "about:blank") {
    const isHost = /^(?:localhost|[^\s/:]+\.[^\s/:]+)(?::\d+)?(?:[/?#].*)?$/i.test(url);
    url = isHost ? "https://" + url : "https://www.google.com/search?q=" + encodeURIComponent(url);
  }
  command({ type: "navigate", url }, true);
  $("screen").focus();
});

function showClipboard(mode, text = "") {
  const field = $("clipboard-text");
  const paste = mode === "paste";
  $("clipboard-label").textContent = paste ? "Text to paste into the remote page" : "Text selected on the remote page";
  $("clipboard-action").textContent = paste ? "Send text" : "Copy text";
  $("clipboard-status").textContent = "";
  field.value = text;
  field.readOnly = !paste;
  $("clipboard").dataset.mode = mode;
  if (!$("clipboard").open) $("clipboard").showModal();
  field.focus();
  if (!paste) field.select();
}

function requestCopy() {
  clipboardToken = tabState.token;
  command({ type: "copy" }, true);
}

$("copy-selection").addEventListener("click", requestCopy);
$("paste-text").addEventListener("click", () => showClipboard("paste"));
function closeClipboard() {
  $("clipboard").close();
  if (session) $("screen").focus();
}

$("clipboard-close").addEventListener("click", closeClipboard);
$("clipboard").addEventListener("close", () => {
  $("clipboard-text").value = "";
  if (session) $("screen").focus();
});
$("clipboard-action").addEventListener("click", () => {
  const field = $("clipboard-text");
  if ($("clipboard").dataset.mode === "paste") {
    command({ type: "text", text: field.value.slice(0, maxText) }, true);
    closeClipboard();
  } else {
    copy(field, $("clipboard-status"));
  }
});
$("screen").addEventListener("paste", event => {
  event.preventDefault();
  command({ type: "text", text: event.clipboardData.getData("text/plain").slice(0, maxText) }, true);
});

const modifiers = e => Number(e.altKey) + Number(e.ctrlKey) * 2 + Number(e.metaKey) * 4 + Number(e.shiftKey) * 8;
const mouseButtons = ["left", "middle", "right"];

function mouse(event, e) {
  if ($("frame").hidden || !$("frame").naturalWidth) return;
  const { left, top, width, height } = $("frame").getBoundingClientRect();
  if (!width || !height) return;
  let x = (e.clientX - left) / width;
  let y = (e.clientY - top) / height;
  if (dragging === undefined && (x < 0 || y < 0 || x >= 1 || y >= 1)) return;
  x = Math.min(0.99999, Math.max(0, x));
  y = Math.min(0.99999, Math.max(0, y));
  const button = event === "mousePressed" || event === "mouseReleased"
    ? mouseButtons[e.button] ?? "none" : "none";
  if (event === "mousePressed") {
    if (button === "none") return;
    dragging = true;
    $("screen").focus();
  }
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
  command({ type: "mouse", event, x, y, modifiers: modifiers(e), button, buttons: e.buttons & 7,
    count: event === "mousePressed" || event === "mouseReleased" ? Math.min(3, e.detail || 1) : 0,
    dx: e.deltaX * unit, dy: e.deltaY * unit }, true);
  if (event === "mouseReleased") dragging = undefined;
}

const screen = $("screen");
screen.addEventListener("contextmenu", e => e.preventDefault());
screen.addEventListener("mousedown", e => mouse("mousePressed", e));
screen.addEventListener("mouseup", e => mouse("mouseReleased", e));
// Use pointer capture so releasing a drag outside the image still reaches Chrome.
screen.addEventListener("pointerdown", e => {
  if (e.pointerType === "mouse") screen.setPointerCapture(e.pointerId);
});
screen.addEventListener("pointercancel", e => {
  if (dragging !== undefined) mouse("mouseReleased", e);
});
let nextMove = 0;
screen.addEventListener("mousemove", e => {
  if (performance.now() < nextMove) return;
  nextMove = performance.now() + 24;
  mouse("mouseMoved", e);
});
screen.addEventListener("wheel", e => {
  e.preventDefault();
  mouse("mouseWheel", e);
}, { passive: false });

for (const type of ["keydown", "keyup"]) {
  screen.addEventListener(type, e => {
    if (e.isComposing) return;
    const down = type === "keydown";
    const commandKey = e.ctrlKey || e.metaKey;
    if (commandKey && e.key.toLowerCase() === "v") return; // Let Chrome deliver the viewer's paste event.
    e.preventDefault();
    if (commandKey && e.key.toLowerCase() === "c") {
      if (down && !e.repeat) requestCopy();
      return;
    }
    const printable = Array.from(e.key).length === 1 && (!commandKey && !e.altKey || e.getModifierState("AltGraph"));
    const text = printable ? e.key : e.key === "Enter" ? "\r" : "";
    command({
      type: "key", event: down ? (text ? "keyDown" : "rawKeyDown") : "keyUp", key: e.key, code: e.code,
      keyCode: e.keyCode, repeat: e.repeat, modifiers: modifiers(e), location: e.location, text: down ? text : "",
    }, true);
  });
}
