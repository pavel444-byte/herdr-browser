const BrowserRemote = (() => {
  const protocol = 1;
  const chunkSize = 16 * 1024;
  const maxFrame = 512 * 1024;
  const maxText = 16 * 1024;

  function peer() {
    return new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  }

  function description(code, type) {
    if (code.length > 100_000) throw new Error("This connection code is too long.");
    try {
      const data = JSON.parse(atob(code.trim()));
      if (data.protocol === protocol && data.type === type && typeof data.sdp === "string") {
        return { type, sdp: data.sdp };
      }
    } catch {}
    throw new Error("Paste the complete " + (type === "offer" ? "invite" : "reply") + " code.");
  }

  async function code(pc, local) {
    await pc.setLocalDescription(local);
    if (pc.iceGatheringState !== "complete") {
      await new Promise(resolve => {
        function done() {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", update);
          resolve();
        }
        function update() {
          if (pc.iceGatheringState === "complete") done();
        }
        const timer = setTimeout(done, 6000);
        pc.addEventListener("icegatheringstatechange", update);
      });
    }
    if (pc.signalingState === "closed") throw new Error("The session was closed.");
    return btoa(JSON.stringify({ protocol, ...pc.localDescription.toJSON() }));
  }

  function send(channel, message) {
    if (channel?.readyState === "open") channel.send(JSON.stringify(message));
  }

  async function copy(field, status) {
    field.select();
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = "Copied.";
    } catch {
      status.textContent = "Text selected. Use your system’s Copy shortcut.";
    }
  }

  return { chunkSize, maxFrame, maxText, peer, description, code, send, copy };
})();
