// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream v0.2.6 — Bridge (ISOLATED world)               ║
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

const isValidVideoId = (v) => typeof v === 'string' && /^[\w-]{11}$/.test(v);

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === 'YTSS_FETCH_HQ') {
    const { videoId, title, author, requestId, context, opMode, preferredSource, excludeSource, forceFresh } = event.data;
    if (!isValidVideoId(videoId)) {
      window.postMessage({ type: 'YTSS_HQ_RESULT', requestId, success: false, results: [], error: 'invalid videoId' }, '*');
      return;
    }
    safeSend({ type: 'FETCH_HQ', videoId, title, author, context, opMode, preferredSource, excludeSource, forceFresh }, (response) => {
      window.postMessage({
        type: 'YTSS_HQ_RESULT',
        requestId,
        ...(response || { success: false, results: [] }),
      }, '*');
    });
  }

  if (event.data.type === 'YTSS_CLEAR_VIDEO_CACHE') {
    const { videoId } = event.data;
    if (videoId === undefined || videoId === null || isValidVideoId(videoId)) {
      safeSend({ type: 'CLEAR_VIDEO_CACHE', videoId: isValidVideoId(videoId) ? videoId : null });
    }
  }

  if (event.data.type === 'YTSS_CONFIRM_NO_774') {
    if (isValidVideoId(event.data.videoId)) {
      safeSend({ type: 'CONFIRM_NO_774', videoId: event.data.videoId });
    }
  }

  if (event.data.type === 'YTSS_STOP_HARVEST') {
    safeSend({ type: 'OFFSCREEN_STOP_HARVEST' });
  }

  // YTSS_RELOAD_EXTENSION is intentionally NOT relayed: any script on the page
  // can post window messages, and relaying it let pages reload the extension in a loop.

  // Relay TV streaming context query: MAIN world cannot call chrome.runtime directly; bridge forwards.
  if (event.data.type === 'YTSS_FETCH_TVCTX') {
    const { videoId, requestId } = event.data;
    if (!isValidVideoId(videoId)) {
      window.postMessage({ type: 'YTSS_TVCTX_RESULT', requestId, streamingContext: null }, '*');
      return;
    }
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

  if (event.data.type === 'YTSS_AUDIO_ONLY_CHANGED') {
    chrome.storage.local.set({ audioOnly: !!event.data.audioOnly });
  }

  if (event.data.type === 'YTSS_RELOAD_RULES') {
    safeSend({ type: 'RELOAD_RULES' }, (res) => {
      window.postMessage({ type: 'YTSS_RELOAD_RULES_RESULT', success: !!res?.success }, '*');
    });
  }
});

// SW → MAIN world: immediate HQ upgrade
// Listen for messages from background/popup to forward to the page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'YTSS_SW_TRIGGER' || msg.type === 'YTSS_DOWNLOAD_AUDIO' || msg.type === 'YTSS_SET_AUDIO_ONLY') {
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
  'audioOnly',
  'uiLanguage',
];

function pickSettings(data) {
  const out = {};
  if (!data) return out;
  for (const key of EXPOSED_SETTINGS) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

const VALID_LOCALES = new Set(['en', 'vi', 'ja', 'ru', 'zh-cn', 'zh-tw']);

async function pushLocaleData(lang) {
  try {
    const l = VALID_LOCALES.has(lang) ? lang : 'en';
    let url = chrome.runtime.getURL(`locales/${l}.json`);
    let res = await fetch(url);
    if (!res.ok && l !== 'en') {
      url = chrome.runtime.getURL('locales/en.json');
      res = await fetch(url);
    }
    if (res.ok) {
      const strings = await res.json();
      window.postMessage({ type: 'YTSS_LOCALE_DATA', lang: l, strings }, '*');
    }
  } catch (e) {
    console.log('[YTSS-Bridge] Failed to load locale data:', e);
  }
}

function detectBrowserLang() {
  const sysLang = (navigator.language || '').toLowerCase();
  if (sysLang.startsWith('vi')) return 'vi';
  if (sysLang.startsWith('ja')) return 'ja';
  if (sysLang.startsWith('ru')) return 'ru';
  if (sysLang === 'zh-tw' || sysLang === 'zh-hk' || sysLang === 'zh-mo' || sysLang.includes('hant')) return 'zh-tw';
  if (sysLang.startsWith('zh')) return 'zh-cn';
  return 'en';
}

function pushSettings() {
  chrome.storage.local.get(EXPOSED_SETTINGS, (data) => {
    const settings = pickSettings(data);
    if (Object.keys(settings).length > 0) {
      window.postMessage({ type: 'YTSS_SETTINGS_UPDATE', settings }, '*');
    }
    pushLocaleData(data?.uiLanguage || detectBrowserLang());
  });
}

// Push settings changes to MAIN world
chrome.storage.onChanged.addListener(pushSettings);

// On load, push current settings to MAIN world
pushSettings();
}
