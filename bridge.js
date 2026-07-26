// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream v0.0.8 — Bridge (ISOLATED world)             ║
// ║  Relays messages between MAIN world and Service Worker.         ║
// ╚══════════════════════════════════════════════════════════════════╝

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
    const { videoId, requestId } = event.data;
    safeSend({ type: 'FETCH_HQ', videoId }, (response) => {
      window.postMessage({
        type: 'YTSS_HQ_RESULT',
        requestId,
        ...(response || { success: false, results: [] }),
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

  // inject.js → SW: load previously cached HQ formats from chrome.storage.session
  // This allows sync-merge at page start without waiting for a new SW fetch
  if (event.data.type === 'YTSS_GET_SESSION_CACHE') {
    const { videoId, requestId } = event.data;
    safeSend({ type: 'GET_SESSION_CACHE', videoId }, (response) => {
      window.postMessage({
        type: 'YTSS_SESSION_CACHE_RESULT',
        requestId,
        videoId,
        formats: response?.formats || [],
      }, '*');
    });
  }
});

// SW → MAIN world: immediate HQ upgrade trigger via chrome.tabs.onActivated
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'YTSS_TRIGGER_UPGRADE') {
    window.postMessage({ type: 'YTSS_TRIGGER_UPGRADE', videoId: msg.videoId }, '*');
  }
});

// Push settings changes to MAIN world
chrome.storage.onChanged.addListener(() => {
  chrome.storage.local.get(null, (data) => {
    window.postMessage({ type: 'YTSS_SETTINGS_UPDATE', settings: data }, '*');
  });
});

// On load, push current settings to MAIN world
chrome.storage.local.get(null, (data) => {
  if (data && Object.keys(data).length > 0) {
    window.postMessage({ type: 'YTSS_SETTINGS_UPDATE', settings: data }, '*');
  }
});
