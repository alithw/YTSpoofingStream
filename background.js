// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Service Worker Resolver                      ║
// ║  Multi-client InnerTube resolver + per-client header spoofing    ║
// ╚══════════════════════════════════════════════════════════════════╝

const TAG = '[YTSS-SW]';
const VERSION = chrome.runtime.getManifest().version;

// ─── FULL CLIENT CONFIGURATIONS ──────────────────────────────────────
// Restored from working v0.0.5: WEB_REMIX first (best HQ success rate)
const CLIENTS = [
  {
    name: 'WEB_REMIX',
    clientName: 'WEB_REMIX',
    clientVersion: '1.20260901.12.00',
    clientId: '67',
    apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    ua: null,
    extraContext: {},
  },
  {
    name: 'TVHTML5',
    clientName: 'TVHTML5',
    // Taken from a live youtube.com/tv session (2026-08-01): the page sent
    // `x-youtube-client-version: 7.20260728.17.00` and the signed videoplayback URL
    // came back with `cver=7.20260728.17.00`. The previous value here was
    // 7.20230405.08.01 — roughly three years stale, and stale TV versions are one of
    // the documented causes of a 200 response whose playabilityStatus is
    // "This video is unavailable".
    clientVersion: '7.20260728.17.00',
    clientId: '7',
    apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1',
    extraContext: {
      deviceMake: 'Samsung',
      deviceModel: 'SmartTV',
    },
  },
  {
    // ANDROID (clientId 3)
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


// Stable index per client — used to build the per-client DNR rule IDs and the
// `_ytss_c=<idx>` URL marker those rules match on. Must stay stable for the
// lifetime of the SW, so it is derived from array position exactly once.
CLIENTS.forEach((c, i) => { c.idx = i; });

// ─── AUTHENTICATION ──────────────────────────────────────────────────
// YouTube web derives its Authorization header from up to three cookies, each with
// its own hash prefix. Sending only `SAPISIDHASH` while hashing a 3PAPISID value
// (the old behaviour) produces an Authorization the server rejects, so the request
// falls back to unauthenticated and Premium-only formats are stripped from it.
const SAPISID_COOKIES = [
  { name: 'SAPISID', prefix: 'SAPISIDHASH' },
  { name: '__Secure-1PAPISID', prefix: 'SAPISID1PHASH' },
  { name: '__Secure-3PAPISID', prefix: 'SAPISID3PHASH' },
];

async function sha1Hex(input) {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSapisidHash(origin = 'https://www.youtube.com') {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const parts = [];

    for (const { name, prefix } of SAPISID_COOKIES) {
      const cookie = await chrome.cookies.get({ url: origin, name });
      if (!cookie?.value) continue;
      const hex = await sha1Hex(`${ts} ${cookie.value} ${origin}`);
      parts.push(`${prefix} ${ts}_${hex}`);
    }

    return parts.length ? parts.join(' ') : null;
  } catch (err) {
    return null;
  }
}

// ─── PAGE CONTEXT (visitorData / session index) ───────────────────────
// InnerTube drops high-quality formats when a spoofed client sends no visitorData
// that matches the logged-in session. inject.js reads these values out of the page's
// own ytcfg and relays them here via bridge.js (YTSS_PAGE_CONTEXT).
// Mirrored into chrome.storage.session so the values survive a service worker restart.
let pageContext = { visitorData: null, sessionIndex: null, delegatedSessionId: null };

async function loadPageContext() {
  try {
    const s = await chrome.storage.session.get('pageContext');
    if (s.pageContext) pageContext = { ...pageContext, ...s.pageContext };
  } catch (e) { }
}
// Kept as a promise so request handlers can await it. Chrome evicts this worker
// after ~30s idle; without the await, the FETCH_HQ that woke it up would read an
// empty pageContext and resolve every client unauthenticated, which makes InnerTube
// strip the Premium-only formats for the rest of the page's life.
const pageContextReady = loadPageContext();

function setPageContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  const next = { ...pageContext };
  if (typeof ctx.visitorData === 'string' && ctx.visitorData) next.visitorData = ctx.visitorData;
  if (ctx.sessionIndex !== undefined && ctx.sessionIndex !== null) next.sessionIndex = String(ctx.sessionIndex);
  // Accept an explicit null/'' as "clear it". Unlike visitorData and sessionIndex,
  // this field is not self-healing: a page that has left a brand/delegated account
  // reports null, and treating that as "no update" would pin a stale X-Goog-PageId
  // onto every later request for the rest of the browser session.
  if (ctx.delegatedSessionId === null || typeof ctx.delegatedSessionId === 'string') {
    next.delegatedSessionId = ctx.delegatedSessionId || null;
  }
  if (ctx.sts) next.sts = ctx.sts;
  if (ctx.poToken) next.poToken = ctx.poToken;

  const changed = JSON.stringify(next) !== JSON.stringify(pageContext);
  pageContext = next;
  if (changed) {
    console.log(TAG, `[PageContext] visitorData=${next.visitorData ? 'set' : 'none'} authUser=${next.sessionIndex ?? '0'}`);
    chrome.storage.session.set({ pageContext: next }).catch(() => { });
  }
}


// ─── MULTI-CLIENT OAUTH 2.0 DEVICE FLOW (TVHTML5, ANDROID_MUSIC, ANDROID_VR) ─────────
const OAUTH_CLIENTS = {
  TVHTML5: {
    storageKey: 'tvOAuthToken',
    clientId: '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com',
    clientSecret: 'SboVhoG9s0rNafixCSGGKXAT',
    scope: 'https://www.googleapis.com/auth/youtube'
  }
};

const oauthPollIntervals = {};

async function requestDeviceCode(clientType = 'TVHTML5') {
  const conf = OAUTH_CLIENTS[clientType] || OAUTH_CLIENTS.TVHTML5;
  const resp = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: conf.clientId,
      scope: conf.scope
    })
  });
  return await resp.json();
}

async function startPollingToken(clientType, device_code, interval) {
  const conf = OAUTH_CLIENTS[clientType] || OAUTH_CLIENTS.TVHTML5;
  if (oauthPollIntervals[clientType]) clearInterval(oauthPollIntervals[clientType]);

  return new Promise((resolve, reject) => {
    oauthPollIntervals[clientType] = setInterval(async () => {
      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: conf.clientId,
            client_secret: conf.clientSecret,
            device_code: device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        const data = await resp.json();
        if (data.access_token) {
          clearInterval(oauthPollIntervals[clientType]);
          oauthPollIntervals[clientType] = null;
          data.expires_at = Date.now() + (data.expires_in * 1000);
          await chrome.storage.local.set({ [conf.storageKey]: data });
          resolve(data);
        } else if (data.error !== 'authorization_pending' && data.error !== 'slow_down') {
          clearInterval(oauthPollIntervals[clientType]);
          oauthPollIntervals[clientType] = null;
          reject(data.error || 'Unknown error');
        }
      } catch (e) {
        clearInterval(oauthPollIntervals[clientType]);
        oauthPollIntervals[clientType] = null;
        reject(e.message);
      }
    }, interval * 1000);
  });
}

async function getClientAccessToken(clientType) {
  const conf = OAUTH_CLIENTS[clientType];
  if (!conf) return null;

  const storage = await chrome.storage.local.get(conf.storageKey);
  let token = storage[conf.storageKey];
  if (!token || !token.access_token) return null;

  const expiresAt = Number(token.expires_at);
  const needsRefresh = !Number.isFinite(expiresAt) || Date.now() > expiresAt - 5 * 60 * 1000;

  if (needsRefresh) {
    if (!token.refresh_token) {
      return null;
    }
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: conf.clientId,
          client_secret: conf.clientSecret,
          refresh_token: token.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const data = await resp.json();
      if (data.access_token) {
        token.access_token = data.access_token;
        token.expires_in = data.expires_in;
        token.expires_at = Date.now() + (data.expires_in * 1000);
        await chrome.storage.local.set({ [conf.storageKey]: token });
        console.log(TAG, `[OAuth] refreshed ${clientType} access_token, valid ${Math.round(data.expires_in / 60)}min`);
      } else {
        if (data.error === 'invalid_grant') {
          await chrome.storage.local.remove(conf.storageKey).catch(() => {});
        }
        return null;
      }
    } catch (e) {
      return null;
    }
  }
  return token.access_token;
}

async function getTVAccessToken() {
  return getClientAccessToken('TVHTML5');
}

// ─── DECLARATIVENETREQUEST: HEADER SPOOFING ──────────────────────────
const ORIGIN_RULE_ID       = 9000;
const MEDIA_RULE_ID_BASE   = 9100;
const SABR_BLOCK_RULE_ID   = 9200;
const BLACKLIST_BLOCK_RULE_ID = 9201;
const SW_BLOCK_RULE_ID     = 9300;
const API_UA_RULE_ID_BASE  = 9400;
const CORS_RULE_ID         = 9500;

// Escape a string for safe embedding in a DNR regexFilter.
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Persistent rules:
// 1. Spoof Origin/Referer/Sec-Fetch-* headers on ALL player API requests
// 2. Spoof User-Agent on the SW's own player API request, per client. Each client
//    tags its request URL with `_ytss_c=<idx>` and gets its OWN rule matching that
//    tag, so all clients can be resolved in parallel without clobbering each other.
// 3. Spoof User-Agent on googlevideo.com media segment fetches based on the client
//    ('c=' parameter). Without this, googlevideo.com returns 403 for TV/Mobile URLs
//    played on Desktop.
async function setupStaticRules() {
  try {
    const storage = await chrome.storage.local.get('enabled');
    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    const existingIds = existingRules.map(r => r.id);

    if (storage.enabled === false) {
      if (existingIds.length > 0) {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: existingIds,
          addRules: [],
        });
      }
      console.log(TAG, 'Extension is DISABLED: Wiped all declarativeNetRequest rules.');
      return;
    }

    const YTM_FRAME_RULE_ID = 9197;
    const YTM_API_RULE_ID = 9198;
    const WEB_REMIX_MEDIA_RULE_ID = 9199;
    const rulesToAdd = [];
    const rulesToRemove = [...existingIds, ORIGIN_RULE_ID, YTM_FRAME_RULE_ID, YTM_API_RULE_ID, WEB_REMIX_MEDIA_RULE_ID, SABR_BLOCK_RULE_ID, BLACKLIST_BLOCK_RULE_ID, SW_BLOCK_RULE_ID];

    // 1. Origin spoofing for www.youtube.com API requests.
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
        excludedRequestDomains: ['music.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });

    // 1b. Dedicated Origin & Referer for music.youtube.com API requests
    rulesToAdd.push({
      id: YTM_API_RULE_ID,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://music.youtube.com' },
          { header: 'Referer', operation: 'set', value: 'https://music.youtube.com/' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
          { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
        ],
      },
      condition: {
        urlFilter: '*music.youtube.com/youtubei/v1/*',
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });

    // 1c. Remove frame restrictions for music.youtube.com in offscreen/subframes
    rulesToAdd.push({
      id: YTM_FRAME_RULE_ID,
      priority: 25,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'X-Frame-Options', operation: 'remove' },
          { header: 'Content-Security-Policy', operation: 'remove' },
        ],
      },
      condition: {
        urlFilter: '*music.youtube.com/*',
        resourceTypes: ['sub_frame'],
      },
    });

    // 2. Per-client User-Agent for the player API request.
    CLIENTS.forEach((c) => {
      const ruleId = API_UA_RULE_ID_BASE + c.idx;
      rulesToRemove.push(ruleId);
      if (!c.ua) return;

      rulesToAdd.push({
        id: ruleId,
        priority: 20,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: c.ua },
          ],
        },
        condition: {
          urlFilter: `*youtubei/v1/player*_ytss_c=${c.idx}*`,
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      });
    });

    // 3. Media segment User-Agent spoofing for each client.
    CLIENTS.forEach((c) => {
      const ruleId = MEDIA_RULE_ID_BASE + c.idx;
      rulesToRemove.push(ruleId);
      if (!c.ua) return;

      rulesToAdd.push({
        id: ruleId,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: c.ua }
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
            { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          ],
        },
        condition: {
          regexFilter: `^https?://.*\\.googlevideo\\.com/videoplayback.*(?:[?&]c=|/c/)${c.clientName}(?:[&/]|$)`,
          resourceTypes: ['xmlhttprequest', 'media', 'other', 'main_frame', 'sub_frame'],
        },
      });
    });

    // 3b. Origin & Referer spoofing for WEB_REMIX media streams (prevents 403 on googlevideo.com)
    rulesToAdd.push({
      id: WEB_REMIX_MEDIA_RULE_ID,
      priority: 15,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://music.youtube.com/' },
          { header: 'Origin', operation: 'set', value: 'https://music.youtube.com' },
        ],
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
        ],
      },
      condition: {
        regexFilter: '^https?://.*\\.googlevideo\\.com/videoplayback.*(?:[?&]c=|/c/)WEB_REMIX(?:[&/]|.*)',
        resourceTypes: ['media', 'xmlhttprequest', 'other'],
      },
    });

    // 4. Block the streaming_data_emergency_itag_blacklist endpoint on www.youtube.com.
    rulesToRemove.push(BLACKLIST_BLOCK_RULE_ID);
    rulesToAdd.push({
      id: BLACKLIST_BLOCK_RULE_ID,
      priority: 5,
      action: { type: 'block' },
      condition: {
        urlFilter: '*streaming_data_emergency_itag_blacklist*',
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });

    // 5. Block YouTube Service Worker on www.youtube.com ONLY (Never block music.youtube.com)
    rulesToRemove.push(SW_BLOCK_RULE_ID);
    rulesToAdd.push({
      id: SW_BLOCK_RULE_ID,
      priority: 6,
      action: { type: 'block' },
      condition: {
        regexFilter: '^https?://www\\.youtube\\.com/sw\\.js',
        resourceTypes: ['script', 'other', 'xmlhttprequest'],
      },
    });

    // 6. Enable CORS headers for googlevideo.com so Web Audio API FFT analyser can measure full spectrum
    rulesToRemove.push(CORS_RULE_ID);
    rulesToAdd.push({
      id: CORS_RULE_ID,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges' }
        ]
      },
      condition: {
        urlFilter: '||googlevideo.com',
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    });

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rulesToRemove,
      addRules: rulesToAdd,
    });
    console.log(TAG, `Static DNR rules enabled (${rulesToAdd.length} rules: Origin + per-client API UA + Media UA + Blacklist/SW Block + CORS).`);
  } catch (e) {
    console.error(TAG, 'Failed to setup static rules:', e);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled !== undefined) {
    setupStaticRules();
  }
});

// (setupStaticRules is called at the end of the file)

// ─── INNERTUBE NATIVE FETCHER ─────────────────────────────────────────
async function fetchFromClient(videoId, client) {
  // This worker gets evicted after ~30s idle, and the FETCH_HQ that wakes it back up
  // races the session-storage restore. Without this await the first request after every
  // eviction goes out with no visitorData/authUser, InnerTube answers without the
  // Premium formats, and the page has no way to know it should re-send its context.
  await pageContextReady;
  const origin = 'https://www.youtube.com';
  let auth = null;
  let bearerToken = null;

  const isMobileClient = client.name.startsWith('ANDROID') || client.name === 'IOS';
  const isTVClient = client.name.startsWith('TVHTML5');

  // Auth strategy:
  // TVHTML5: Check login TV trước khi fetch! Không có login -> Premium thì nghỉ
  // WEB_REMIX / TVHTML5_SIMPLY: SAPISIDHASH
  // Mobile clients (ANDROID, IOS, etc.): No web SAPISIDHASH (causes HTTP 400 Bad Request)
  if (isTVClient) {
    bearerToken = await getClientAccessToken('TVHTML5');
    if (!bearerToken) {
      console.warn(TAG, `[${client.name}] TV client requires login (Premium) -> Skipping fetch.`);
      return { source: client.name, error: 'NO_TV_LOGIN', audioFormats: [] };
    }
    auth = `Bearer ${bearerToken}`;
  } else if (client.name === 'ANDROID_MUSIC') {
    bearerToken = await getClientAccessToken('ANDROID_MUSIC');
    if (bearerToken) auth = `Bearer ${bearerToken}`;
  } else if (client.name === 'ANDROID_VR') {
    bearerToken = await getClientAccessToken('ANDROID_VR');
    if (bearerToken) auth = `Bearer ${bearerToken}`;
  }

  if (!auth && !isMobileClient) {
    auth = await getSapisidHash(origin);
  }

  // Headers — when using Bearer token or Mobile, omit web-only AuthUser/VisitorId
  const headers = {
    'Content-Type': 'application/json',
  };
  
  // Only Web and TV clients send client info in headers. Mobile clients only send it in the JSON body.
  if (!isMobileClient) {
    headers['X-Youtube-Client-Name'] = client.clientId;
    headers['X-Youtube-Client-Version'] = client.clientVersion;
  }
  if (!isMobileClient) {
    headers['X-Origin'] = origin;
  }
  if (!bearerToken && !isMobileClient) {
    headers['X-Goog-AuthUser'] = pageContext.sessionIndex ?? '0';
    if (pageContext.delegatedSessionId) {
      headers['X-Goog-PageId'] = pageContext.delegatedSessionId;
    }
  }

  // visitorData: send ONLY for WEB_REMIX when using web cookies.
  // Pairing Web visitorData with TV/Mobile clients causes "Video unavailable" or HTTP 400.
  const allowVisitorData = !bearerToken && !isMobileClient && client.name === 'WEB_REMIX';
  if (allowVisitorData && pageContext.visitorData) {
    headers['X-Goog-Visitor-Id'] = pageContext.visitorData;
  }
  if (auth) headers['Authorization'] = auth;

  // Payload — each client's own identity
  const clientObj = {
    clientName: client.clientName,
    clientVersion: client.clientVersion,
    hl: pageContext.hl || 'vi',
    gl: pageContext.gl || 'VN',
    ...client.extraContext,
  };
  if (client.ua) clientObj.userAgent = client.ua;
  if (allowVisitorData && pageContext.visitorData) clientObj.visitorData = pageContext.visitorData;

  // TVHTML5-specific client fields
  if (isTVClient) {
    clientObj.deviceCategory = 'TV';
    clientObj.clientFormFactor = 'LARGE_FORM_FACTOR';
  }

  // Build context — TVHTML5 needs user + request blocks to pass validation
  const context = { client: clientObj };
  if (isTVClient) {
    context.user = {
      lockedSafetyMode: false,
      audioQuality: 'AUDIO_QUALITY_HIGH'
    };
    context.request = {
      useSsl: true,
      internalExperimentFlags: [
        { key: 'tv_high_quality_audio', value: 'true' },
        { key: 'html5_audio_quality', value: 'high' }
      ]
    };
  }

  const payload = {
    context,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {
        ...(client.name !== 'WEB_REMIX' && { signatureTimestamp: pageContext.sts || 20696 }),
        audioQualityPreference: 'AUDIO_QUALITY_HIGH',
      },
    },
  };

  if (!isMobileClient || client.name === 'ANDROID_VR') {
    payload.playbackContext.contentPlaybackContext.html5Preference = 'HTML5_PREF_WANTS';
  }

  if (client.name === 'WEB_REMIX' && pageContext.poToken) {
    payload.serviceIntegrityDimensions = {
      poToken: pageContext.poToken
    };
    context.request = context.request || {};
    context.request.useSsl = true;
  }

  // Always include key=client.apiKey on the URL. InnerTube API gateway requires it for all clients.
  const url = `${origin}/youtubei/v1/player?key=${client.apiKey}&prettyPrint=false&_ytss_c=${client.idx}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: bearerToken ? 'omit' : 'include',
    });

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

      // _cver rides along so inject.js can restore the exact client version this URL
      // was signed under, instead of guessing from a table that can drift out of sync.
      const result = {
        source: client.name,
        audioFormats: audio.map(f => ({ ...f, _src: client.name, _cver: client.clientVersion })),
      };

      // ── Phase 1 (Option D): capture TVHTML5 streaming context.
      //    TVHTML5 returns a legitimately-signed SABR config that already contains
      //    774 in its format table. Option D will POST against this URL with this
      //    config instead of trying to forge entitlement on the WEB client.
      //    We persist the whole streamingData blob (minus the formats we already
      //    extracted) so inject.js can drive its own SABR session against the TV
      //    endpoint. Only capture for TVHTML5 — WEB/Android configs are useless
      //    for Option D (their signed tables omit 774).
      if (isTVClient && data.streamingData.serverAbrStreamingUrl) {
        result.streamingContext = {
          source: client.name,
          clientVersion: client.clientVersion,
          serverAbrStreamingUrl: data.streamingData.serverAbrStreamingUrl,
          // ustreamerConfig is the signed SABR config blob. May be a base64 string
          // or an object depending on InnerTube variant; preserve as-is.
          ustreamerConfig: data.streamingData.ustreamerConfig || null,
          // poToken / visitorData the TV session was negotiated under. Option D
          // must echo these in its SABR POST headers to avoid opaque 403s.
          poToken: pageContext.poToken || null,
          visitorData: data.responseContext?.visitorData || clientObj.visitorData || null,
          // Signature timestamp the TV player was signed under.
          sts: pageContext.sts || 20696,
          ts: Date.now(),
        };
        console.log(TAG, `[${client.name}] captured streamingContext: sabrUrl=${data.streamingData.serverAbrStreamingUrl.slice(0, 80)}... ustreamerConfig=${data.streamingData.ustreamerConfig ? 'present' : 'absent'}`);
      }

      return result;
    }

    const reason = data.playabilityStatus?.reason || data.playabilityStatus?.status || 'No Stream';
    return { source: client.name, error: reason, audioFormats: [] };
  } catch (err) {
    return { source: client.name, error: err.message, audioFormats: [] };
  }
}

// ─── OFFSCREEN HARVESTER & WEBREQUEST LISTENER ───────────────────────
async function ensureOffscreenDocument() {
  if (chrome.offscreen) {
    if (await chrome.offscreen.hasDocument?.()) {
      return;
    }
    try {
      await chrome.offscreen.createDocument({
        url: 'harvester.html',
        reasons: ['IFRAME_SCRIPTING', 'DOM_PARSER'],
        justification: 'Harvest HQ audio streams from YouTube Music and TV',
      });
      console.log(TAG, '[Harvester] Offscreen document created');
    } catch (err) {
      if (!err.message?.includes('Only a single offscreen document may be created')) {
        console.warn(TAG, '[Harvester] Offscreen creation error:', err);
      }
    }
  }
}

let activeHarvestSession = null;

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = details.url;
      if (!url || !url.includes('videoplayback')) return;

      // STRICT: ONLY intercept genuine ITAG 774 Opus ~280kbps
      const is774 = url.includes('itag=774');
      if (!is774) return;

      // CRITICAL: Only intercept requests originating from offscreen harvester document (tabId === -1).
      // Normal browser tabs (such as the active YouTube player tab) have tabId >= 0.
      // We must NEVER intercept playback requests from the user's active YouTube tab!
      if (details.tabId !== -1) return;

      // Ensure initiator is NOT www.youtube.com
      if (details.initiator && details.initiator.includes('www.youtube.com')) return;

      if (activeHarvestSession) {
        console.log(TAG, `[WebRequest] Intercepted deciphered ITAG 774 stream for ${activeHarvestSession.videoId}`);

        // Strip range and chunking params to get full base stream URL
        let cleanUrl = url.split('&range=')[0];
        cleanUrl = cleanUrl.replace(/&rn=\d+/, '').replace(/&rbuf=\d+/, '');

        const fmt = {
          itag: 774,
          _origItag: 774,
          url: cleanUrl,
          _directUrl: cleanUrl,
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 280000,
          audioQuality: 'AUDIO_QUALITY_HIGH',
          _src: activeHarvestSession.opMode === 'TV_HEADLESS' ? 'TV_HEADLESS' : 'YTM_HARVESTER',
        };

        const resolve = activeHarvestSession.resolve;
        activeHarvestSession = null;

        // Reset harvester frame to avoid background playback load
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_HARVEST' }).catch(() => {});

        resolve([fmt]);
      }
    },
    { urls: ["*://*.googlevideo.com/videoplayback*"] }
  );
}

const pendingHarvests = new Map(); // videoId -> Promise
let harvestQueue = Promise.resolve();

async function harvestViaYtm(videoId, title = null, author = null) {
  if (pendingHarvests.has(videoId)) {
    console.log(TAG, `[YTM_HARVEST] Joining existing harvest session for ${videoId}`);
    return pendingHarvests.get(videoId);
  }

  const p = new Promise((resolve) => {
    harvestQueue = harvestQueue.then(async () => {
      try {
        const res = await _doHarvest(videoId, title, author);
        resolve(res);
      } catch (e) {
        console.warn(TAG, `[YTM_HARVEST] Error harvesting ${videoId}:`, e);
        resolve([]);
      }
    });
  }).finally(() => {
    pendingHarvests.delete(videoId);
  });

  pendingHarvests.set(videoId, p);
  return p;
}

async function _doHarvest(videoId, title = null, author = null) {
  await ensureOffscreenDocument();

  // Always harvest the exact requested videoId in the offscreen iframe
  // NEVER substitute an arbitrary different video from search!
  const targetId = videoId;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (activeHarvestSession && activeHarvestSession.videoId === videoId) {
        activeHarvestSession = null;
        console.log(TAG, `[YTM_HARVEST] Timeout for ${videoId}, falling back to native`);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_HARVEST' }).catch(() => {});
        resolve([]);
      }
    }, 8000);

    activeHarvestSession = {
      videoId,
      targetId,
      resolve: (formats) => {
        clearTimeout(timer);
        resolve(formats);
      }
    };

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_HARVEST_YTM',
      videoId: targetId
    }).catch(err => {
      console.warn(TAG, '[YTM_HARVEST] Offscreen message error:', err);
      resolve([]);
    });
  });
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_HARVEST_ABORT') {
    if (activeHarvestSession && activeHarvestSession.videoId === msg.videoId) {
      console.log(TAG, `[YTM_HARVEST] Harvest aborted for ${msg.videoId}: ${msg.reason}`);
      const resolve = activeHarvestSession.resolve;
      activeHarvestSession = null;
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_HARVEST' }).catch(() => {});
      resolve([]);
    }
    sendResponse({ received: true });
    return true;
  }

  if (msg.type === 'FETCH_HQ') {
    const { videoId, title, author } = msg;
    // Ignore anything that isn't a real 11-char YouTube ID.
    if (!/^[\w-]{11}$/.test(videoId || '')) {
      sendResponse({ success: false, results: [], error: 'invalid videoId' });
      return true;
    }
    if (msg.context) setPageContext(msg.context);

    (async () => {
      const storage = await chrome.storage.local.get(['preferredClient', 'enabled', 'operationMode']);
      if (storage.enabled === false) {
        sendResponse({ success: false, results: [], error: 'disabled' });
        return;
      }

      const opMode = msg.opMode || storage.operationMode || 'HYBRID_HQ';

      // ── HYBRID MODE: HYBRID_HQ (Full 774 Support: YTM Harvester -> TV Headless -> Cancel)
      if (opMode === 'HYBRID_HQ') {
        console.log(TAG, `[FETCH_HQ] Mode: HYBRID_HQ hunting for 774 on exact video ${videoId}...`);

        // Step 1: Harvest from YTM for the EXACT video (strict 774 only)
        const ytmFormats = await harvestViaYtm(videoId, title, author);
        if (ytmFormats && ytmFormats.length > 0) {
          const has774 = ytmFormats.some(f => f.itag === 774);
          if (has774) {
            console.log(TAG, `[FETCH_HQ] HYBRID_HQ successfully harvested 774 for exact video ${videoId}`);
            const results = [{ source: 'HYBRID_774', audioFormats: ytmFormats }];
            chrome.storage.session.set({
              [`hq_${videoId}`]: { formats: ytmFormats, streamingContext: null, ts: Date.now() }
            }).catch(() => {});
            sendResponse({ success: true, results, streamingContext: null, opMode: 'HYBRID_HQ' });
            return;
          }
        }

        // Step 2: Fallback to TV Headless (Mode 1) ONLY if user is logged into TV with Premium!
        // "check login tv trước khi fetch, k có login -> premium thì nghỉ"
        const tvToken = await getClientAccessToken('TVHTML5');
        if (tvToken) {
          console.log(TAG, `[FETCH_HQ] HYBRID_HQ: Checking TV client for ${videoId} with Premium login...`);
          const tvClient = CLIENTS.find(c => c.name === 'TVHTML5');
          const tvRes = tvClient ? await fetchFromClient(videoId, tvClient) : null;
          const tvHas774 = tvRes?.audioFormats?.some(f => f.itag === 774);
          if (tvHas774) {
            console.log(TAG, `[FETCH_HQ] HYBRID_HQ: TV confirmed 774 for exact video ${videoId}`);
            const results = [{ source: 'TVHTML5', audioFormats: tvRes.audioFormats }];
            chrome.storage.session.set({
              [`hq_${videoId}`]: { formats: tvRes.audioFormats, streamingContext: tvRes?.streamingContext || null, ts: Date.now() }
            }).catch(() => {});
            sendResponse({ success: true, results, streamingContext: tvRes?.streamingContext || null, opMode: 'HYBRID_HQ' });
            return;
          }
        }

        // Exact video has no 774 stream -> HỦY ĐI! Cancel spoofing, let native play as requested!
        console.log(TAG, `[FETCH_HQ] HYBRID_HQ: No genuine 774 stream found for ${videoId} -> Cancelled.`);
        sendResponse({ success: false, results: [], error: 'NO_774_STREAM', opMode: 'HYBRID_HQ' });
        return;
      }

      // ── MODE 4: YTM_HARVESTER (Direct 774 Opus from YouTube Music)
      if (opMode === 'YTM_HARVESTER') {
        console.log(TAG, `[FETCH_HQ] Mode 4 (YTM_HARVESTER) harvesting for exact video ${videoId}...`);
        const formats = await harvestViaYtm(videoId, title, author);
        const has774 = formats && formats.some(f => f.itag === 774);
        if (has774) {
          console.log(TAG, `[FETCH_HQ] Mode 4 successfully harvested 774 for exact video ${videoId}!`);
          const results = [{ source: 'YTM_HARVESTER', audioFormats: formats }];
          chrome.storage.session.set({
            [`hq_${videoId}`]: { formats, streamingContext: null, ts: Date.now() }
          }).catch(() => {});
          sendResponse({ success: true, results, streamingContext: null, opMode: 'YTM_HARVESTER' });
          return;
        }
        console.log(TAG, `[FETCH_HQ] Mode 4: No 774 stream found for ${videoId} -> Cancelled.`);
        sendResponse({ success: false, results: [], error: 'NO_774_STREAM', opMode: 'YTM_HARVESTER' });
        return;
      }

      // ── MODE 1: TV_HEADLESS (TV SABR 774 Relay)
      if (opMode === 'TV_HEADLESS') {
        console.log(TAG, `[FETCH_HQ] Mode 1 (TV_HEADLESS) resolving for ${videoId}...`);
        // Check TV login first! "check login tv trước khi fetch, k có login -> premium thì nghỉ"
        const tvToken = await getClientAccessToken('TVHTML5');
        if (!tvToken) {
          console.warn(TAG, `[FETCH_HQ] Mode 1: No TV login (Premium required) -> Stopping.`);
          sendResponse({ success: false, results: [], error: 'NO_TV_LOGIN', opMode: 'TV_HEADLESS' });
          return;
        }

        const tvClient = CLIENTS.find(c => c.name === 'TVHTML5');
        const tvRes = tvClient ? await fetchFromClient(videoId, tvClient) : null;
        const tvHas774 = tvRes?.audioFormats?.some(f => f.itag === 774);
        const tvCtx = tvRes?.streamingContext || null;
        if (tvCtx) {
          chrome.storage.session.set({ [`tvctx_${videoId}`]: tvCtx }).catch(() => {});
        }

        if (!tvHas774) {
          console.log(TAG, `[FETCH_HQ] Mode 1: Exact video ${videoId} has NO 774 on TV -> Cancelling.`);
          sendResponse({ success: false, results: [], error: 'NO_774_STREAM', opMode: 'TV_HEADLESS' });
          return;
        }

        // TV confirmed 774 is available!
        console.log(TAG, `[FETCH_HQ] Mode 1: TV confirmed 774 for ${videoId}`);
        const harvested = await harvestViaYtm(videoId, title, author);
        if (harvested && harvested.some(f => f.itag === 774)) {
          const results = [{ source: 'TV_HEADLESS', audioFormats: harvested.map(f => ({ ...f, _src: 'TV_HEADLESS' })) }];
          chrome.storage.session.set({
            [`hq_${videoId}`]: { formats: results[0].audioFormats, streamingContext: tvCtx, ts: Date.now() }
          }).catch(() => {});
          sendResponse({ success: true, results, streamingContext: tvCtx, opMode: 'TV_HEADLESS' });
          return;
        }

        // Direct TVHTML5 774 format
        console.log(TAG, `[FETCH_HQ] Mode 1: Delivering authenticated TVHTML5 ITAG 774 for ${videoId}`);
        const results = [{ source: 'TVHTML5', audioFormats: tvRes.audioFormats }];
        chrome.storage.session.set({
          [`hq_${videoId}`]: { formats: tvRes.audioFormats, streamingContext: tvCtx, ts: Date.now() }
        }).catch(() => {});
        sendResponse({ success: true, results, streamingContext: tvCtx, opMode: 'TV_HEADLESS' });
        return;
      }

      // ── FALLBACK / AUTO: Multi-client innerTube resolver
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
      const tvCtx = results.find(r => r.streamingContext)?.streamingContext || null;

      if (results.some(r => r.audioFormats?.length > 0)) {
        const merged = results.flatMap(r => r.audioFormats || []);
        chrome.storage.session.set({
          [`hq_${videoId}`]: { formats: merged, streamingContext: tvCtx, ts: Date.now() }
        }).catch(() => {});
      }

      sendResponse({ success: results.length > 0, results, streamingContext: tvCtx, opMode: 'AUTO' });
    })();

    return true;
  }

  if (msg.type === 'OFFSCREEN_HARVEST_ABORT') {
    if (activeHarvestSession && (!msg.videoId || activeHarvestSession.videoId === msg.videoId)) {
      console.log(TAG, `[YTM_HARVEST] Aborted harvest for ${activeHarvestSession.videoId} (reason: ${msg.reason})`);
      const resolve = activeHarvestSession.resolve;
      activeHarvestSession = null;
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_HARVEST' }).catch(() => {});
      resolve([]);
    }
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'START_CLIENT_AUTH' || msg.type === 'START_TV_AUTH') {
    const clientType = msg.client || 'TVHTML5';
    (async () => {
      try {
        const codeData = await requestDeviceCode(clientType);
        sendResponse({ success: true, data: codeData });
        if (codeData.device_code) {
          startPollingToken(clientType, codeData.device_code, codeData.interval || 5)
            .catch(err => console.error(TAG, `${clientType} OAuth error:`, err));
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'CHECK_CLIENT_AUTH' || msg.type === 'CHECK_TV_AUTH') {
    const clientType = msg.client || 'TVHTML5';
    const storageKey = OAUTH_CLIENTS[clientType]?.storageKey || 'tvOAuthToken';
    chrome.storage.local.get(storageKey).then(s => {
      sendResponse({ isAuth: !!(s[storageKey] && s[storageKey].access_token) });
    });
    return true;
  }

  if (msg.type === 'LOGOUT_CLIENT' || msg.type === 'LOGOUT_TV') {
    const clientType = msg.client || 'TVHTML5';
    const storageKey = OAUTH_CLIENTS[clientType]?.storageKey || 'tvOAuthToken';
    chrome.storage.local.remove(storageKey).then(() => {
      if (oauthPollIntervals[clientType]) {
        clearInterval(oauthPollIntervals[clientType]);
        oauthPollIntervals[clientType] = null;
      }
      sendResponse({ success: true });
    });
    return true;
  }

  // ── Phase 1 (Option D): inject.js queries the captured TVHTML5 streaming
  //    context (serverAbrStreamingUrl + ustreamerConfig) for a given videoId.
  //    Returns null if TVHTML5 hasn't been fetched yet or didn't return SABR.
  if (msg.type === 'GET_TVCTX') {
    const { videoId } = msg;
    if (!videoId) { sendResponse({ streamingContext: null }); return true; }
    chrome.storage.session.get(`tvctx_${videoId}`).then(s => {
      const ctx = s[`tvctx_${videoId}`];
      if (ctx && (Date.now() - ctx.ts <= 3600000)) {
        sendResponse({ streamingContext: ctx });
      } else {
        sendResponse({ streamingContext: null });
      }
    }).catch(() => sendResponse({ streamingContext: null }));
    return true;
  }

  // ── Page context relayed from inject.js via bridge.js.
  //    Supplies visitorData / session index so spoofed clients look like the
  //    real logged-in session (see setPageContext).
  if (msg.type === 'PAGE_CONTEXT_UPDATE') {
    setPageContext(msg.context);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SW_PING') {
    sendResponse({ ready: true, version: VERSION });
    return;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setupStaticRules();
});

chrome.runtime.onStartup.addListener(() => {
  setupStaticRules();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ytss-keepalive') {
    chrome.declarativeNetRequest.getSessionRules().then(rules => {
      const hasOriginRule = rules.some(r => r.id === ORIGIN_RULE_ID);
      if (!hasOriginRule) {
        console.log(TAG, '[Keepalive] DNR rules missing — re-applying...');
        setupStaticRules();
      }
    }).catch(() => {});
  }
});

// ─── TAB ACTIVATION: PUSH HQ UPGRADE FROM SW ─────────────────────────
// When the user switches to a YouTube tab, the SW (running outside the throttled
// page context) immediately checks if there are cached HQ formats for the
// current video and sends an upgrade trigger to inject.js via the bridge.
// This is more reliable than relying on page timers (which Chrome may freeze
// for background tabs), ensuring the upgrade fires the instant the tab is focused.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !tab.url.includes('youtube.com/watch')) return;

    const url = new URL(tab.url);
    const videoId = url.searchParams.get('v');
    if (!videoId) return;

    const stored = await chrome.storage.session.get(`hq_${videoId}`);
    const entry = stored[`hq_${videoId}`];
    const TTL = 3600 * 1000; // 1 hour
    if (!entry || !entry.formats?.length || (Date.now() - entry.ts) > TTL) return;

    console.log(TAG, `[TabActivated] YouTube tab focused for ${videoId}, pushing HQ upgrade trigger`);
    chrome.tabs.sendMessage(tabId, {
      type: 'YTSS_TRIGGER_UPGRADE',
      videoId,
    }).catch(() => {}); // Tab may not have content script ready — ignore errors
  } catch (e) {
    // Tab may have been closed or navigated away — ignore
  }
});

// Also run on every SW wake-up. Session rules and the keepalive alarm are both
// idempotent (rules are replaced by ID, the alarm is keyed by name), so re-running
// here restores state after Chrome evicts the worker without waiting for a
// re-install or browser restart.
setupStaticRules();
chrome.alarms.create('ytss-keepalive', { periodInMinutes: 1 / 3 });
