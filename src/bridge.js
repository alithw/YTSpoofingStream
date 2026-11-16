// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream v0.3.0 — Bridge (ISOLATED world)               ║
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

  window.postMessage({ type: 'YTSS_BRIDGE_READY' }, '*');

  let cachedEnabled = null;

  // SW → MAIN world: forward immediate HQ triggers, downloads, and Audio-Only toggles
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'YTSS_SW_TRIGGER' && msg.type !== 'YTSS_DOWNLOAD_AUDIO' && msg.type !== 'YTSS_SET_AUDIO_ONLY' && msg.type !== 'YTSS_TRIGGER_UPGRADE') {
      return;
    }
    const forward = (isEnabled) => {
      if (isEnabled === false && msg.type !== 'YTSS_SET_AUDIO_ONLY') return;
      if (msg.type === 'YTSS_TRIGGER_UPGRADE') {
        window.postMessage({ type: 'YTSS_TRIGGER_UPGRADE', videoId: msg.videoId }, '*');
      } else {
        window.postMessage(msg, '*');
      }
    };
    if (cachedEnabled !== null) {
      forward(cachedEnabled);
      return;
    }
    chrome.storage.local.get('enabled', (st) => {
      cachedEnabled = st?.enabled !== false;
      forward(cachedEnabled);
    });
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
  const EXPOSED_SETTINGS_SET = new Set(EXPOSED_SETTINGS);

  function pickSettings(data) {
    const out = {};
    if (!data) return out;
    for (const key of EXPOSED_SETTINGS) {
      if (data[key] !== undefined) out[key] = data[key];
    }
    return out;
  }

  const VALID_LOCALES = new Set(['en', 'vi', 'ja', 'ru', 'zh-cn', 'zh-tw']);
  let lastSettingsJson = null;
  let lastPushedLang = null;

  function pushLocaleData(lang) {
    const l = VALID_LOCALES.has(lang) ? lang : 'en';
    if (l === lastPushedLang) return;
    lastPushedLang = l;
    try {
      safeSend({ type: 'GET_LOCALE', lang: l }, (res) => {
        if (chrome.runtime.lastError || !res?.success || !res?.strings) {
          lastPushedLang = null;
          return;
        }
        window.postMessage({ type: 'YTSS_LOCALE_DATA', lang: res.lang || l, strings: res.strings }, '*');
      });
    } catch (err) {
      lastPushedLang = null;
      void err;
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

  function pushSettings(force = false) {
    chrome.storage.local.get(EXPOSED_SETTINGS, (data) => {
      cachedEnabled = data?.enabled !== false;
      const settings = pickSettings(data);
      const settingsJson = JSON.stringify(settings);
      if (force || settingsJson !== lastSettingsJson) {
        lastSettingsJson = settingsJson;
        try {
          localStorage.setItem('ytss_settings', settingsJson);
        } catch (e) {}
        if (Object.keys(settings).length > 0) {
          window.postMessage({ type: 'YTSS_SETTINGS_UPDATE', settings }, '*');
        }
      }
      pushLocaleData(data?.uiLanguage || detectBrowserLang());
    });
  }

  // Only react to local storage changes affecting exposed settings; ignore session cache churn.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes) return;
    if (changes.enabled !== undefined) {
      cachedEnabled = changes.enabled.newValue !== false;
    }
    for (const key in changes) {
      if (EXPOSED_SETTINGS_SET.has(key)) {
        pushSettings();
        return;
      }
    }
  });

  // On load, push current settings to MAIN world
  pushSettings(true);
}
