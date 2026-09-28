// Connection feedback is separate from a shard's account rejection/character UI.
let sceneTransportAvailable = true;
let loginConnectionId = null, loginCancelPending = false;
const connectionInertElements = new Map();
let connectionPreviousFocus = null;
function setSceneTransport(available) {
  const changed = sceneTransportAvailable !== available;
  sceneTransportAvailable = available;
  const overlay = document.getElementById("client-connection");
  if (overlay) overlay.hidden = available;
  if (!changed) return;
  if (!available) {
    connectionPreviousFocus = document.activeElement;
    for (const element of document.body.children) {
      if (element === overlay || element.tagName === "SCRIPT") continue;
      connectionInertElements.set(element, element.inert);
      element.inert = true;
    }
    document.getElementById("client-connection-retry")?.focus({ preventScroll: true });
  } else {
    for (const [element, previous] of connectionInertElements) element.inert = previous;
    connectionInertElements.clear();
    if (connectionPreviousFocus && document.body.contains(connectionPreviousFocus) && !connectionPreviousFocus.disabled) {
      connectionPreviousFocus.focus({ preventScroll: true });
    }
    connectionPreviousFocus = null;
  }
  // Clear latches on BOTH transitions: a key pressed while disconnected must
  // not start moving when a later scene finally arrives.
  if (typeof releaseMoveKeys === "function") releaseMoveKeys();
  if (!available) {
    if (typeof stopMacro === "function") stopMacro();
    if (typeof stopFollowing === "function") stopFollowing();
    if (typeof stopSoundEffects === "function") stopSoundEffects();
  }
}
function updateLoginConnection(auth, details) {
  const cancel = document.getElementById("lg-cancel-connection");
  if (!cancel) return;
  const next = auth === "connecting" ? details?.attempt_id ?? null : null;
  if (next !== loginConnectionId) loginCancelPending = false;
  loginConnectionId = next;
  cancel.hidden = auth !== "connecting" || next === null;
  cancel.disabled = loginCancelPending || !details?.cancellable;
  cancel.textContent = loginCancelPending ? "Cancelling…" : "Cancel connection";
}
async function cancelLoginConnection() {
  const id = loginConnectionId;
  if (id === null || loginCancelPending) return;
  loginCancelPending = true;
  const button = document.getElementById("lg-cancel-connection");
  button.disabled = true; button.textContent = "Cancelling…";
  try {
    const response = await fetch("login/cancel", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Anima-Launcher": "1" },
      body: JSON.stringify({ attempt_id: id }),
    });
    // A completed/older attempt cannot cancel the next one. Its next scene is
    // authoritative; don't replace that with an error from the old request.
    if (!response.ok && response.status !== 409) throw new Error("Cancellation could not reach the client. Retry when the connection returns.");
  } catch (error) {
    if (id === loginConnectionId) {
      document.getElementById("lg-msg").textContent = error.message;
      loginCancelPending = false; button.disabled = false; button.textContent = "Cancel connection";
    }
  }
}
let connectionControlsWired = false;
function wireConnectionControls() {
  if (connectionControlsWired) return;
  connectionControlsWired = true;
  document.getElementById("lg-cancel-connection")?.addEventListener("click", cancelLoginConnection);
  document.getElementById("client-connection-retry")?.addEventListener("click", () => poll(true));
}
