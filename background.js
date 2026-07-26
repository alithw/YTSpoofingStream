// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream v0.0.8 — Service Worker Resolver              ║
// ║  Restored v0.0.5 Core + Preferred Client Selector               ║
// ╚══════════════════════════════════════════════════════════════════╝

const TAG = '[YTSS-SW]';

// ─── FULL CLIENT CONFIGURATIONS ──────────────────────────────────────
// Restored from working v0.0.5: WEB_REMIX first (best HQ success rate)
const CLIENTS = [
  {
    name: 'WEB_REMIX',
    clientName: 'WEB_REMIX',
    clientVersion: '1.20250720.01.00',
    clientId: '67',
    apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    ua: null,
    extraContext: {},
  },
  {
    name: 'TVHTML5',
    clientName: 'TVHTML5',
    clientVersion: '7.20240101.01.01',
    clientId: '7',
    apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1',
    // tvAppInfo removed — livingRoomAppMode enum is invalid in InnerTube proto
    extraContext: {},
  },
  {
    // ANDROID (clientId 3) — works reliably with SAPISIDHASH
    name: 'ANDROID',
    clientName: 'ANDROID',
    clientVersion: '21.04.223',
    clientId: '3',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    ua: 'com.google.android.youtube/21.04.223 (Linux; U; Android 14; en_US) gzip',
    extraContext: {
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
    },
  },
  {
    // IOS — uses dedicated iOS API key
    name: 'IOS',
    clientName: 'IOS',
    clientVersion: '19.45.4',
    clientId: '5',
    apiKey: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
    extraContext: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iOS',
      osVersion: '17.5.1',
    },
  },
  {
    // ANDROID_MUSIC — YouTube Music Android client
    name: 'ANDROID_MUSIC',
    clientName: 'ANDROID_MUSIC',
    clientVersion: '7.27.52',
    clientId: '21',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    ua: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip',
    extraContext: {
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
    },
  },
  {
    // ANDROID_VR — Oculus/Meta Quest client
    name: 'ANDROID_VR',
    clientName: 'ANDROID_VR',
    clientVersion: '1.58.1',
    clientId: '28',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    ua: 'Mozilla/5.0 (Linux; Android 10; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/15.0.0.0 Safari/537.36',
    extraContext: {
      androidSdkVersion: 29,
      osName: 'Android',
      osVersion: '10',
    },
  },
];

const UA_RULE_ID = 9001;

// ─── AUTHENTICATION ──────────────────────────────────────────────────
async function getSapisidHash() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.youtube.com', name: 'SAPISID' }) ||
      await chrome.cookies.get({ url: 'https://www.youtube.com', name: '__Secure-3PAPISID' });
    if (!cookie) return null;

    const origin = 'https://www.youtube.com';
    const ts = Math.floor(Date.now() / 1000);
    const input = `${ts} ${cookie.value} ${origin}`;

    const buf = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-1', buf);
    const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');

    return `SAPISIDHASH ${ts}_${hex}`;
  } catch (err) {
    return null;
  }
}

// ─── TV OAUTH 2.0 DEVICE FLOW ────────────────────────────────────────
const TV_CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
const TV_CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';
let tvOAuthPollInterval = null;

async function requestDeviceCode() {
  const resp = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: TV_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/youtube'
    })
  });
  return await resp.json();
}

async function startPollingToken(device_code, interval) {
  if (tvOAuthPollInterval) clearInterval(tvOAuthPollInterval);
  return new Promise((resolve, reject) => {
    tvOAuthPollInterval = setInterval(async () => {
      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: TV_CLIENT_ID,
            client_secret: TV_CLIENT_SECRET,
            device_code: device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        const data = await resp.json();
        if (data.access_token) {
          clearInterval(tvOAuthPollInterval);
          tvOAuthPollInterval = null;
          data.expires_at = Date.now() + (data.expires_in * 1000);
          await chrome.storage.local.set({ tvOAuthToken: data });
          resolve(data);
        } else if (data.error !== 'authorization_pending' && data.error !== 'slow_down') {
          clearInterval(tvOAuthPollInterval);
          tvOAuthPollInterval = null;
          reject(data.error || 'Unknown error');
        }
      } catch (e) {
        clearInterval(tvOAuthPollInterval);
        tvOAuthPollInterval = null;
        reject(e.message);
      }
    }, interval * 1000);
  });
}

async function getTVAccessToken() {
  const storage = await chrome.storage.local.get('tvOAuthToken');
  let token = storage.tvOAuthToken;
  if (!token || !token.access_token) return null;

  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: TV_CLIENT_ID,
          client_secret: TV_CLIENT_SECRET,
          refresh_token: token.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const data = await resp.json();
      if (data.access_token) {
        token.access_token = data.access_token;
        token.expires_in = data.expires_in;
        token.expires_at = Date.now() + (data.expires_in * 1000);
        await chrome.storage.local.set({ tvOAuthToken: token });
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }
  return token.access_token;
}

// ─── DECLARATIVENETREQUEST: HEADER SPOOFING ──────────────────────────
const ORIGIN_RULE_ID = 9000;
const MEDIA_RULE_ID_BASE = 9100;

// Persistent rules: 
// 1. Spoof Origin/Referer/Sec-Fetch-* headers on ALL player API requests
// 2. Spoof User-Agent on googlevideo.com media segment fetches based on the client ('c=' parameter)
//    If we don't do this, googlevideo.com returns 403 for TV/Mobile URLs played on Desktop.
async function setupStaticRules() {
  try {
    const rulesToAdd = [];
    const rulesToRemove = [ORIGIN_RULE_ID];

    // 1. Origin spoofing for API requests
    rulesToAdd.push({
      id: ORIGIN_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
          { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
        ],
      },
      condition: {
        urlFilter: '*youtubei/v1/player*',
        resourceTypes: ['xmlhttprequest'],
      },
    });

    // 2. Media segment User-Agent spoofing for each client
    CLIENTS.forEach((c, index) => {
      const ruleId = MEDIA_RULE_ID_BASE + index;
      rulesToRemove.push(ruleId);

      if (c.ua) {
        rulesToAdd.push({
          id: ruleId,
          priority: 2,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'User-Agent', operation: 'set', value: c.ua }
            ],
          },
          condition: {
            // Match videoplayback URLs that have this client's name in the 'c' query parameter
            urlFilter: `*googlevideo.com/videoplayback*c=${c.clientName}*`,
            resourceTypes: ['xmlhttprequest', 'media', 'other'],
          },
        });
      }
    });

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rulesToRemove,
      addRules: rulesToAdd,
    });
    console.log(TAG, 'Static DNR rules (Origin + Media UA) enabled.');
  } catch (e) {
    console.error(TAG, 'Failed to setup static rules:', e);
  }
}

// Per-client UA override via declarativeNetRequest.
// resourceTypes includes 'xmlhttprequest' (page fetches) AND 'other' (SW fetch()).
async function enableUAOverride(ua) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [UA_RULE_ID],
      addRules: [{
        id: UA_RULE_ID,
        priority: 10,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: ua },
          ],
        },
        condition: {
          urlFilter: '*youtubei/v1/player*',
          // Include 'other' so SW fetch() calls are also covered
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      }],
    });
  } catch (e) { }
}

async function disableUAOverride() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [UA_RULE_ID] });
  } catch (e) { }
}

// (setupStaticRules is called at the end of the file now)

// ─── INNERTUBE NATIVE FETCHER ─────────────────────────────────────────
async function fetchFromClient(videoId, client) {
  const origin = 'https://www.youtube.com';
  let auth = null;
  let bearerToken = null;

  // Auth strategy:
  // TVHTML5: try Bearer OAuth first (Premium 774), fallback SAPISIDHASH
  // All others: SAPISIDHASH only
  if (client.name === 'TVHTML5') {
    bearerToken = await getTVAccessToken();
    if (bearerToken) auth = `Bearer ${bearerToken}`;
  }
  if (!auth) {
    auth = await getSapisidHash();
  }

  // Headers — when using Bearer token, drop X-Goog-AuthUser (conflicts with OAuth)
  const headers = {
    'Content-Type': 'application/json',
    'X-Youtube-Client-Name': client.clientId,
    'X-Youtube-Client-Version': client.clientVersion,
    'X-Origin': origin,
  };
  if (!bearerToken) {
    // Only needed for cookie-based (SAPISIDHASH) auth
    headers['X-Goog-AuthUser'] = '0';
  }
  if (auth) headers['Authorization'] = auth;

  // Payload — each client's own identity
  const clientObj = {
    clientName: client.clientName,
    clientVersion: client.clientVersion,
    hl: 'en',
    gl: 'US',
    ...client.extraContext,
  };
  if (client.ua) clientObj.userAgent = client.ua;

  // TVHTML5-specific client fields
  if (client.name === 'TVHTML5') {
    clientObj.deviceCategory = 'TV';
    clientObj.clientFormFactor = 'LARGE_FORM_FACTOR';
  }

  // Build context — TVHTML5 needs user + request blocks to pass validation
  const context = { client: clientObj };
  if (client.name === 'TVHTML5') {
    context.user = { lockedSafetyMode: false };
    context.request = { useSsl: true, internalExperimentFlags: [] };
  }

  const payload = {
    context,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };

  // TVHTML5 requires playbackContext for HTML5 stream selection
  if (client.name === 'TVHTML5') {
    payload.playbackContext = {
      contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
    };
  }

  // When using Bearer (OAuth), omit ?key= — YouTube TV rejects dual-auth requests
  let url;
  if (bearerToken) {
    url = `${origin}/youtubei/v1/player?prettyPrint=false`;
  } else {
    url = `${origin}/youtubei/v1/player?key=${client.apiKey}&prettyPrint=false`;
  }

  try {
    if (client.ua) await enableUAOverride(client.ua);

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: 'include',
    });

    if (client.ua) await disableUAOverride();

    if (!resp.ok) {
      let body = '';
      try { body = (await resp.text()).slice(0, 500); } catch (e) { }
      console.warn(TAG, `[${client.name}] HTTP ${resp.status} | Auth: ${auth ? auth.split(' ')[0] : 'none'} | Body: ${body}`);
      return { source: client.name, error: `HTTP ${resp.status}`, audioFormats: [] };
    }

    const data = await resp.json();

    if (data.playabilityStatus?.status === 'OK' && data.streamingData) {
      const allFormats = data.streamingData.adaptiveFormats || [];
      const audio = allFormats.filter(f => (f.mimeType || '').includes('audio/'));

      return {
        source: client.name,
        audioFormats: audio.map(f => ({ ...f, _src: client.name })),
      };
    }

    const reason = data.playabilityStatus?.reason || data.playabilityStatus?.status || 'No Stream';
    return { source: client.name, error: reason, audioFormats: [] };
  } catch (err) {
    if (client.ua) await disableUAOverride();
    return { source: client.name, error: err.message, audioFormats: [] };
  }
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_HQ') {
    const { videoId } = msg;

    (async () => {
      const storage = await chrome.storage.local.get('preferredClient');
      const pref = storage.preferredClient || 'AUTO';

      let targetClients = [...CLIENTS];
      if (pref !== 'AUTO') {
        const matched = CLIENTS.find(c => c.name === pref);
        if (matched) {
          targetClients = [matched, ...CLIENTS.filter(c => c.name !== pref)];
        }
      }

      const promises = targetClients.map(c => fetchFromClient(videoId, c));
      const rawResults = await Promise.all(promises);

      const results = rawResults.filter(r => r !== null);

      // ── Persist HQ results to session storage so inject.js can load them
      //    instantly on the NEXT page load (avoids the race-condition timing issue)
      if (results.some(r => r.audioFormats?.length > 0)) {
        const merged = results.flatMap(r => r.audioFormats || []);
        chrome.storage.session.set({ [`hq_${videoId}`]: { formats: merged, ts: Date.now() } })
          .catch(() => { });
      }

      sendResponse({ success: results.length > 0, results });
    })();

    return true;
  }

  if (msg.type === 'START_TV_AUTH') {
    (async () => {
      try {
        const codeData = await requestDeviceCode();
        sendResponse({ success: true, data: codeData });
        if (codeData.device_code) {
          startPollingToken(codeData.device_code, codeData.interval || 5)
            .catch(err => console.error(TAG, 'TV OAuth error:', err));
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'CHECK_TV_AUTH') {
    chrome.storage.local.get('tvOAuthToken').then(s => {
      sendResponse({ isAuth: !!(s.tvOAuthToken && s.tvOAuthToken.access_token) });
    });
    return true;
  }

  if (msg.type === 'LOGOUT_TV') {
    chrome.storage.local.remove('tvOAuthToken').then(() => {
      if (tvOAuthPollInterval) {
        clearInterval(tvOAuthPollInterval);
        tvOAuthPollInterval = null;
      }
      sendResponse({ success: true });
    });
    return true;
  }

  // ── Session cache: read cached HQ formats for a specific videoId
  if (msg.type === 'GET_SESSION_CACHE') {
    const TTL = 25000;
    chrome.storage.session.get(`hq_${msg.videoId}`).then(s => {
      const entry = s[`hq_${msg.videoId}`];
      if (entry && (Date.now() - entry.ts) < TTL) {
        sendResponse({ formats: entry.formats });
      } else {
        sendResponse({ formats: [] });
      }
    }).catch(() => sendResponse({ formats: [] }));
    return true;
  }

  if (msg.type === 'SW_PING') {
    sendResponse({ ready: true, version: '0.0.8' });
    return;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  disableUAOverride();
  setupStaticRules();
});

// Also run on startup just to be safe
setupStaticRules();
