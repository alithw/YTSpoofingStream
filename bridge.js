// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream v0.0.8 — Bridge (ISOLATED world)               ║
// ║  Relays messages between MAIN world and Service Worker.          ║
// ╚══════════════════════════════════════════════════════════════════╝

if (location.hostname === 'music.youtube.com') {
  // Do not touch YouTube Music
} else {

// MAIN world → Service Worker
// Retries once after 600ms if the SW was killed and is restarting.
function safeSend(msg, callback, retryCount = 0) {
  try {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message || '';
        // SW may be restarting — retry once after a short delay
        if (retryCount === 0 && (err.includes('receiving end') || err.includes('Could not establish'))) {
          setTimeout(() => safeSend(msg, callback, 1), 600);
          return;
        }
        if (callback) callback(null);
        return;
      }
      if (callback) callback(response);
    });
  } catch (e) {
    if (retryCount === 0) {
      setTimeout(() => safeSend(msg, callback, 1), 600);
      return;
    }
    if (callback) callback(null);
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === 'YTSS_FETCH_HQ') {
    const { videoId, title, author, requestId, context, opMode } = event.data;
    safeSend({ type: 'FETCH_HQ', videoId, title, author, context, opMode }, (response) => {
      window.postMessage({
        type: 'YTSS_HQ_RESULT',
        requestId,
        ...(response || { success: false, results: [] }),
      }, '*');
    });
  }

  // ── Phase 1 (Option D): relay TV streaming context query.
  //    MAIN world cannot call chrome.runtime directly; bridge forwards.
  if (event.data.type === 'YTSS_FETCH_TVCTX') {
    const { videoId, requestId } = event.data;
    safeSend({ type: 'GET_TVCTX', videoId }, (response) => {
      window.postMessage({
        type: 'YTSS_TVCTX_RESULT',
        requestId,
        ...(response || { streamingContext: null }),
      }, '*');
    });
  }

  if (event.data.type === 'YTSS_PAGE_CONTEXT') {
    safeSend({ type: 'PAGE_CONTEXT_UPDATE', context: event.data.context || {} });
  }

  if (event.data.type === 'YTSS_SW_PING') {
    chrome.runtime.sendMessage({ type: 'SW_PING' }, (response) => {
      window.postMessage({
        type: 'YTSS_SW_PONG',
        ...(response || { ready: false }),
      }, '*');
    });
  }
});

// SW → MAIN world: immediate HQ upgrade
// Listen for messages from background/popup to forward to the page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'YTSS_SW_TRIGGER' || msg.type === 'YTSS_DOWNLOAD_AUDIO') {
    window.postMessage(msg, '*');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'YTSS_TRIGGER_UPGRADE') {
    window.postMessage({ type: 'YTSS_TRIGGER_UPGRADE', videoId: msg.videoId }, '*');
  }
});

// Settings the MAIN world is allowed to see. `chrome.storage.local` also holds
// `tvOAuthToken` (access_token + refresh_token). Posting the whole storage area
// into the page handed those tokens to youtube.com — and to anything else running
// in the page — so only these keys ever cross the boundary.
const EXPOSED_SETTINGS = [
  'enabled',
  'hqFetch',
  'forceOverride',
  'autoReload',
  'audioMode',
  'preferredClient',
  'rawItag',
  'shadowPlayer',
  'shadowVolume',
  'operationMode',
];

function pickSettings(data) {
  const out = {};
  if (!data) return out;
  for (const key of EXPOSED_SETTINGS) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

function pushSettings() {
  chrome.storage.local.get(EXPOSED_SETTINGS, (data) => {
    const settings = pickSettings(data);
    if (Object.keys(settings).length > 0) {
      window.postMessage({ type: 'YTSS_SETTINGS_UPDATE', settings }, '*');
    }
  });
}

// Push settings changes to MAIN world
chrome.storage.onChanged.addListener(pushSettings);

// On load, push current settings to MAIN world
pushSettings();
}
