// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Main World Script                             ║
// ║  Pre-warm Cache + ITAG Disguise + Force Player Reload            ║
// ╚══════════════════════════════════════════════════════════════════╝
(function () {
  'use strict';

  const TAG = '[YTSS]';
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  const MODES = { AAC: 'aac_only', OPUS_HQ: 'opus_hq', HIGHEST: 'highest' };

  const CLIENT_VERSIONS = {
    'TVHTML5': '7.20240101.01.01',
    'TVHTML5_SIMPLY_EMBEDDED_PLAYER': '2.0',
    'WEB_REMIX': '1.20250720.01.00',
    'ANDROID': '21.04.223',
    'ANDROID_MUSIC': '7.27.52',
    'IOS': '19.45.4',
    'ANDROID_VR': '1.58.1',
  };

  // ─── ITAG DISGUISE TABLE ──────────────────────────────────────────
  // The desktop web player refuses itags that are not in its own format table
  // ("Video unavailable" / silent playback). So each premium itag is presented to
  // the player under a codec-compatible itag it does accept, while the `url` still
  // points at the premium stream. The fetch/XHR interceptors then restore the real
  // itag and client on the outgoing videoplayback request.
  const ITAG_DISGUISE = {
    774: { as: 251, mimeType: 'audio/webm; codecs="opus"' },        // Opus 256-300kbps → Opus 160kbps slot
    141: { as: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' },    // AAC 256kbps → AAC 128kbps slot
  };
  const HQ_ITAGS = Object.keys(ITAG_DISGUISE).map(Number);

  // ─── SETTINGS ────────────────────────────────────────────────────
  let S = {
    enabled: true,
    hqFetch: true,
    forceOverride: true,
    audioMode: MODES.HIGHEST,
    autoReload: true,
    preferredClient: 'AUTO'
  };

  // Keys that may live in `S`. Earlier builds pushed the whole extension storage
  // area into this world, which meant the TV OAuth token (access_token +
  // refresh_token) ended up in `S` and persisted to youtube.com localStorage where
  // any page script could read it. Filtering on both read and write also scrubs
  // tokens that older builds already wrote.
  const SETTING_KEYS = Object.keys(S);

  function pickSettings(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const key of SETTING_KEYS) {
      if (obj[key] !== undefined) out[key] = obj[key];
    }
    return out;
  }

  function persistSettings() {
    try { localStorage.setItem('ytss_settings', JSON.stringify(S)); } catch (e) {}
  }

  try {
    const stored = localStorage.getItem('ytss_settings');
    if (stored) {
      const parsed = JSON.parse(stored);
      Object.assign(S, pickSettings(parsed));
      // Rewrite immediately if the stored blob carried anything it shouldn't.
      if (Object.keys(parsed).some(k => !SETTING_KEYS.includes(k))) {
        persistSettings();
        try { localStorage.removeItem('ytSpoofingStream_settings'); } catch (e) {}
        console.warn(TAG, 'Purged non-settings keys from stored config.');
      }
    }
  } catch (e) {}

  window.addEventListener('message', (e) => {
    // Only trust messages this page posted to itself — otherwise any embedded
    // iframe on the page could push arbitrary settings into the extension.
    if (e.source !== window) return;
    if ((e.data?.type === 'YTSS_SETTINGS_UPDATE' || e.data?.type === 'YTSpoofingStream_settingsUpdate') && e.data.settings) {
      Object.assign(S, pickSettings(e.data.settings));
      persistSettings();
    }
  });

  // ── DISABLE SERVICE WORKER ──────────────────────────────────────────
  // YouTube uses a Service Worker (sw.js) to intercept network requests.
  // If active, it handles videoplayback requests in a separate thread,
  // bypassing our window.fetch and XHR hooks. We must disable it!
  // Gated on S.enabled: with the extension switched off there is nothing to
  // intercept, and breaking YouTube's own Service Worker anyway would degrade
  // the site for no reason.
  if (navigator.serviceWorker && S.enabled) {
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
      for (let registration of registrations) {
        registration.unregister().then(success => {
          if (success) console.log(TAG, 'Unregistered existing Service Worker');
        });
      }
    }).catch(e => {});

    Object.defineProperty(navigator.serviceWorker, 'register', {
      value: function() {
        console.log(TAG, "Service Worker registration blocked by YTSpoofingStream.");
        return Promise.reject(new Error("Service Worker disabled to force fetch intercept."));
      },
      configurable: true,
      writable: true
    });
  }

  // ─── STATUS ──────────────────────────────────────────────────────
  const status = {
    injectedStreams: 0,
    bestAudioInfo: '—',
    activeMethod: '—',
    activeAudioItag: '—',
    lastError: null,
    activeMode: S.audioMode,
    clientStats: {},
    prewarmStatus: '—',
  };

  function report() {
    status.activeMode = S.audioMode;
    try { localStorage.setItem('ytSpoofingStream_status', JSON.stringify(status)); } catch (e) {}
  }

  // ─── HQ FORMAT CACHE (per videoId, 25s TTL) ─────────────────────
  // Cache HQ formats so they can be merged SYNCHRONOUSLY when player initializes.
  // TTL prevents serving stale/expired stream URLs to the player.
  const HQ_CACHE_TTL_MS = 3600000; // 1 hour
  const hqCache = new Map();        // videoId → { formats, ts }
  const pendingFetches = new Map(); // videoId → Promise<hqFormats[]>
  const VIDEO_ID_RE = /^[\w-]{11}$/;
  const failedFetches = new Map();  // videoId → ts of the last empty result (backoff)
  const FAILED_RETRY_MS = 20000;    // don't re-run the fan-out for a failing video more often than this
  const reloadedVideos = new Set(); // guard: only force-reload once per videoId
  const pendingReloads = new Set(); // guard: only one reload retry loop per videoId
  let isInitialPageLoad = true;     // guard: only allow page reload on very first visit
  const isMusicSite = location.hostname === 'music.youtube.com'; // YouTube Music needs special handling

  function cacheGet(videoId) {
    // 1. Check memory map first
    const entry = hqCache.get(videoId);
    if (entry && (Date.now() - entry.ts <= HQ_CACHE_TTL_MS)) {
      status.clientStats = { CACHE: 'Loaded from Session Cache (Instant)' };
      report();
      return entry.formats;
    }
    // 2. Check sync sessionStorage (handles F5 reloads flawlessly)
    try {
      const stored = window.sessionStorage.getItem('ytss_hq_' + videoId);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Date.now() - parsed.ts <= HQ_CACHE_TTL_MS) {
          hqCache.set(videoId, parsed); // restore to mem
          status.clientStats = { CACHE: 'Loaded from Session Cache (Instant)' };
          report();
          return parsed.formats;
        } else {
          window.sessionStorage.removeItem('ytss_hq_' + videoId);
        }
      }
    } catch (e) {}
    
    hqCache.delete(videoId);
    return null;
  }

  function cacheSet(videoId, formats) {
    const entry = { formats, ts: Date.now() };
    hqCache.set(videoId, entry);
    try {
      window.sessionStorage.setItem('ytss_hq_' + videoId, JSON.stringify(entry));
    } catch (e) {}
  }

  // ─── SERVICE WORKER BRIDGE ────────────────────────────────────────
  function fetchHQViaSW(videoId) {
    return new Promise((resolve) => {
      const requestId = 'req_' + Math.random().toString(36).substr(2, 9);

      function onMessage(e) {
        if (e.data?.type === 'YTSS_HQ_RESULT' && e.data.requestId === requestId) {
          window.removeEventListener('message', onMessage);
          resolve(e.data.results || []);
        }
      }
      window.addEventListener('message', onMessage);

      window.postMessage({ type: 'YTSS_FETCH_HQ', videoId, requestId, context: collectPageContext() }, '*');

      // 12s timeout: SW may need to restart after being killed by Chrome (~30s idle).
      // During restart, sendMessage fails once, bridge retries after 500ms, then
      // all 6 API calls run in parallel (~3-5s). 12s gives comfortable headroom.
      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve([]);
      }, 12000);
    });
  }

  async function fetchAllHQAudio(videoId) {
    // Reject anything that isn't a real 11-char YouTube ID. Player-URL parsing
    // occasionally yields fragments like "ux", and each one burned a full 7-client
    // fan-out that could never succeed.
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return [];
    // Dedup: if already fetching same videoId, wait for existing promise
    if (pendingFetches.has(videoId)) return await pendingFetches.get(videoId);
    // Cache hit (not expired) — ONLY return cache if it has actual formats.
    // An empty cache entry means a previous fetch failed; we must retry.
    const cached = cacheGet(videoId);
    if (cached?.length > 0) return cached;

    // Empty results are deliberately never cached, so without a cooldown every
    // caller that asks again immediately re-runs the whole fan-out. Back off
    // instead: a video that genuinely has no HQ formats, or a worker that is
    // failing right now, gets retried at most once per FAILED_RETRY_MS.
    const failedAt = failedFetches.get(videoId);
    if (failedAt && Date.now() - failedAt < FAILED_RETRY_MS) return [];

    console.log(TAG, `[HQ] Fetching for ${videoId}...`);
    status.clientStats = {}; // Clear stale stats before fetching
    report();
    const fetchPromise = fetchHQViaSW(videoId).then(results => {
      const merged = [];
      const seen = new Set();

      for (const clientRes of results) {
        if (clientRes.error) {
          status.clientStats[clientRes.source] = clientRes.error;
        } else if (clientRes.audioFormats?.length > 0) {
          const audio = clientRes.audioFormats;
          const itags = audio.map(f => f.itag);
          const has774 = itags.includes(774);
          const has141 = itags.includes(141);
          const star = has774 ? '★774' : (has141 ? '★141' : '');
          status.clientStats[clientRes.source] = `${audio.length}str ${itags.slice(0, 6).join('/')}${star ? ' ' + star : ''}`;

          for (const fmt of audio) {
            if (!seen.has(fmt.itag)) {
              seen.add(fmt.itag);
              merged.push(fmt);
            }
          }
        } else {
          status.clientStats[clientRes.source] = 'No Audio';
        }
      }

      hqCache.delete(videoId);
      // Only cache if we actually got formats back.
      // Caching an empty result would permanently block re-fetching for this videoId.
      if (merged.length > 0) {
        cacheSet(videoId, merged);
        failedFetches.delete(videoId);
      } else {
        failedFetches.set(videoId, Date.now());
      }
      pendingFetches.delete(videoId);
      report();
      return merged;
    });

    pendingFetches.set(videoId, fetchPromise);
    return await fetchPromise;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 0] SESSION CACHE LOADER (Removed, now native sync via sessionStorage)

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 1] PRE-WARM CACHE
  // Start fetching HQ formats immediately from URL videoId, BEFORE player initializes.
  // When ytInitialPlayerResponse fires, cache should already be ready → sync merge.
  // ═══════════════════════════════════════════════════════════════════
  function getVideoIdFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get('v') || null;
    } catch (e) { return null; }
  }

  // The videoId the SPA is currently heading for. During a playlist advance the
  // three sources of truth update at different times — yt-navigate-start fires
  // first, then location.search, then #movie_player — so neither the URL nor the
  // player element on its own can answer "does this pending upgrade still belong
  // to the track the user is about to hear?".
  let navTargetVideoId = getVideoIdFromUrl();

  function isCurrentTarget(videoId) {
    return !!videoId && (videoId === navTargetVideoId || videoId === getVideoIdFromUrl());
  }

  function prewarmCache(videoId) {
    if (!videoId || !VIDEO_ID_RE.test(videoId) || !S.enabled || !S.hqFetch) return;
    navTargetVideoId = videoId;
    reloadedVideos.delete(videoId);
    // An in-flight fetch for this videoId is exactly what the dedup map is for, so
    // join it rather than clearing it. Clearing it here (as this used to) let every
    // re-entry kick off another 7-client fan-out: one video whose fetch came back
    // empty would re-trigger prewarm, which cancelled the dedup, which re-fetched,
    // and the resulting storm is what eventually starved the worker into returning
    // nothing for everything until a hard refresh.
    if (pendingFetches.has(videoId)) return;
    status.prewarmStatus = `pre-fetching ${videoId}…`;
    report();
    fetchAllHQAudio(videoId).then(formats => {
      status.prewarmStatus = formats.length > 0
        ? `ready: ${formats.length} formats`
        : 'no HQ formats';
      report();
      console.log(TAG, `[Pre-warm] ${status.prewarmStatus} for ${videoId}`);
      if (formats.length > 0 && S.autoReload) {
        forcePlayerReload(videoId, formats);
      }
    });
  }

  // Pre-warm on initial page load
  const earlyVideoId = getVideoIdFromUrl();
  if (earlyVideoId) {
    prewarmCache(earlyVideoId);
  }

  // Also pre-warm on YouTube SPA navigation (yt-navigate-start fires before new page renders)
  window.addEventListener('yt-navigate-start', (e) => {
    isInitialPageLoad = false; // We are now in SPA territory, never reload page
    // Try to get the incoming videoId from the event detail first,
    // then fall back to parsing the URL (which may not have updated yet)
    const incomingVid = e?.detail?.endpoint?.watchEndpoint?.videoId
                     || e?.detail?.params?.videoId
                     || null;
    if (incomingVid) {
      prewarmCache(incomingVid);
    } else {
      // Fallback: schedule after a tick so the URL has time to update
      setTimeout(() => {
        const vid = getVideoIdFromUrl();
        if (vid) prewarmCache(vid);
      }, 0);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // HQ FILTER & MERGE ENGINE
  // ═══════════════════════════════════════════════════════════════════
  function processPlayerResponse(json, hqFormats = null) {
    if (!json?.streamingData?.adaptiveFormats) return json;

    if (!json._origFormats) {
      json._origFormats = JSON.parse(JSON.stringify(json.streamingData.adaptiveFormats));
    }

    const videoFormats = json._origFormats.filter(f => !(f.mimeType || '').includes('audio/'));
    const origAudio   = json._origFormats.filter(f => (f.mimeType || '').includes('audio/'));

    const seen = new Set();
    const pool = [];

    // Filter HQ formats by preferred client if specified
    let filteredHq = hqFormats || [];
    if (S.preferredClient && S.preferredClient !== 'AUTO') {
      filteredHq = filteredHq.filter(f => f._src === S.preferredClient);
    }

    // HQ from SW first (priority)
    if (filteredHq.length > 0) {
      for (const f of filteredHq) {
        // Allow both direct URLs and signatureCipher formats. The web player's
        // base.js will automatically decipher signatureCipher formats just like
        // it does for originalFormats.
        if (!f.url && !f.signatureCipher) continue;
        if (!seen.has(f.itag)) { seen.add(f.itag); pool.push(f); }
      }
    }

    // Original streams
    for (const f of origAudio) {
      if (!seen.has(f.itag)) { seen.add(f.itag); pool.push({ ...f, _src: 'original' }); }
    }

    // Remove itag 140 (low-quality AAC fallback) if we have something better
    let filteredPool = pool.filter(f => f.itag !== 140);
    if (filteredPool.length === 0) filteredPool = pool;

    const mode = S.audioMode || MODES.HIGHEST;
    let selectedAudio = [];

    // Highest-bitrate-first ordering helper.
    const byBitrate = (list) => list.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const pick = (list) => (S.forceOverride ? [list[0]] : list);

    if (mode === MODES.AAC) {
      const aac = byBitrate(filteredPool.filter(f => (f.mimeType || '').includes('mp4a')));
      const target = aac.find(f => f.itag === 141);
      if (target) {
        selectedAudio = [target];
        console.log(TAG, `★ ITAG 141 (AAC 256kbps) [${target._src}]`);
      } else if (aac.length) {
        selectedAudio = pick(aac);
        console.log(TAG, `AAC -> ITAG ${aac[0].itag} (${Math.round((aac[0].bitrate || 0) / 1000)}k) [${aac[0]._src}]`);
      } else {
        selectedAudio = filteredPool;
      }
    } else if (mode === MODES.OPUS_HQ) {
      const opus = byBitrate(filteredPool.filter(f => (f.mimeType || '').includes('opus')));
      const target = opus.find(f => f.itag === 774);
      if (target) {
        selectedAudio = [target];
        console.log(TAG, `★ ITAG 774 (Opus 256kbps+) [${target._src}]`);
      } else if (opus.length) {
        selectedAudio = pick(opus);
        console.log(TAG, `Opus -> ITAG ${opus[0].itag} (${Math.round((opus[0].bitrate || 0) / 1000)}k) [${opus[0]._src}]`);
      } else {
        selectedAudio = filteredPool;
      }
    } else {
      // HIGHEST: itag 774 is the stated top target, so prefer it outright when present.
      // Otherwise fall back to plain highest bitrate. itag 141 is a legitimate
      // candidate here because ITAG_DISGUISE presents it to the player as 140,
      // which the desktop player does accept.
      const target774 = filteredPool.find(f => f.itag === 774);
      if (target774) {
        selectedAudio = [target774];
        console.log(TAG, `★ ITAG 774 (Opus 256kbps+) [${target774._src}]`);
      } else {
        const ranked = byBitrate(filteredPool);
        selectedAudio = ranked.length ? pick(ranked) : [];
        if (ranked.length) {
          console.log(TAG, `Highest -> ITAG ${ranked[0].itag} (${Math.round((ranked[0].bitrate || 0) / 1000)}k) [${ranked[0]._src}]`);
        }
      }
    }

    selectedAudio = selectedAudio.filter(Boolean);

    // ── Strategy: ITAG disguise + URL-swap ──────────────────────────────
    // Present each premium stream under an itag the web player accepts (see
    // ITAG_DISGUISE) while keeping the premium `url`. Strip &sabr=1 so the server
    // does not activate the SABR/UMP POST pathway for this stream, and tag the URL
    // with _ytss_* so the fetch/XHR interceptors can restore the real client and
    // itag on the outgoing videoplayback request.
    selectedAudio = selectedAudio.map(f => {
      const origItag = f._origItag || f.itag;
      const disguise = ITAG_DISGUISE[origItag];
      // Preserve the absence of a url — overwriting it with '' would turn a
      // signatureCipher-only format into a broken one.
      const hasUrl = typeof f.url === 'string' && f.url.length > 0;
      let streamUrl = hasUrl ? f.url.replace(/&sabr=1/g, '') : f.url;

      if (!disguise) return { ...f, _origItag: origItag, ...(hasUrl ? { url: streamUrl } : {}) };

      if (hasUrl) {
        try {
          const urlObj = new URL(streamUrl);
          // Only stamp a real spoofed client. '_src' is 'original' for page-native
          // formats, and echoing that back produced `c=original` on the outgoing
          // videoplayback request — an invalid client paired with a stale cver.
          if (f._src && f._src !== 'original') {
            urlObj.searchParams.set('_ytss_client', f._src);
          }
          urlObj.searchParams.set('_ytss_orig_itag', String(origItag));
          streamUrl = urlObj.toString();
        } catch (e) {}
      }

      return {
        ...f,
        itag: disguise.as,
        mimeType: disguise.mimeType,
        ...(hasUrl ? { url: streamUrl } : {}),
        _origItag: origItag,
        _src: f._src || 'hq',
      };
    });

    // Disguising can collide with an original stream that already uses the target
    // itag (e.g. 774→251 alongside the real 251, which happens whenever
    // forceOverride is off). Two entries with the same itag confuse the player, so
    // keep one per itag and prefer the premium stream.
    const byItag = new Map();
    for (const f of selectedAudio) {
      const existing = byItag.get(f.itag);
      if (!existing) { byItag.set(f.itag, f); continue; }
      const incomingIsHQ = HQ_ITAGS.includes(f._origItag);
      const existingIsHQ = HQ_ITAGS.includes(existing._origItag);
      if (incomingIsHQ && !existingIsHQ) byItag.set(f.itag, f);
    }
    selectedAudio = [...byItag.values()];

    json.streamingData.adaptiveFormats = [...videoFormats, ...selectedAudio];

    // CRITICAL: Delete DASH and HLS manifest URLs.
    // If present, the player will fetch the XML manifest and ignore our modified adaptiveFormats!
    delete json.streamingData.dashManifestUrl;
    delete json.streamingData.hlsManifestUrl;

    // CRITICAL 2: Nuclear option to completely disable SABR (Server ABR / UMP).
    // SABR ignores our `url` property and constructs POST requests from scratch.
    // By deeply deleting all SABR configurations, we force standard HTTP GET requests.
    function deepDeleteSABR(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) deepDeleteSABR(obj[i]);
      } else {
        for (const key in obj) {
          const lowerKey = key.toLowerCase();
          if (lowerKey.includes('sabr') || lowerKey.includes('serverabr') || lowerKey === 'mediaumpconfig') {
            delete obj[key];
          } else {
            deepDeleteSABR(obj[key]);
          }
        }
      }
    }
    deepDeleteSABR(json);

    const active = selectedAudio[0];
    if (active) {
      const codec  = (active.mimeType || '').includes('opus') ? 'Opus' : 'AAC';
      const kbps   = Math.round((active.bitrate || 0) / 1000);

      const displayItag = active._origItag || active.itag;
      const isHQ   = HQ_ITAGS.includes(displayItag) ? ' [HQ ★]' : '';
      const src    = active._src || 'original';

      status.activeMethod    = src;
      status.activeAudioItag = displayItag;
      status.bestAudioInfo   = `ITAG ${displayItag}${isHQ} | ${codec} ${kbps}kbps | Method: ${src}`;
      status.injectedStreams  = pool.length;
      report();
    }

    return json;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 2] ytInitialPlayerResponse HOOK
  // Runs synchronously when YouTube sets this global.
  // If pre-warm cache already done → merge sync. Otherwise async merge + player reload.
  // ═══════════════════════════════════════════════════════════════════
  let initialResponseValue = window.ytInitialPlayerResponse;

  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    get() { return initialResponseValue; },
    set(val) {
      if (!S.enabled || !val) { initialResponseValue = val; return; }

      const videoId = val.videoDetails?.videoId;
      console.log(TAG, `[ytInitialPlayerResponse] videoId=${videoId}`);

      // Check cache first → sync merge (best case: pre-warm finished in time)
      const cached = videoId ? cacheGet(videoId) : null;
      if (cached?.length > 0) {
        console.log(TAG, `[ytInitialPlayerResponse] Cache HIT → sync merge ${cached.length} formats`);
        initialResponseValue = processPlayerResponse(val, cached);
        // The player is initialising straight onto the HQ formats, so there is
        // nothing to upgrade. Claim the guard so a later visibilitychange or SW
        // tab-activation trigger doesn't reload an already-HQ stream and cost a
        // re-buffer for no gain.
        reloadedVideos.add(videoId);
      } else {
        // No cache yet → sync process with original only, then async merge + player reload
        initialResponseValue = processPlayerResponse(val, null);

        if (S.hqFetch && videoId) {
          fetchAllHQAudio(videoId).then(hqFormats => {
            if (hqFormats.length > 0) {
              console.log(TAG, `[ytInitialPlayerResponse] Async merge ${hqFormats.length} formats → forcing player reload`);
              processPlayerResponse(initialResponseValue, hqFormats);

              // [APPROACH 4] Force player re-init ONCE per videoId
              // NOTE: Do NOT delete cache here — the player's re-fetch needs the
              // cached HQ formats to merge synchronously (avoids second SW round-trip).
              // forcePlayerReload owns the reloadedVideos guard.
              forcePlayerReload(videoId, hqFormats);
            }
          });
        }
      }
    },
    configurable: true,
    enumerable: true,
  });

  // ═══════════════════════════════════════════════════════════════════
  // PAGE CONTEXT → SERVICE WORKER
  // InnerTube drops the premium formats when a spoofed client sends no visitorData
  // matching the real session. Read those identifiers straight out of the page's own
  // ytcfg and relay them to the SW (via bridge.js) so its spoofed requests carry the
  // same session identity as the page.
  // ═══════════════════════════════════════════════════════════════════
  let lastPageContextSent = '';

  // Read the page's current session identity. Kept separate from reportPageContext
  // so it can also ride along on every HQ request — the worker gets evicted after
  // ~30s idle, and a fingerprint-deduped one-shot push has no way to notice that
  // the receiver has forgotten what it was told.
  function collectPageContext() {
    try {
      const cfg = window.ytcfg;
      if (!cfg || typeof cfg.get !== 'function') return null;

      const innertube = cfg.get('INNERTUBE_CONTEXT');
      const context = {
        visitorData: cfg.get('VISITOR_DATA') || innertube?.client?.visitorData || null,
        sessionIndex: cfg.get('SESSION_INDEX') ?? null,
        delegatedSessionId: cfg.get('DELEGATED_SESSION_ID') || null,
        sts: cfg.get('STS') || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.sts) || null,
        poToken: cfg.get('POTOKEN') || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.raw_player_response && window.ytplayer.config.args.raw_player_response.serviceTrackingParams && window.ytplayer.config.args.raw_player_response.serviceTrackingParams.find(x => x.service === 'CSI')?.params?.find(x => x.key === 'potoken')?.value) || null,
      };
      return context.visitorData ? context : null;
    } catch (e) { return null; }
  }

  function reportPageContext() {
    try {
      const context = collectPageContext();
      if (!context) return;

      // Only post when something actually changed (ytcfg.set is called repeatedly).
      const fingerprint = JSON.stringify(context);
      if (fingerprint === lastPageContextSent) return;
      lastPageContextSent = fingerprint;

      window.postMessage({ type: 'YTSS_PAGE_CONTEXT', context }, '*');
      console.log(TAG, `[PageContext] Sent visitorData + authUser=${context.sessionIndex ?? '0'} to SW`);
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 2.5] YTCFG EXPERIMENT FLAGS HOOK
  // Force disable SABR globally via YouTube's experiment flags
  // ═══════════════════════════════════════════════════════════════════
  let _ytcfg = window.ytcfg;
  Object.defineProperty(window, 'ytcfg', {
    get() { return _ytcfg; },
    set(val) {
      if (val && typeof val.set === 'function' && !val._ytssHooked) {
        const origSet = val.set;
        val.set = function(...args) {
          try {
            let obj = args[0];
            if (typeof args[0] === 'string' && args.length > 1) {
              obj = { [args[0]]: args[1] };
            }
            if (obj && obj.EXPERIMENT_FLAGS) {
              for (const key in obj.EXPERIMENT_FLAGS) {
                const lowerKey = key.toLowerCase();
                if (lowerKey.includes('sabr')) {
                  obj.EXPERIMENT_FLAGS[key] = false;
                }
              }
              obj.EXPERIMENT_FLAGS.html5_disable_sabr = true;
              obj.EXPERIMENT_FLAGS.html5_enable_sabr = false;
              obj.EXPERIMENT_FLAGS.sabr_force_ump = false;
            }
          } catch (e) { }
          const result = origSet.apply(this, args);
          // Session identifiers land here during page boot and again on SPA nav.
          reportPageContext();
          return result;
        };
        val._ytssHooked = true;
      }
      _ytcfg = val;
    }
  });

  // ytcfg may already be populated before our hook installs (or be set via a path
  // that bypasses .set), so also sample it once the document is ready.
  document.addEventListener('DOMContentLoaded', reportPageContext);
  window.addEventListener('yt-navigate-finish', reportPageContext);

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 3] ytplayer.config HOOK
  // YouTube sets window.ytplayer.config BEFORE creating the player object.
  // Intercept it to modify player_response / raw_player_response inline.
  // ═══════════════════════════════════════════════════════════════════
  let _ytplayerConfigValue = window.ytplayer?.config || null;

  function patchYtplayerConfig(cfg) {
    if (!cfg || !S.enabled) return cfg;
    try {
      const args = cfg.args;
      if (!args) return cfg;

      // raw_player_response (newer YouTube)
      if (args.raw_player_response?.streamingData) {
        const videoId = args.raw_player_response.videoDetails?.videoId;
        const cached  = videoId ? cacheGet(videoId) : null;
        console.log(TAG, `[ytplayer.config] raw_player_response sync patch (cached: ${!!cached})`);
        args.raw_player_response = processPlayerResponse(args.raw_player_response, cached);
      }

      // player_response (older / fallback, JSON string)
      if (typeof args.player_response === 'string') {
        try {
          const pr = JSON.parse(args.player_response);
          if (pr.streamingData) {
            const videoId = pr.videoDetails?.videoId;
            const cached  = videoId ? cacheGet(videoId) : null;
            console.log(TAG, `[ytplayer.config] player_response sync patch (cached: ${!!cached})`);
            args.player_response = JSON.stringify(processPlayerResponse(pr, cached));
          }
        } catch (e) {}
      }
    } catch (e) {
      console.warn(TAG, '[ytplayer.config] patch error:', e);
    }
    return cfg;
  }

  // Hook window.ytplayer
  let _ytplayerValue = window.ytplayer || null;
  Object.defineProperty(window, 'ytplayer', {
    get() { return _ytplayerValue; },
    set(val) {
      _ytplayerValue = val;
      if (val?.config) {
        val.config = patchYtplayerConfig(val.config);
      }
      // Hook config property too
      if (val && typeof val === 'object') {
        let _cfgVal = val.config;
        Object.defineProperty(val, 'config', {
          get() { return _cfgVal; },
          set(cfg) { _cfgVal = patchYtplayerConfig(cfg); },
          configurable: true,
        });
      }
    },
    configurable: true,
  });

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 4] FORCE PLAYER RELOAD
  // After async HQ inject, tell the YouTube player to reload the video
  // so it picks up the new (better) format list.
  //
  // Owns the `reloadedVideos` guard: it is claimed only when loadVideoById is
  // actually issued, and released again on every give-up path. Callers must NOT
  // pre-add to the set — doing so used to burn the guard whenever this function
  // bailed out, leaving the video stuck on low quality with no retry path except
  // the user manually focusing the tab.
  // ═══════════════════════════════════════════════════════════════════
  function forcePlayerReload(videoId, hqFormats) {
    if (!hqFormats || hqFormats.length === 0) return;

    if (isMusicSite) {
      console.log(TAG, `[PlayerReload] music.youtube.com detected. Skipping player reload.`);
      return;
    }

    if (reloadedVideos.has(videoId)) return;
    // Both the ytInitialPlayerResponse merge and the fetch/XHR interceptors can land
    // on the same video, and neither claims reloadedVideos until it actually reloads.
    // Without this, each would spin up its own retry loop and the player would get
    // reloaded twice.
    if (pendingReloads.has(videoId)) return;
    pendingReloads.add(videoId);

    console.log(TAG, `[PlayerReload] Attempting player-level reload for ${videoId} (initialLoad=${isInitialPageLoad})`);

    let attempts = 0;
    // ~5s of retries. On SPA navigation the HQ fetch for the incoming video often
    // completes before #movie_player has switched over to it, so we have to wait
    // the player out rather than give up on the first mismatch.
    const MAX_ATTEMPTS = 25;

    const release = (why) => {
      // Let visibilitychange / the SW tab-activation trigger / the player's next
      // /youtubei/v1/player request try the upgrade again later.
      reloadedVideos.delete(videoId);
      pendingReloads.delete(videoId);
      console.warn(TAG, `[PlayerReload] ${why} — releasing guard for ${videoId}`);
    };

    const tryReload = () => {
      attempts++;
      // A sync merge on the player's own request may have delivered the HQ formats
      // while we were waiting, in which case reloading would only cost a re-buffer.
      if (reloadedVideos.has(videoId)) {
        pendingReloads.delete(videoId);
        return;
      }
      const playerEl = document.getElementById('movie_player')
                    || document.querySelector('ytd-player #movie_player')
                    || document.querySelector('.html5-video-player');

      if (playerEl && typeof playerEl.loadVideoById === 'function') {
        const currentVideoId = playerEl.getVideoData?.()?.video_id
                            || new URLSearchParams(playerEl.getVideoUrl?.() || '').get('v')
                            || null;

        // Anti-hijack guard. Two very different situations produce a mismatch:
        //   - we are still heading for `videoId` → the SPA navigation is mid-flight
        //     and #movie_player has not caught up yet, so wait for it. During a
        //     playlist advance neither location.search nor the player has switched
        //     over when the HQ fetch lands, which is why this checks the nav target
        //     rather than the URL alone.
        //   - we are heading somewhere else → the user genuinely moved on, and
        //     reloading would hijack whatever they are watching now.
        if (currentVideoId && currentVideoId !== videoId) {
          if (isCurrentTarget(videoId) && attempts < MAX_ATTEMPTS) {
            setTimeout(tryReload, 200);
            return;
          }
          release(`player is on ${currentVideoId}, not ${videoId}`);
          return;
        }

        const currentTime = playerEl.getCurrentTime?.() || 0;
        // Claim the guard only now that we are actually going to reload.
        reloadedVideos.add(videoId);
        pendingReloads.delete(videoId);
        try {
          // stopVideo() resets player state so loadVideoById is treated as a fresh
          // load even for the same videoId — without it the player short-circuits
          // and keeps the low-quality stream. This is why a background tab used to
          // never upgrade: it costs a brief re-buffer at the same position, which
          // beats listening to the low-quality stream for the rest of the track.
          if (typeof playerEl.stopVideo === 'function') playerEl.stopVideo();
          playerEl.loadVideoById({ videoId, startSeconds: currentTime });
          console.log(TAG, `[PlayerReload] loadVideoById called at t=${currentTime} (hidden=${document.hidden})`);
        } catch (e) {
          console.warn(TAG, '[PlayerReload] loadVideoById failed:', e);
          reloadedVideos.delete(videoId);
          pendingReloads.delete(videoId);
          if (isInitialPageLoad) window.location.reload();
        }
      } else if (attempts < MAX_ATTEMPTS) {
        setTimeout(tryReload, 200);
      } else {
        if (isInitialPageLoad) {
          console.warn(TAG, '[PlayerReload] Player not found, doing page reload (initial load only)');
          pendingReloads.delete(videoId);
          window.location.reload();
        } else {
          release('player not found on SPA');
        }
      }
    };

    setTimeout(tryReload, isInitialPageLoad ? 300 : 100);
  }


  // ─── SW-TRIGGERED UPGRADE ─────────────────────────────────────────
  // When user clicks back to the YouTube tab, background.js fires
  // chrome.tabs.onActivated → bridge.js relays as YTSS_TRIGGER_UPGRADE.
  // This complements visibilitychange with a SW-side trigger that isn't
  // subject to Chrome's background tab JS timer throttling/freezing.
  function tryUpgradeVideo(videoId, source) {
    if (!videoId || !S.enabled || isMusicSite) return;
    const cached = cacheGet(videoId);
    if (!cached?.length) {
      prewarmCache(videoId);
      return;
    }
    if (reloadedVideos.has(videoId)) return;

    const playerEl = document.getElementById('movie_player')
                  || document.querySelector('.html5-video-player');
    if (!playerEl || typeof playerEl.loadVideoById !== 'function') return;

    const currentVideoId = playerEl.getVideoData?.()?.video_id
                        || new URLSearchParams(playerEl.getVideoUrl?.() || '').get('v');
    if (currentVideoId !== videoId) return;

    reloadedVideos.add(videoId);
    const currentTime = playerEl.getCurrentTime?.() || 0;
    console.log(TAG, `[${source}] Upgrading ${videoId} to HQ at t=${currentTime}`);
    try {
      if (typeof playerEl.stopVideo === 'function') playerEl.stopVideo();
      playerEl.loadVideoById({ videoId, startSeconds: currentTime });
    } catch (e) {
      // Release the guard so a later trigger can retry this upgrade.
      reloadedVideos.delete(videoId);
      console.warn(TAG, `[${source}] loadVideoById failed:`, e);
    }
  }

  // Reuse tryUpgradeVideo for visibilitychange too
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !S.enabled || isMusicSite) return;
    const videoId = getVideoIdFromUrl();
    if (videoId) tryUpgradeVideo(videoId, 'VisibilityChange');
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'YTSS_TRIGGER_UPGRADE') return;
    const { videoId } = e.data;
    if (videoId) tryUpgradeVideo(videoId, 'SWTrigger');
  });

  // ═══════════════════════════════════════════════════════════════════
  // INTERCEPTORS — fetch & XHR (response-only, no request modification)
  // ═══════════════════════════════════════════════════════════════════
  window.fetch = async function (...args) {
    let url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

    if (url.includes('/youtubei/v1/player') && !url.includes('_ytss=1')) {
      try {
        if (args[1] && args[1].body) {
          const req = JSON.parse(args[1].body);
          const poToken = req.serviceIntegrityDimensions?.poToken;
          const sts = req.playbackContext?.contentPlaybackContext?.signatureTimestamp;
          if (poToken || sts) {
            const context = {
              visitorData: window.ytcfg?.get('VISITOR_DATA') || null,
              sessionIndex: window.ytcfg?.get('SESSION_INDEX') ?? '0',
              delegatedSessionId: window.ytcfg?.get('DELEGATED_SESSION_ID') || null,
              sts: sts || window.ytcfg?.get('STS'),
              poToken: poToken || window.ytcfg?.get('POTOKEN')
            };
            window.postMessage({ type: 'YTSS_PAGE_CONTEXT', context }, '*');
          }
        }
      } catch (e) {}

      const response = await ORIGINAL_FETCH.apply(this, args);
      if (!S.enabled) return response;

      try {
        const clone   = response.clone();
        const json    = await clone.json();
        const videoId = json.videoDetails?.videoId;

        // Check cache first → sync merge (no wait)
        const cached = videoId ? cacheGet(videoId) : null;

        if (cached && cached.length > 0) {
          // Cache HIT: inject HQ immediately, zero latency
          const modified = processPlayerResponse(json, cached);
          // This response *is* the upgrade, so nothing is left to reload.
          reloadedVideos.add(videoId);
          return new Response(JSON.stringify(modified), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        // Cache MISS: Return original response immediately so the player
        // doesn't freeze waiting 3-6s. Then kick off background HQ fetch.
        // On youtube.com: after fetch completes, call forcePlayerReload so the
        // player re-issues /youtubei/v1/player which we intercept with HQ formats.
        // On music.youtube.com: just populate cache silently — never poke the player
        // to avoid interrupting the song queue every second.
        if (S.hqFetch && videoId) {
          fetchAllHQAudio(videoId).then(hqFormats => {
            if (hqFormats.length > 0) {
              if (!isMusicSite) {
                console.log(TAG, `[FetchIntercept] Background HQ fetch done (${hqFormats.length} formats), reloading player...`);
              } else {
                console.log(TAG, `[FetchIntercept] music.youtube.com: HQ cached for ${videoId}, will inject on next player request.`);
              }
              // Owns the reloadedVideos guard and the isMusicSite skip itself.
              forcePlayerReload(videoId, hqFormats);
            }
          }).catch(() => {});
        }

        // Return the original (unmodified) response right away
        return new Response(JSON.stringify(json), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        console.warn(TAG, 'fetch intercept error:', e);
        return response;
      }
    }

    // ── Parameter Rewriting for Injected Streams ──────────────────────────
    // When the player performs a GET to videoplayback, its JS rewriting logic
    // normally overrides `c` to `WEB` and `itag` to `251` (matching metadata).
    // If our ytss parameters are present, we intercept and restore the original
    // client configuration (e.g. c=TVHTML5, itag=774) before the request goes out.
    if (url.includes('googlevideo.com/videoplayback') && !url.includes('_ytss=1')) {
      try {
        const urlObj = new URL(url);
        const ytssClient = urlObj.searchParams.get('_ytss_client');
        const ytssOrigItag = urlObj.searchParams.get('_ytss_orig_itag');
        if (ytssClient) {
          urlObj.searchParams.set('c', ytssClient);
          if (CLIENT_VERSIONS[ytssClient]) {
            urlObj.searchParams.set('cver', CLIENT_VERSIONS[ytssClient]);
          }
          if (ytssOrigItag) {
            urlObj.searchParams.set('itag', ytssOrigItag);
          }
          urlObj.searchParams.delete('_ytss_client');
          urlObj.searchParams.delete('_ytss_orig_itag');
          urlObj.searchParams.set('_ytss', '1');
          const newUrl = urlObj.toString();
          console.log(TAG, `[FetchRedirect] Param rewrite: c=${ytssClient}, itag=${ytssOrigItag}`);
          if (typeof args[0] === 'string') {
            args[0] = newUrl;
          } else if (args[0] && typeof args[0] === 'object') {
            args[0] = new Request(newUrl, args[0]);
          }
          url = newUrl;
        }
      } catch (e) {}
    }

    // NOTE: A SABR/UMP binary body patcher used to live here. It scanned the whole
    // POST body for the byte pair 0xFB 0x01 (varint 251) and rewrote it to
    // 0x86 0x06 (varint 774). Those bytes occur naturally throughout protobuf
    // payloads — any varint field holding 251, byte counts, timestamps — so the
    // blind rewrite corrupted unrelated request data. It was also redundant:
    // deepDeleteSABR() plus removing dashManifestUrl/hlsManifestUrl already forces
    // the player onto plain GETs, which the parameter rewriting above handles.

    // ── Block emergency itag blacklist ───────────────────────────────────
    if (url.includes('streaming_data_emergency_itag_blacklist')) {
      console.log(TAG, '[BlacklistBlock] Blocked emergency itag blacklist');
      return Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    return ORIGINAL_FETCH.apply(this, args);
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
      try {
        const urlObj = new URL(url);

        // FetchRedirect GET param rewrite
        if (!url.includes('_ytss=1')) {
          const ytssClient = urlObj.searchParams.get('_ytss_client');
          const ytssOrigItag = urlObj.searchParams.get('_ytss_orig_itag');
          if (ytssClient) {
            urlObj.searchParams.set('c', ytssClient);
            if (CLIENT_VERSIONS[ytssClient]) {
              urlObj.searchParams.set('cver', CLIENT_VERSIONS[ytssClient]);
            }
            if (ytssOrigItag) {
              urlObj.searchParams.set('itag', ytssOrigItag);
            }
            urlObj.searchParams.delete('_ytss_client');
            urlObj.searchParams.delete('_ytss_orig_itag');
            url = urlObj.toString();
            console.log(TAG, `[XHRRedirect] Param rewrite: c=${ytssClient}, itag=${ytssOrigItag}`);
          }
        }
      } catch (e) {}
    }
    this._ytssUrl = url;
    return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._ytssUrl;

    // NOTE: the SABR/UMP binary body patcher that used to run here was removed for
    // the same reason as the fetch-side one — see the comment in window.fetch.

    if (url && typeof url === 'string' && url.includes('/youtubei/v1/player') && !url.includes('_ytss=1')) {
      const self = this;
      const origHandler = this.onreadystatechange;

      this.onreadystatechange = function () {
        if (self.readyState === 4 && self.status === 200 && S.enabled) {
          try {
            const json    = JSON.parse(self.responseText);
            const videoId = json.videoDetails?.videoId;
            const cached  = videoId ? cacheGet(videoId) : null;

            if (cached && cached.length > 0) {
              const modified = processPlayerResponse(json, cached);
              Object.defineProperty(self, 'responseText', { value: JSON.stringify(modified), configurable: true });
              Object.defineProperty(self, 'response',     { value: JSON.stringify(modified), configurable: true });
              // This response *is* the upgrade, so nothing is left to reload.
              reloadedVideos.add(videoId);
            } else if (S.hqFetch && videoId) {
              // Cache miss: fetch in background and reload once ready.
              // forcePlayerReload owns the reloadedVideos guard and the music skip.
              fetchAllHQAudio(videoId).then(hqFormats => {
                if (hqFormats.length > 0) {
                  forcePlayerReload(videoId, hqFormats);
                }
              });
            }
          } catch (e) {}
        }
        if (origHandler) origHandler.apply(self, arguments);
      };
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  // ─── EXPOSE API TO POPUP ──────────────────────────────────────────
  window.YTSS_SpoofingMethods = {
    getStatus: () => ({ ...status, settings: { ...S } }),
    applySettings: (newSettings) => {
      Object.assign(S, pickSettings(newSettings));
      persistSettings();
      if (S.autoReload && window.location.href.includes('youtube.com')) {
        window.location.reload();
      }
    },
    forceReload: () => {
      window.YTSS_SpoofingMethods.clearCache();
      if (window.location.href.includes('youtube.com')) window.location.reload();
    },
    clearCache: () => {
      hqCache.clear();
      pendingFetches.clear();
      reloadedVideos.clear();
      pendingReloads.clear();
      failedFetches.clear();
      // cacheGet falls back to the sessionStorage tier, so clearing only the
      // in-memory Map left every entry live for the full 1-hour TTL.
      try {
        for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
          const key = window.sessionStorage.key(i);
          if (key && key.startsWith('ytss_hq_')) window.sessionStorage.removeItem(key);
        }
      } catch (e) {}
    }
  };

  console.log(TAG, 'Injected — Pre-warm + ytplayer.config + ITAG disguise + ForceReload active');
})();
