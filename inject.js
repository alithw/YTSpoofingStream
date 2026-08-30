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

  // ─── ITAG DISGUISE TABLE ──────────────────────────────────────────
  // The desktop web player refuses itags that are not in its own format table
  // ("Video unavailable" / silent playback). So each premium itag is presented to
  // the player under a codec-compatible itag it does accept, while the `url` still
  // points at the premium stream. The fetch/XHR interceptors then restore the real
  // itag and client on the outgoing videoplayback request.
  const ITAG_DISGUISE = {
    774: { as: 251, mimeType: 'audio/webm; codecs="opus"' },        // Opus 256-300kbps → Opus 160kbps slot
  };
  const HQ_ITAGS = [774];

  // ─── SETTINGS ────────────────────────────────────────────────────
  let S = {
    enabled: true,
    hqFetch: true,
    forceOverride: true,
    audioMode: MODES.HIGHEST,
    autoReload: true,
    preferredClient: 'AUTO',
    rawItag: false,
    shadowPlayer: true,
    shadowVolume: 1.0,
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
    try { localStorage.setItem('ytss_settings', JSON.stringify(S)); } catch (e) { }
  }

  try {
    const stored = localStorage.getItem('ytss_settings');
    if (stored) {
      const parsed = JSON.parse(stored);
      Object.assign(S, pickSettings(parsed));
      // Rewrite immediately if the stored blob carried anything it shouldn't.
      if (Object.keys(parsed).some(k => !SETTING_KEYS.includes(k))) {
        persistSettings();
        try { localStorage.removeItem('ytSpoofingStream_settings'); } catch (e) { }
        console.warn(TAG, 'Purged non-settings keys from stored config.');
      }
    }
  } catch (e) { }

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
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister().then(success => {
          if (success) console.log(TAG, 'Unregistered existing Service Worker');
        });
      }
    }).catch(e => { });

    Object.defineProperty(navigator.serviceWorker, 'register', {
      value: function () {
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
    fallbackReason: null,
    lastError: null,
    activeMode: S.audioMode,
    clientStats: {},
    clientFallback: null,   // set when the chosen Spoofing Method returned no HQ
    noUrlDrop: null,        // set when HQ formats arrived as metadata only (SABR-only, no url)
    prewarmStatus: '—',
  };

  let lastReportJson = '';
  function report() {
    status.activeMode = S.audioMode;
    const currentJson = JSON.stringify(status);
    if (currentJson === lastReportJson) return;
    lastReportJson = currentJson;

    try { localStorage.setItem('ytSpoofingStream_status', currentJson); } catch (e) { }
    if (typeof window.__ytssUpdateBadge === 'function') {
      try { window.__ytssUpdateBadge(); } catch (e) { }
    }
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

  function isCurrentWatchVideo(vid) {
    if (!vid) return true;
    const urlVid = new URLSearchParams(window.location.search).get('v')
      || (window.location.pathname.startsWith('/shorts/') ? window.location.pathname.split('/')[2] : null)
      || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
    const activeVid = urlVid || playerVid;
    if (!activeVid) return true;
    return activeVid === vid;
  }

  // A cache hit used to overwrite status.clientStats wholesale with a single CACHE
  // entry. The popup's client grid is the only place that reports which clients
  // returned 774/141 and why the rest failed, and cacheGet runs on every interception
  // point — so the per-client results were wiped moments after the fan-out produced
  // them. Only fill the marker in when there is nothing better to show.
  function noteCacheHit() {
    if (!status.clientStats || Object.keys(status.clientStats).length === 0) {
      status.clientStats = { CACHE: 'Loaded from Session Cache (Instant)' };
    }
  }

  // Cache key prefix. Bumped to v2 when the `_ytss_*` URL-marker layer was removed:
  // v1 entries hold stream URLs with markers baked in and ciphers that the old
  // in-place mutation had appended markers to repeatedly. Those are unplayable now,
  // and sessionStorage survives the extension reload, so the prefix change is what
  // guarantees a stale entry can never be served to the player.
  const CACHE_PREFIX = 'ytss_hq_v2_';

  function cacheGet(videoId) {
    // 1. Check memory map first
    const entry = hqCache.get(videoId);
    if (entry && (Date.now() - entry.ts <= HQ_CACHE_TTL_MS)) {
      noteCacheHit();
      return entry;
    }
    // 2. Check sync sessionStorage (handles F5 reloads flawlessly)
    try {
      const stored = window.sessionStorage.getItem(CACHE_PREFIX + videoId);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Date.now() - parsed.ts <= HQ_CACHE_TTL_MS) {
          hqCache.set(videoId, parsed); // restore to mem
          noteCacheHit();
          return parsed;
        } else {
          window.sessionStorage.removeItem(CACHE_PREFIX + videoId);
        }
      }
    } catch (e) { }

    hqCache.delete(videoId);
    return null;
  }

  function cacheSet(videoId, formats, streamingContext = null) {
    const entry = { formats, streamingContext, ts: Date.now() };
    hqCache.set(videoId, entry);
    try {
      window.sessionStorage.setItem(CACHE_PREFIX + videoId, JSON.stringify(entry));
    } catch (e) { }
  }

  // ─── SERVICE WORKER BRIDGE ────────────────────────────────────────
  function fetchHQViaSW(videoId) {
    return new Promise((resolve) => {
      const requestId = 'req_' + Math.random().toString(36).substr(2, 9);

      function onMessage(e) {
        if (e.data?.type === 'YTSS_HQ_RESULT' && e.data.requestId === requestId) {
          window.removeEventListener('message', onMessage);
          resolve({
            results: e.data.results || [],
            streamingContext: e.data.streamingContext || null,
          });
        }
      }
      window.addEventListener('message', onMessage);

      window.postMessage({ type: 'YTSS_FETCH_HQ', videoId, requestId, context: collectPageContext() }, '*');

      // 12s timeout: SW may need to restart after being killed by Chrome (~30s idle).
      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ results: [], streamingContext: null });
      }, 12000);
    });
  }

  // ── Phase 1 (Option D): TV streaming context cache + fetcher.
  const TVCTX_CACHE_TTL_MS = 3600000;
  const tvCtxCache = new Map(); // videoId → { ctx, ts }

  function getTvContext(videoId) {
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return Promise.resolve(null);

    // 1. Check memory / hqCache first
    const hqEntry = hqCache.get(videoId);
    if (hqEntry?.streamingContext) return Promise.resolve(hqEntry.streamingContext);

    const mem = tvCtxCache.get(videoId);
    if (mem && (Date.now() - mem.ts <= TVCTX_CACHE_TTL_MS)) {
      return Promise.resolve(mem.ctx);
    }

    // 2. Ask SW via bridge (async)
    return new Promise((resolve) => {
      const requestId = 'tvctx_' + Math.random().toString(36).substr(2, 9);

      function onMessage(e) {
        if (e.data?.type === 'YTSS_TVCTX_RESULT' && e.data.requestId === requestId) {
          window.removeEventListener('message', onMessage);
          const ctx = e.data.streamingContext || null;
          if (ctx) tvCtxCache.set(videoId, { ctx, ts: Date.now() });
          resolve(ctx);
        }
      }
      window.addEventListener('message', onMessage);

      window.postMessage({ type: 'YTSS_FETCH_TVCTX', videoId, requestId }, '*');

      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(null);
      }, 3000);
    });
  }

  async function fetchAllHQAudio(videoId) {
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return { formats: [], streamingContext: null };
    if (pendingFetches.has(videoId)) return await pendingFetches.get(videoId);

    const cached = cacheGet(videoId);
    if (cached && (cached.formats?.length > 0 || cached.streamingContext)) return cached;

    const failedAt = failedFetches.get(videoId);
    if (failedAt && Date.now() - failedAt < FAILED_RETRY_MS) return { formats: [], streamingContext: null };

    console.log(TAG, `[HQ] Fetching for ${videoId}...`);
    status.clientStats = {}; // Clear stale stats before fetching
    report();

    const fetchPromise = fetchHQViaSW(videoId).then(({ results, streamingContext }) => {
      const merged = [];
      const seen = new Set();
      let tvCtx = streamingContext;

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

          if (clientRes.streamingContext) {
            tvCtx = clientRes.streamingContext;
          }

          for (const fmt of audio) {
            const key = `${fmt._src || clientRes.source}:${fmt.itag}`;
            if (!seen.has(key)) {
              seen.add(key);
              merged.push(fmt);
            }
          }
        } else {
          status.clientStats[clientRes.source] = 'No Audio';
        }
      }

      hqCache.delete(videoId);
      if (merged.length > 0 || tvCtx) {
        cacheSet(videoId, merged, tvCtx);
        failedFetches.delete(videoId);
      } else {
        failedFetches.set(videoId, Date.now());
      }
      pendingFetches.delete(videoId);
      report();
      return { formats: merged, streamingContext: tvCtx };
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
    if (pendingFetches.has(videoId)) return;
    status.prewarmStatus = `pre-fetching ${videoId}…`;
    report();
    fetchAllHQAudio(videoId).then(hqData => {
      const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
      const tvCtx = hqData?.streamingContext || null;
      const count = formats.length;
      status.prewarmStatus = (count > 0 || tvCtx)
        ? `ready: ${count} formats${tvCtx ? ' + TV SABR' : ''}`
        : 'no HQ formats';
      report();
      console.log(TAG, `[Pre-warm] ${status.prewarmStatus} for ${videoId}`);
      if ((count > 0 || tvCtx) && S.autoReload) {
        forcePlayerReload(videoId, hqData);
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
    if (typeof SeparateAudioEngine !== 'undefined') {
      SeparateAudioEngine.stopAndUnmute();
    }

    // Reset status immediately so previous video's 774 doesn't linger on new video
    status.activeAudioItag = 251;
    status.activeMethod = 'original';
    status.fallbackReason = 'Loading...';
    status.bestAudioInfo = 'Native Audio (ITAG 251)';
    report();

    const incomingVid = e?.detail?.endpoint?.watchEndpoint?.videoId
      || e?.detail?.params?.videoId
      || null;
    if (incomingVid) {
      prewarmCache(incomingVid);
    } else {
      setTimeout(() => {
        const vid = getVideoIdFromUrl();
        if (vid) prewarmCache(vid);
      }, 0);
    }
  });

  function getAll774Candidates(list) {
    if (!list || !Array.isArray(list)) return [];
    // Only fetch/match Opus 774 formats (dropping 141 as 251 is already equivalent)
    const candidates = list.filter(f => (f.itag === 774 || f._origItag === 774) && (f.url || f.signatureCipher));
    // Sort by highest bitrate / quality
    candidates.sort((a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0));
    return candidates;
  }

  function findBestReal774(list) {
    const cands = getAll774Candidates(list);
    return cands.length > 0 ? cands[0] : null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // HQ FILTER & MERGE ENGINE (Option D TV SABR Transplant + Direct Fallback)
  // ═══════════════════════════════════════════════════════════════════
  function processPlayerResponse(json, hqData = null) {
    if (!json?.streamingData?.adaptiveFormats) return json;

    if (!json._origFormats) {
      json._origFormats = JSON.parse(JSON.stringify(json.streamingData.adaptiveFormats));
    }

    const videoFormats = json._origFormats.filter(f => !(f.mimeType || '').includes('audio/'));
    const origAudio = json._origFormats.filter(f => (f.mimeType || '').includes('audio/'));

    let filteredHq = [];
    let tvStreamingContext = null;

    if (Array.isArray(hqData)) {
      filteredHq = hqData;
    } else if (hqData && typeof hqData === 'object') {
      filteredHq = hqData.formats || [];
      tvStreamingContext = hqData.streamingContext || null;
    }

    // Filter HQ formats by preferred client if specified.
    status.clientFallback = null;
    if (S.preferredClient && S.preferredClient !== 'AUTO') {
      const preferred = filteredHq.filter(f => f._src === S.preferredClient);
      if (preferred.length > 0) {
        filteredHq = preferred;
      } else if (filteredHq.length > 0) {
        status.clientFallback = `${S.preferredClient} returned no HQ — using best available`;
        console.warn(TAG, `[Client] ${status.clientFallback}`);
      }
    }

    const seen = new Set();
    const pool = [];
    let droppedNoUrl = 0;

    if (filteredHq.length > 0) {
      for (const f of filteredHq) {
        const hasUrlOrCipher = !!(f.url || f.signatureCipher);
        const isTvSabr = (f._src === 'TVHTML5' || f.itag === 774) && !!(tvStreamingContext?.serverAbrStreamingUrl);

        if (!hasUrlOrCipher && !isTvSabr) {
          if (droppedNoUrl === 0) {
            console.warn(TAG, `[Pool] first dropped format: itag=${f.itag} _src=${f._src}`
              + ` keys=[${Object.keys(f).join(',')}]`);
          }
          droppedNoUrl++;
          continue;
        }
        if (!seen.has(f.itag)) { seen.add(f.itag); pool.push(f); }
      }
    }

    if (droppedNoUrl > 0) {
      status.noUrlDrop = `${droppedNoUrl}/${filteredHq.length} HQ formats had no url & no SABR`;
      console.warn(TAG, `[Pool] ${status.noUrlDrop}`);
    } else {
      status.noUrlDrop = null;
    }

    // Original streams
    for (const f of origAudio) {
      if (!seen.has(f.itag)) { seen.add(f.itag); pool.push({ ...f, _src: 'original' }); }
    }

    // Remove itag 140 (low-quality AAC fallback) if we have something better
    let filteredPool = pool.filter(f => f.itag !== 140);
    if (filteredPool.length === 0) filteredPool = pool;

    const hqInPool = pool.filter(f => f._src !== 'original');
    console.log(TAG, `[Pool] fromSW=${filteredHq.length} usable=${hqInPool.length}`
      + ` | candidates=${filteredPool.map(f => `${f.itag}${f._src === 'original' ? '' : '*'}`).join(',') || '(none)'}`
      + ` (* = HQ from SW)`);

    const mode = S.audioMode || MODES.HIGHEST;
    let selectedAudio = [];

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
      const target = opus.find(f => f.itag === 774 || f._origItag === 774);
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
      // HIGHEST: prefer 774 if present
      const target774 = filteredPool.find(f => f.itag === 774 || f._origItag === 774);
      if (target774) {
        selectedAudio = [target774];
        console.log(TAG, `★ ITAG 774 (Opus 256kbps+) [${target774._src}]`);
        if (status.fallbackReason) {
          status.fallbackReason = null;
          report();
        }
      } else {
        const ranked = byBitrate(filteredPool);
        selectedAudio = ranked.length ? pick(ranked) : [];
        if (ranked.length) {
          console.log(TAG, `Highest -> ITAG ${ranked[0].itag} (${Math.round((ranked[0].bitrate || 0) / 1000)}k) [${ranked[0]._src}]`);
        }
      }
    }

    selectedAudio = selectedAudio.filter(Boolean);

    // Keep native player streaming data intact (prevent playback error)
    selectedAudio = selectedAudio.map(f => {
      const origItag = f._origItag || f.itag;
      const disguise = ITAG_DISGUISE[origItag];
      if (!disguise || S.rawItag) {
        return { ...f, itag: origItag, _origItag: origItag, _src: f._src || 'hq' };
      }
        return {
          ...f,
          itag: disguise.as,
          mimeType: disguise.mimeType,
          _origItag: origItag,
          _src: f._src || 'hq',
        };
      });

    // Dedup by itag
    const byItag = new Map();
    for (const f of selectedAudio) {
      const existing = byItag.get(f.itag);
      if (!existing) { byItag.set(f.itag, f); continue; }
      const incomingIsHQ = HQ_ITAGS.includes(f._origItag);
      const existingIsHQ = HQ_ITAGS.includes(existing._origItag);
      if (incomingIsHQ && !existingIsHQ) byItag.set(f.itag, f);
    }
    selectedAudio = [...byItag.values()];

    json.streamingData.adaptiveFormats = json._origFormats;

    const target774InPool = pool.find(f => f.itag === 774 || f._origItag === 774);
    const active = target774InPool || selectedAudio.find(f => HQ_ITAGS.includes(f.itag || f._origItag)) || selectedAudio[0];
    const isCurrent = isCurrentWatchVideo(json.videoDetails?.videoId);
    if (active && isCurrent) {
      const isRealHq = HQ_ITAGS.includes(active._origItag || active.itag);
      const displayItag = isRealHq ? (active._origItag || active.itag) : (active.itag || 251);
      const codec = (active.mimeType || '').includes('opus') ? 'Opus' : 'AAC';
      const kbps = Math.round((active.bitrate || 0) / 1000) || (displayItag === 774 ? 256 : 145);
      const src = isRealHq ? (active._src || 'TVHTML5') : 'original';

      status.activeMethod = src;
      status.activeAudioItag = displayItag;
      status.bestAudioInfo = `ITAG ${displayItag}${isRealHq ? ' [HQ ★]' : ''} | ${codec} ${kbps}kbps | Method: ${src}`;
      status.injectedStreams = Math.max(pool.length, 6);
      status.videoTitle = json.videoDetails?.title || document.title || 'audio';
      status.contentLength = active.contentLength || null;
      status.noUrlDrop = null;
      status.fallbackReason = isRealHq ? null : 'Using best original stream (ITAG ' + displayItag + ')';
      report();
    }

    // Check if we have real playable 774 formats
    const real774Candidates = getAll774Candidates(pool);
    const vid = json.videoDetails?.videoId || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    if (real774Candidates.length > 0) {
      SeparateAudioEngine.loadReal774(vid, real774Candidates);
    } else {
      SeparateAudioEngine.stopAndUnmute();
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
      if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
        console.log(TAG, `[ytInitialPlayerResponse] Cache HIT → sync merge formats`);
        initialResponseValue = processPlayerResponse(val, cached);
        reloadedVideos.add(videoId);
      } else {
        // No cache yet → sync process with original only, then async merge + player reload
        initialResponseValue = processPlayerResponse(val, null);

        if (S.hqFetch && videoId) {
          fetchAllHQAudio(videoId).then(hqData => {
            const hasFormats = hqData && (hqData.formats?.length > 0 || hqData.length > 0 || hqData.streamingContext);
            if (hasFormats) {
              console.log(TAG, `[ytInitialPlayerResponse] Async merge formats → forcing player reload`);
              processPlayerResponse(initialResponseValue, hqData);
              forcePlayerReload(videoId, hqData);
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
        gl: cfg.get('GL') || innertube?.client?.gl || 'VN',
        hl: cfg.get('HL') || innertube?.client?.hl || 'vi',
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
    } catch (e) { }
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
        val.set = function (...args) {
          try {
            let obj = args[0];
            if (typeof args[0] === 'string' && args.length > 1) {
              obj = { [args[0]]: args[1] };
            }
            if (obj && obj.EXPERIMENT_FLAGS) {
              // Ensure SABR is permitted so TV SABR transplant can stream UMP 774
              if (obj.EXPERIMENT_FLAGS.html5_disable_sabr) {
                obj.EXPERIMENT_FLAGS.html5_disable_sabr = false;
              }
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
        const cached = videoId ? cacheGet(videoId) : null;
        console.log(TAG, `[ytplayer.config] raw_player_response sync patch (cached: ${!!cached})`);
        args.raw_player_response = processPlayerResponse(args.raw_player_response, cached);
      }

      // player_response (older / fallback, JSON string)
      if (typeof args.player_response === 'string') {
        try {
          const pr = JSON.parse(args.player_response);
          if (pr.streamingData) {
            const videoId = pr.videoDetails?.videoId;
            const cached = videoId ? cacheGet(videoId) : null;
            console.log(TAG, `[ytplayer.config] player_response sync patch (cached: ${!!cached})`);
            args.player_response = JSON.stringify(processPlayerResponse(pr, cached));
          }
        } catch (e) { }
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
  // ═══════════════════════════════════════════════════════════════════
  function forcePlayerReload(videoId, hqData) {
    if (!hqData) return;
    const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
    const tvCtx = hqData?.streamingContext || null;
    if (formats.length === 0 && !tvCtx) return;

    if (isMusicSite) {
      console.log(TAG, `[PlayerReload] music.youtube.com detected. Skipping player reload.`);
      return;
    }

    if (reloadedVideos.has(videoId)) return;
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
          release('loadVideoById threw error');
        }
      } else if (attempts < MAX_ATTEMPTS) {
        setTimeout(tryReload, 200);
      } else {
        release('player element not ready after retries');
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
    const hasFormats = cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext);
    if (!hasFormats) {
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
    if (e.source !== window || e.data?.type !== 'YTSS_SW_TRIGGER') return;
    const { videoId } = e.data;
    if (videoId) tryUpgradeVideo(videoId, 'SWTrigger');
  });

  // ═══════════════════════════════════════════════════════════════════
  // OPTION C — SABR body structural protobuf rewriter
  // ═══════════════════════════════════════════════════════════════════
  // Rewrites the preferred-audio field (f16.f1) and matching selected-format
  // entry (f2) from oldItag → newItag in a SABR POST body. Parses the wire
  // format structurally — never byte-scans. Returns a *new* Uint8Array on
  // success, or null if anything fails (caller must pass body untouched).
  //
  // Wire format reminder:
  //   tag = (field_number << 3) | wire_type
  //   wire 0 = varint, 1 = 64-bit, 2 = length-delimited, 5 = 32-bit
  //
  // f16 (preferred audio) = { f1: varint itag, f2: varint lastModified }
  // f2  (selected format) = { f1: varint itag, f2: varint lastModified, f3: string }
  // Both f16 and f2 are length-delimited (wire type 2) at the top level.
  // f5 is the SIGNED region — we never touch it.

  // Read a varint starting at offset. Returns [value, nextOffset] or null on error.
  // Uses BigInt internally to handle 64-bit values (lastModified timestamps exceed
  // 32-bit). Returns a Number when safe (itag), BigInt otherwise — caller compares
  // via BigInt arithmetic.
  function pbReadVarint(bytes, off) {
    let result = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (off + i >= bytes.length) return null;
      const b = bytes[off + i];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        const v = result;
        // Return Number for small values (itag), BigInt for large (lastModified).
        return [v <= 0xFFFFFFFFn ? Number(v) : v, off + i + 1];
      }
      shift += 7n;
    }
    return null; // >10 bytes = malformed
  }

  // Encode a varint. Returns number[] of byte values. Accepts Number or BigInt.
  function pbEncodeVarint(value) {
    const out = [];
    let v = typeof value === 'bigint' ? value : BigInt(value);
    if (v < 0n) v = 0n;
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v & 0x7fn));
    return out;
  }

  // Read a field tag. Returns [fieldNumber, wireType, nextOffset] or null.
  function pbReadTag(bytes, off) {
    const v = pbReadVarint(bytes, off);
    if (!v) return null;
    const tag = v[0], next = v[1];
    return [tag >>> 3, tag & 0x07, next];
  }

  // Parse a length-delimited sub-message. Returns { fields: Map<fn, [{off, len}]>,
  // rawStart, rawLen } or null. Does NOT recurse — caller descends as needed.
  // Also returns the varint offsets so the caller can rewrite in place.
  function pbParseMessage(bytes, start, end) {
    const fields = new Map(); // fieldNumber → [{valueOff, valueLen, wireType}]
    let off = start;
    while (off < end) {
      const tag = pbReadTag(bytes, off);
      if (!tag) return null;
      const fn = tag[0], wt = tag[1], afterTag = tag[2];
      if (wt === 0) { // varint
        const v = pbReadVarint(bytes, afterTag);
        if (!v) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 0, valueOff: afterTag, valueLen: v[1] - afterTag, value: v[0] });
        off = v[1];
      } else if (wt === 2) { // length-delimited
        const lenV = pbReadVarint(bytes, afterTag);
        if (!lenV) return null;
        const len = lenV[0], dataOff = lenV[1];
        if (dataOff + len > end) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 2, valueOff: dataOff, valueLen: len });
        off = dataOff + len;
      } else if (wt === 1) { // 64-bit
        if (afterTag + 8 > end) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 1, valueOff: afterTag, valueLen: 8 });
        off = afterTag + 8;
      } else if (wt === 5) { // 32-bit
        if (afterTag + 4 > end) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 5, valueOff: afterTag, valueLen: 4 });
        off = afterTag + 4;
      } else {
        return null; // unknown wire type
      }
    }
    return off === end ? fields : null;
  }

  // Main rewriter. Returns a *new* Uint8Array with patches applied, or null.
  function sabrRewritePreferredAudio(bytes, oldItag, newItag, newLastModified) {
    if (!bytes || bytes.length === 0) return null;
    try {
      const topFields = pbParseMessage(bytes, 0, bytes.length);
      if (!topFields) return null;

      // ── Patch f16 (preferred audio): rewrite f16.f1 (itag) and f16.f2 (lastModified)
      const f16Entries = topFields.get(16);
      if (!f16Entries || f16Entries.length === 0) return null;
      const f16 = f16Entries[0]; // wire type 2
      const f16Fields = pbParseMessage(bytes, f16.valueOff, f16.valueOff + f16.valueLen);
      if (!f16Fields) return null;
      const f16f1 = f16Fields.get(1)?.[0]; // itag varint
      if (!f16f1 || f16f1.wireType !== 0 || f16f1.value !== oldItag) return null;

      // ── Patch f2 (selected format): find the entry whose f1 === oldItag
      const f2Entries = topFields.get(2);
      let f2Target = null, f2Fields = null, f2f1 = null, f2f2 = null;
      if (f2Entries) {
        for (const e of f2Entries) {
          const ff = pbParseMessage(bytes, e.valueOff, e.valueOff + e.valueLen);
          if (!ff) continue;
          const f1 = ff.get(1)?.[0];
          if (f1 && f1.wireType === 0 && f1.value === oldItag) {
            f2Target = e; f2Fields = ff; f2f1 = f1; f2f2 = ff.get(2)?.[0];
            break;
          }
        }
      }

      // Build the patched buffer. Both oldItag and newItag must be 2-byte varints
      // so the enclosing length prefix is unchanged — verify this assumption.
      const oldItagBytes = pbEncodeVarint(oldItag);
      const newItagBytes = pbEncodeVarint(newItag);
      if (oldItagBytes.length !== newItagBytes.length) {
        console.warn(TAG, `[OptionC] varint length mismatch: ${oldItag}=${oldItagBytes.length}B, ${newItag}=${newItagBytes.length}B — aborting`);
        return null;
      }

      // Start from a copy.
      const out = new Uint8Array(bytes);

      // Rewrite f16.f1 (itag) in place — same byte count.
      out[f16f1.valueOff] = newItagBytes[0];
      out[f16f1.valueOff + 1] = newItagBytes[1];

      // Rewrite f16.f2 (lastModified) if present.
      const f16f2 = f16Fields.get(2)?.[0];
      if (f16f2 && f16f2.wireType === 0) {
        const newLmBytes = pbEncodeVarint(BigInt(newLastModified));
        const oldLmLen = f16f2.valueLen;
        if (newLmBytes.length === oldLmLen) {
          for (let i = 0; i < newLmBytes.length; i++) out[f16f2.valueOff + i] = newLmBytes[i];
        } else {
          // Length differs — need to rebuild f16 sub-message. More complex; for now
          // skip the lastModified rewrite and just do the itag. The server may reject
          // it, but this is the falsification test.
          console.warn(TAG, `[OptionC] f16.f2 lastModified length mismatch (${oldLmLen}→${newLmBytes.length}) — itag-only patch`);
        }
      }

      // Rewrite f2 entry (selected format) if found.
      if (f2Target && f2f1) {
        out[f2f1.valueOff] = newItagBytes[0];
        out[f2f1.valueOff + 1] = newItagBytes[1];
        if (f2f2 && f2f2.wireType === 0) {
          const newLmBytes = pbEncodeVarint(BigInt(newLastModified));
          if (newLmBytes.length === f2f2.valueLen) {
            for (let i = 0; i < newLmBytes.length; i++) out[f2f2.valueOff + i] = newLmBytes[i];
          } else {
            console.warn(TAG, `[OptionC] f2.f2 lastModified length mismatch — itag-only patch`);
          }
        }
      }

      return out;
    } catch (e) {
      console.warn(TAG, '[OptionC] sabrRewritePreferredAudio error:', e);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════
  // NATIVE STATS FOR NERDS (THỐNG KÊ CHI TIẾT) OVERRIDE & SPOOFER
  // ═══════════════════════════════════════════════════════════════════
  const StatsForNerdsSpoofer = {
    initialized: false,
    timer: null,

    getCodecText() {
      // If we are in fallback mode (not playing real 774), keep the raw original ITAG (251, 140, etc.)
      const isReal774 = status.activeAudioItag === 774 && !status.fallbackReason;
      if (!isReal774) return null;
      return '/ opus (774)';
    },

    init() {
      if (this.initialized) return;
      this.initialized = true;
      this.hookPlayerAPI();
      this.startDOMCheck();
      console.log(TAG, '[StatsForNerds] Override & Spoofing Engine Active (Conditional on Real 774)');
    },

    hookPlayerAPI() {
      const tryHook = () => {
        const player = document.getElementById('movie_player');
        if (!player || player._ytssStatsHooked) return;
        player._ytssStatsHooked = true;

        if (typeof player.getStatsForNerds === 'function') {
          const origStats = player.getStatsForNerds;
          const self = this;
          player.getStatsForNerds = function () {
            const stats = origStats.apply(this, arguments) || {};
            const override = self.getCodecText();
            if ((S.shadowPlayer || S.sfnSpoof) && override && stats && stats.codecs) {
              stats.codecs = stats.codecs.replace(/\/\s*[\w.-]+\s*\(\d+\)/, override);
            }
            return stats;
          };
        }
      };

      tryHook();
      setInterval(tryHook, 2000);
    },

    startDOMCheck() {
      if (this.timer) return;
      this.timer = setInterval(() => {
        if (!S.shadowPlayer && !S.sfnSpoof) return;
        const override = this.getCodecText();
        if (!override) return;

        const panel = document.querySelector('.html5-video-info-panel-content, .ytp-sfn-content');
        if (!panel) return;

        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const txt = node.nodeValue || '';
          if (txt.includes('/') && (txt.includes('opus (') || txt.includes('mp4a.') || txt.includes('251') || txt.includes('140')) && !txt.includes('774')) {
            node.nodeValue = txt.replace(/\/\s*[\w.-]+\s*\(\d+\)/, override);
          }
        }
      }, 1000);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // SIGNATURE CIPHER DECIPHER ENGINE (Unlocks 774/141 from WEB_REMIX/WEB)
  // ═══════════════════════════════════════════════════════════════════
  const SignatureCipherDecipherer = {
    cachedP: null,

    async init() {
      if (this.cachedP) return;
      try {
        const scripts = Array.from(document.querySelectorAll('script[src*="base.js"], script[src*="player_es6"]'));
        let baseJsUrl = scripts[0]?.src;
        if (!baseJsUrl) {
          baseJsUrl = 'https://www.youtube.com/s/player/e937390a/player_es6.vflset/vi_VN/base.js';
        }
        const res = await fetch(baseJsUrl);
        const js = await res.text();
        const startIdx = js.indexOf('var p=[');
        if (startIdx !== -1) {
          const endIdx = js.indexOf('],', startIdx);
          const pStr = js.slice(startIdx + 6, endIdx + 1);
          this.cachedP = JSON.parse(pStr);
          console.log(TAG, `[Decipherer] Initialized successfully with ${this.cachedP.length} string table entries`);
        }
      } catch (e) {
        console.warn(TAG, '[Decipherer] Init error:', e.message);
      }
    },

    decipher(s) {
      if (!s) return s;
      const p = this.cachedP;
      if (!p) return s;

      const Cy = {
        rt: function (D, M) {
          const G = D[0];
          D[0] = D[M % D.length];
          D[M % D.length] = G;
        },
        Ub: function (D, M) {
          D.splice(0, M);
        },
        zD: function (D) {
          D.reverse();
        }
      };

      function xC(D, M, G) {
        let S = G;
        if ((D + 8 >> 3 >= 2) && ((D >> 1 & 12) < 6)) {
          try { S = decodeURIComponent(G); } catch (e) { S = G; }
        }
        return S;
      }

      function wU(D, M, G) {
        const e = M ^ D;
        let r;
        if ((D >> 2 & 6) >= 2 && D - 6 < 14) {
          r = encodeURIComponent(G);
        }
        if ((D & 87) === D) {
          const delim = p[e ^ 8403] !== undefined ? p[e ^ 8403] : "";
          const S = G.split(delim);

          const op1 = p[e ^ 8339];
          const op2 = p[e ^ 8439];
          const op3 = p[e ^ 8390];

          if (Cy[op1]) Cy[op1](S, 1);
          if (Cy[op2]) Cy[op2](S, e ^ 8384);
          if (Cy[op3]) Cy[op3](S, e ^ 8419);
          if (Cy[op3]) Cy[op3](S, e ^ 8446);
          if (Cy[op3]) Cy[op3](S, e ^ 8399);

          r = S.join(delim);
        }
        return r;
      }

      try {
        const c = wU(2, 8414, xC(15, 7887, s));
        const sig = wU(8, 2934, c);
        return sig || s;
      } catch (e) {
        console.warn(TAG, '[Decipherer] decipher error:', e);
        return s;
      }
    },

    decipherFormat(format) {
      if (!format) return null;
      if (format.url) return format.url;
      if (!format.signatureCipher) return null;

      try {
        const params = new URLSearchParams(format.signatureCipher);
        const rawUrl = params.get('url');
        const rawSig = params.get('s');
        const sp = params.get('sp') || 'sig';
        if (!rawUrl || !rawSig) return null;

        const resolvedSig = this.decipher(rawSig);
        const finalUrl = `${rawUrl}&${sp}=${encodeURIComponent(resolvedSig)}`;
        return finalUrl;
      } catch (e) {
        return null;
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // SEPARATE REAL 774 AUDIO ENGINE (Plays Real 774 & Mutes Main; Falls Back Unmuted)
  // ═══════════════════════════════════════════════════════════════════
  const SeparateAudioEngine = {
    element: null,
    audioCtx: null,
    gainNode: null,
    sourceNode: null,
    activeVideoId: null,
    activeUrl: null,
    activeFormat: null,
    isReal774Playing: false,
    syncInterval: null,
    volume: parseFloat(localStorage.getItem('ytss_boost_volume') || '1.0'),

    init() {
      if (this.element) return;
      this.element = document.createElement('audio');
      this.element.id = 'ytss-real-audio';
      this.element.style.display = 'none';
      this.element.preload = 'auto';

      this.element.addEventListener('error', () => {
        console.warn(TAG, '[SeparateAudio] Stream failed or 403 Forbidden -> Fallback to unmuted native player');
        this.stopAndUnmute();
      });

      this.element.addEventListener('playing', () => {
        const mainVideo = document.querySelector('#movie_player video') || document.querySelector('video');
        if (mainVideo && this.isReal774Playing) {
          mainVideo.muted = true;
          console.log(TAG, '[SeparateAudio] Real HQ audio playing -> Muted main video');
        }
      });

      document.body.appendChild(this.element);

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.audioCtx = new AudioCtx();
          this.sourceNode = this.audioCtx.createMediaElementSource(this.element);
          this.gainNode = this.audioCtx.createGain();
          this.gainNode.gain.value = this.volume;
          this.sourceNode.connect(this.gainNode);
          this.gainNode.connect(this.audioCtx.destination);
        }
      } catch (e) { }

      this.attachSync();
      this.injectVolumeUI();
    },

    loadingVideoId: null,

    async loadReal774(videoId, candidates) {
      if (!this.element) this.init();
      const currentActiveId = document.getElementById('movie_player')?.getVideoData?.()?.video_id || new URLSearchParams(location.search).get('v');
      const isWatch = location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts') || location.pathname.startsWith('/live') || location.pathname.startsWith('/tv') || isMusicSite;
      if (!isWatch || (videoId && currentActiveId && currentActiveId !== videoId)) {
        return false;
      }

      const list = Array.isArray(candidates) ? candidates : [candidates].filter(Boolean);
      if (list.length === 0) {
        this.stopAndUnmute();
        return false;
      }

      await SignatureCipherDecipherer.init();

      for (const format of list) {
        try {
          const streamUrl = SignatureCipherDecipherer.decipherFormat(format);
          if (!streamUrl) continue;

          if (this.activeVideoId === videoId && this.activeUrl === streamUrl && this.isReal774Playing) {
            return true;
          }

          this.activeVideoId = videoId;
          this.activeFormat = format;
          this.activeUrl = streamUrl;

          const itag = format._origItag || format.itag || 774;
          console.log(TAG, `★ [SeparateAudio] Loading REAL DECIPHERED ITAG ${itag} from ${format._src || 'WEB_REMIX'} (${Math.round((format.bitrate || 0) / 1000)}k)`);

          const mimeType = (format.mimeType || 'audio/webm; codecs="opus"').split(';')[0];
          const fullType = `${mimeType}; codecs="opus"`;

          this.element.src = streamUrl;
          this.isReal774Playing = true;

          const mainVideo = document.querySelector('#movie_player video') || document.querySelector('video');
          if (mainVideo) {
            this.element.currentTime = mainVideo.currentTime;
            const tryPlay = () => {
              if (!mainVideo.paused && this.isReal774Playing) {
                if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
                this.element.play().then(() => {
                  mainVideo.muted = true;
                }).catch(() => {});
              }
            };
            if (this.element.readyState >= 2) {
              tryPlay();
            } else {
              this.element.addEventListener('canplay', tryPlay, { once: true });
            }
          }
          this.updateBadgeUI();
          return true;
        } catch (e) {
          console.warn(TAG, `[SeparateAudio] Candidate error:`, e);
        }
      }

      this.stopAndUnmute();
      this.updateBadgeUI();
      return false;
    },

    stopAndUnmute() {
      this.isReal774Playing = false;
      this.activeFormat = null;
      this.activeUrl = null;
      if (this.element) {
        this.element.pause();
        this.element.removeAttribute('src');
      }
      const mainVideo = document.querySelector('#movie_player video') || document.querySelector('video');
      if (mainVideo) {
        mainVideo.muted = false;
        console.log(TAG, '[SeparateAudio] Native audio ACTIVE (mainVideo.muted = false)');
      }
    },

    attachSync() {
      const checkAndAttach = () => {
        const playerEl = document.getElementById('movie_player');
        const mainVideo = playerEl ? playerEl.querySelector('video') : document.querySelector('video');
        if (!mainVideo || mainVideo._ytssSepSynced) return;
        mainVideo._ytssSepSynced = true;

        mainVideo.addEventListener('play', () => {
          if (this.isReal774Playing && this.element && this.element.src) {
            mainVideo.muted = true;
            if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
            this.element.play().catch(() => {});
          }
        });

        mainVideo.addEventListener('pause', () => {
          if (this.isReal774Playing && this.element) this.element.pause();
        });

        mainVideo.addEventListener('seeking', () => {
          if (this.isReal774Playing && this.element) {
            this.element.currentTime = mainVideo.currentTime;
          }
        });

        mainVideo.addEventListener('seeked', () => {
          if (this.isReal774Playing && this.element) {
            this.element.currentTime = mainVideo.currentTime;
          }
        });

        mainVideo.addEventListener('ratechange', () => {
          if (this.isReal774Playing && this.element) {
            this.element.playbackRate = mainVideo.playbackRate;
          }
        });

        mainVideo.addEventListener('volumechange', () => {
          if (this.isReal774Playing && this.element && this.element.src && !mainVideo.muted) {
            mainVideo.muted = true;
          }
        });

        if (playerEl && typeof playerEl.addEventListener === 'function' && !playerEl._ytssEventsAttached) {
          playerEl._ytssEventsAttached = true;
          playerEl.addEventListener('onStateChange', (state) => {
            const currentVid = playerEl.getVideoData?.()?.video_id || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
            if (currentVid && currentVid !== this.activeVideoId && currentVid !== this.loadingVideoId) {
              this.onPlaylistTrackChange(currentVid);
            }
          });
          playerEl.addEventListener('videodatachange', () => {
            const currentVid = playerEl.getVideoData?.()?.video_id || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
            if (currentVid && currentVid !== this.activeVideoId && currentVid !== this.loadingVideoId) {
              this.onPlaylistTrackChange(currentVid);
            }
          });
        }

        if (this.syncInterval) clearInterval(this.syncInterval);
        this.syncInterval = setInterval(() => {
          if (!this.isReal774Playing || !mainVideo || mainVideo.paused || !this.element || !this.element.src) return;
          const drift = Math.abs(mainVideo.currentTime - this.element.currentTime);
          if (drift > 0.08) {
            this.element.currentTime = mainVideo.currentTime;
          }
        }, 1000);
      };

      checkAndAttach();
      if (!this.attachInterval) {
        this.attachInterval = setInterval(checkAndAttach, 2000);
      }
    },

    async onPlaylistTrackChange(newVideoId) {
      if (!newVideoId || newVideoId === this.activeVideoId || newVideoId === this.loadingVideoId) return;
      this.loadingVideoId = newVideoId;
      console.log(TAG, `[PlaylistTrackChange] Track transitioning to: ${newVideoId}`);

      let hqData = (typeof cacheGet === 'function') ? cacheGet(newVideoId) : null;
      if (!hqData && typeof fetchAllHQAudio === 'function') {
        try {
          hqData = await fetchAllHQAudio(newVideoId);
        } catch (e) { }
      }

      if (this.loadingVideoId !== newVideoId) return;

      const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
      const real774Candidates = getAll774Candidates(formats);
      const tv774 = formats.find(f => (f.itag === 774 || f._origItag === 774));

      if (real774Candidates.length > 0) {
        const best = real774Candidates[0];
        const itag = best._origItag || best.itag || 774;
        status.activeAudioItag = itag;
        status.activeMethod = best._src || 'WEB_REMIX';
        status.fallbackReason = null;
        status.bestAudioInfo = `ITAG ${itag} [HQ ★] | Opus ${Math.round((best.bitrate || 280000) / 1000)}kbps | Method: ${status.activeMethod}`;
        report();
        await this.loadReal774(newVideoId, real774Candidates);
      } else if (tv774) {
        status.activeAudioItag = 774;
        status.activeMethod = tv774._src || 'TVHTML5';
        status.fallbackReason = null;
        status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${Math.round((tv774.bitrate || 274000) / 1000)}kbps | Method: ${status.activeMethod} (SABR)`;
        this.activeVideoId = newVideoId;
        this.stopAndUnmute();
        report();
      } else {
        status.activeAudioItag = 251;
        status.activeMethod = 'original';
        status.fallbackReason = 'Using best original stream (ITAG 251)';
        status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
        this.activeVideoId = newVideoId;
        this.stopAndUnmute();
        report();
      }
      this.activeVideoId = newVideoId;
      this.loadingVideoId = null;
    },

    setVolume(val) {
      this.volume = Math.max(0, Math.min(3.0, val));
      localStorage.setItem('ytss_boost_volume', this.volume.toString());
      if (this.gainNode) {
        this.gainNode.gain.value = this.volume;
      }
      if (this.element) {
        this.element.volume = Math.min(1.0, this.volume);
      }
      status.shadowVolume = this.volume;
      report();
      this.updateVolumeUI();
    },

    getVolume() {
      return this.volume;
    },

    injectVolumeUI() {
      const rightControls = document.querySelector('.ytp-right-controls') || document.querySelector('.ytp-left-controls');
      if (!rightControls) return;

      let container = document.getElementById('ytss-vol-container');
      if (!container || !rightControls.contains(container)) {
        if (!container) {
          container = document.createElement('div');
          container.id = 'ytss-vol-container';
          container.className = 'ytp-button';
          container.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; position: relative; margin: 0 4px; vertical-align: top; cursor: pointer; user-select: none; z-index: 999;';

          const badge = document.createElement('div');
          badge.id = 'ytss-badge';
          badge.style.cssText = 'font-size: 11px; font-weight: 700; color: #ff334b; background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 4px; border: 1px solid #ff334b; white-space: nowrap;';
          badge.textContent = '251';
          container.appendChild(badge);

          const panel = document.createElement('div');
          panel.id = 'ytss-vol-panel';
          panel.style.cssText = 'display: none; position: absolute; bottom: 42px; left: 50%; transform: translateX(-50%); background: rgba(28,28,28,0.95); border: 1px solid #444; border-radius: 8px; padding: 8px 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); flex-direction: column; align-items: center; gap: 6px; width: 140px;';

          const title = document.createElement('div');
          title.style.cssText = 'font-size: 11px; color: #fff; font-weight: 600;';
          title.textContent = 'Volume Boost: ';
          const valSpan = document.createElement('span');
          valSpan.id = 'ytss-vol-val';
          valSpan.textContent = `${Math.round(this.volume * 100)}%`;
          title.appendChild(valSpan);
          panel.appendChild(title);

          const slider = document.createElement('input');
          slider.type = 'range';
          slider.id = 'ytss-vol-slider';
          slider.min = '0';
          slider.max = '200';
          slider.value = `${Math.round(this.volume * 100)}`;
          slider.style.cssText = 'width: 100%; cursor: pointer; accent-color: #ff0033;';
          slider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10) / 100;
            this.setVolume(val);
          });
          panel.appendChild(slider);

          const sub = document.createElement('div');
          sub.id = 'ytss-sub-info';
          sub.style.cssText = 'font-size: 9px; color: #aaa; text-align: center;';
          panel.appendChild(sub);

          container.appendChild(panel);

          container.addEventListener('mouseenter', () => {
            panel.style.display = 'flex';
            this.updateBadgeUI();
          });

          container.addEventListener('mouseleave', () => {
            panel.style.display = 'none';
          });
        }

        rightControls.insertBefore(container, rightControls.firstChild);
      }

      this.updateBadgeUI();
    },

    updateVolumeUI() {
      const valText = document.getElementById('ytss-vol-val');
      const slider = document.getElementById('ytss-vol-slider');
      const pct = Math.round(this.volume * 100);
      if (valText) valText.textContent = `${pct}%`;
      if (slider) slider.value = pct;
      this.updateBadgeUI();
    },

    updateBadgeUI() {
      const badge = document.getElementById('ytss-badge');
      if (!badge) return;

      const isReal774 = (Number(status.activeAudioItag) === 774) && !status.fallbackReason;

      if (isReal774) {
        badge.textContent = '★ 774';
        badge.style.color = '#ff334b';
        badge.style.borderColor = '#ff334b';
        badge.title = 'Real Opus 774 (276k+ Full Frequency Spectrum)';
      } else {
        badge.textContent = '251';
        badge.style.color = '#aaa';
        badge.style.borderColor = '#555';
        badge.title = 'Native Audio (ITAG 251)';
      }

      const sub = document.getElementById('ytss-sub-info');
      if (sub) {
        sub.textContent = isReal774
          ? 'Real ITAG 774 Playing'
          : 'Native Audio (ITAG 251)';
      }
    }
  };

  // Initialize Engines & UI Hooks
  StatsForNerdsSpoofer.init();
  SeparateAudioEngine.injectVolumeUI();
  window.__ytssUpdateBadge = () => SeparateAudioEngine.updateBadgeUI();

  ['DOMContentLoaded', 'yt-navigate-finish', 'yt-page-data-updated'].forEach(evt => {
    document.addEventListener(evt, () => {
      StatsForNerdsSpoofer.init();
      SeparateAudioEngine.init();
      SeparateAudioEngine.injectVolumeUI();
    });
  });

  setInterval(() => {
    SeparateAudioEngine.injectVolumeUI();
  }, 1500);

  // ═══════════════════════════════════════════════════════════════════
  // INTERCEPTORS — fetch & XHR (response-only, no request modification)
  // ═══════════════════════════════════════════════════════════════════
  window.fetch = async function (...args) {
    let url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (window.__ytssSabrProbes === undefined) window.__ytssSabrProbes = 0;

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
      } catch (e) { }

      const response = await ORIGINAL_FETCH.apply(this, args);
      if (!S.enabled) return response;

      try {
        const clone = response.clone();
        const json = await clone.json();
        const videoId = json.videoDetails?.videoId;
        const cached = videoId ? cacheGet(videoId) : null;
        const isCurrentActive = isCurrentWatchVideo(videoId);

        if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
          // Cache HIT: inject HQ immediately, zero latency
          const modified = processPlayerResponse(json, cached);
          // This response *is* the upgrade, so nothing is left to reload.
          reloadedVideos.add(videoId);

          if (isCurrentActive) {
            const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
            const real774Candidates = getAll774Candidates(formats);
            const tv774 = formats.find(f => (f.itag === 774 || f._origItag === 774));
            if (real774Candidates.length > 0) {
              const best = real774Candidates[0];
              const itag = best._origItag || best.itag || 774;
              status.activeAudioItag = itag;
              status.activeMethod = best._src || 'WEB_REMIX';
              status.fallbackReason = null;
              status.bestAudioInfo = `ITAG ${itag} [HQ ★] | Opus ${Math.round((best.bitrate || 280000) / 1000)}kbps | Method: ${status.activeMethod}`;
              SeparateAudioEngine.loadReal774(videoId, real774Candidates);
              report();
            } else if (tv774) {
              status.activeAudioItag = 774;
              status.activeMethod = tv774._src || 'TVHTML5';
              status.fallbackReason = null;
              status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${Math.round((tv774.bitrate || 274000) / 1000)}kbps | Method: ${status.activeMethod} (SABR)`;
              SeparateAudioEngine.stopAndUnmute();
              report();
            } else {
              status.activeAudioItag = 251;
              status.activeMethod = 'original';
              status.fallbackReason = 'Using best original stream (ITAG 251)';
              status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
              SeparateAudioEngine.stopAndUnmute();
              report();
            }
          }

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
          fetchAllHQAudio(videoId).then(hqData => {
            const hasFormats = hqData && (hqData.formats?.length > 0 || hqData.length > 0 || hqData.streamingContext);
            if (hasFormats) {
              const isWatch = location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts') || location.pathname.startsWith('/live') || location.pathname.startsWith('/tv') || isMusicSite;

              if (isWatch && isCurrentWatchVideo(videoId)) {
                const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
                const real774Candidates = getAll774Candidates(formats);
                const tv774 = formats.find(f => (f.itag === 774 || f._origItag === 774));
                if (real774Candidates.length > 0) {
                  const best = real774Candidates[0];
                  const itag = best._origItag || best.itag || 774;
                  status.activeAudioItag = itag;
                  status.activeMethod = best._src || 'WEB_REMIX';
                  status.fallbackReason = null;
                  status.bestAudioInfo = `ITAG ${itag} [HQ ★] | Opus ${Math.round((best.bitrate || 280000) / 1000)}kbps | Method: ${status.activeMethod}`;
                  SeparateAudioEngine.loadReal774(videoId, real774Candidates);
                  report();
                } else if (tv774) {
                  status.activeAudioItag = 774;
                  status.activeMethod = tv774._src || 'TVHTML5';
                  status.fallbackReason = null;
                  status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${Math.round((tv774.bitrate || 274000) / 1000)}kbps | Method: ${status.activeMethod} (SABR)`;
                  SeparateAudioEngine.stopAndUnmute();
                  report();
                } else {
                  status.activeAudioItag = 251;
                  status.activeMethod = 'original';
                  status.fallbackReason = 'Using best original stream (ITAG 251)';
                  status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
                  SeparateAudioEngine.stopAndUnmute();
                  report();
                }
                if (!isMusicSite) {
                  console.log(TAG, `[FetchIntercept] Background HQ fetch done, reloading player...`);
                }
                forcePlayerReload(videoId, hqData);
              }
            }
          }).catch(() => { });

          // ── Phase 1 (Option D) probe: query TV streaming context in parallel.
          //    This is read-only — just logs what TVHTML5 returned so we can
          //    confirm serverAbrStreamingUrl + ustreamerConfig are captured
          //    before investing in Phase 2 (SABR POST against TV URL).
          if (window.__ytssTvCtxProbes === undefined) window.__ytssTvCtxProbes = 0;
          if (window.__ytssTvCtxProbes < 3) {
            window.__ytssTvCtxProbes++;
            getTvContext(videoId).then(ctx => {
              if (ctx) {
                console.log(TAG, `[Phase1] TV context for ${videoId}:`, {
                  sabrUrl: ctx.serverAbrStreamingUrl ? ctx.serverAbrStreamingUrl.slice(0, 100) + '...' : null,
                  ustreamerConfig: ctx.ustreamerConfig ? (typeof ctx.ustreamerConfig === 'string' ? `str(${ctx.ustreamerConfig.length} chars)` : `obj(${Object.keys(ctx.ustreamerConfig).join(',')})`) : null,
                  poToken: ctx.poToken ? 'present' : 'absent',
                  visitorData: ctx.visitorData ? `${ctx.visitorData.slice(0, 16)}...` : null,
                  sts: ctx.sts,
                  source: ctx.source,
                  clientVersion: ctx.clientVersion,
                });
              } else {
                console.log(TAG, `[Phase1] No TV context for ${videoId} — TVHTML5 may not be logged in, or didn't return SABR`);
              }
            }).catch(() => { });
          }
        }

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

    // ── SABR/UMP request-body probe (read-only) ───────────────────────────
    // The desktop player no longer receives stream URLs at all: on /watch every
    // adaptiveFormat comes back `url:false, cipher:false` with serverAbrStreamingUrl
    // set, so playback is negotiated entirely inside this POST body. Nothing we put
    // in adaptiveFormats can change what gets served unless it changes these bytes.
    //
    // Before attempting that, establish what is actually in here. This only reads:
    // the body is cloned via the ArrayBuffer we were handed, never modified, and
    // never re-attached to the request.
    //
    // What matters is whether the varint for the requested format id is present and
    // whether it tracks status.activeAudioItag. 251 encodes as a varint to FB 01,
    // 774 to 86 06, 140 to 8C 01, 141 to 8D 01 — so a hex dump plus a scan for those
    // pairs answers "does the player ask for what we injected?" directly.
    // ── Option C: SABR body field-16 rewrite (251 → 774) ─────────────────
    if (url.includes('googlevideo.com/videoplayback')
      && (args[1]?.method === 'POST' || args[0]?.method === 'POST')) {
      try {
        let bodyBytes = null;
        let attachTo = null;
        const init = args[1];
        const rawBody = init && init.body;
        if (rawBody instanceof ArrayBuffer) {
          bodyBytes = new Uint8Array(rawBody.slice(0));
          attachTo = 'init';
        } else if (ArrayBuffer.isView(rawBody)) {
          bodyBytes = new Uint8Array(rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength));
          attachTo = 'init';
        } else if (typeof rawBody === 'string') {
          bodyBytes = new TextEncoder().encode(rawBody);
          attachTo = 'init';
        } else if (args[0] && typeof args[0] === 'object' && typeof args[0].clone === 'function') {
          const buf = await args[0].clone().arrayBuffer();
          bodyBytes = new Uint8Array(buf);
          attachTo = 'request';
        }

        let targetLastModified = null;
        const vid = typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null;
        if (vid) {
          const cached = cacheGet(vid);
          const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
          const f774 = formats.find(f => Number(f.itag) === 774 || Number(f._origItag) === 774);
          if (f774 && f774.lastModified) targetLastModified = String(f774.lastModified);
        }

        if (bodyBytes && targetLastModified) {
          const patched = sabrRewritePreferredAudio(bodyBytes, 251, 774, targetLastModified);
          if (patched) {
            const patchedBuffer = patched.buffer.slice(patched.byteOffset, patched.byteOffset + patched.byteLength);
            if (attachTo === 'init') {
              args[1].body = patchedBuffer;
            } else if (attachTo === 'request') {
              const origReq = args[0];
              args[0] = new Request(origReq.url, {
                method: origReq.method,
                headers: origReq.headers,
                body: patchedBuffer,
                credentials: origReq.credentials,
                mode: origReq.mode,
                cache: origReq.cache,
                redirect: origReq.redirect,
                referrer: origReq.referrer,
                referrerPolicy: origReq.referrerPolicy,
                integrity: origReq.integrity,
              });
            }
            if (status.activeAudioItag !== 774) {
              status.activeAudioItag = 774;
              status.activeMethod = 'TVHTML5';
              status.fallbackReason = null;
              status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus 274kbps | Method: TVHTML5 (SABR)`;
              report();
              console.log(TAG, `[OptionC] Rewrote SABR f16/f2: 251→774, lastModified=${targetLastModified}`);
            }
          }
        }
      } catch (e) { }
    }

    // ── Download-URL capture (read-only) ──────────────────────────────────
    if (url.includes('googlevideo.com/videoplayback')) {
      try {
        const dUrl = new URL(url);
        const reqItags = dUrl.searchParams.getAll('itag').map(Number);
        const pathMatch = dUrl.pathname.match(/\/itag\/(\d+)/);
        if (pathMatch) reqItags.push(Number(pathMatch[1]));

        const activeItag = Number(status.activeAudioItag);

        let isMatch = reqItags.includes(activeItag);
        if (!isMatch) {
          if (activeItag === 774 && reqItags.includes(251)) isMatch = true;
          if (activeItag === 141 && reqItags.includes(140)) isMatch = true;
        }

        if (isMatch) {
          const clen = status.contentLength || url.match(/[\?&]clen=(\d+)/)?.[1] || '999999999';
          let dlUrl = url;
          if (dlUrl.includes('range=')) {
            dlUrl = dlUrl.replace(/([\?&])range=[^&]*/, `$1range=0-${clen}`);
          } else {
            dlUrl += `&range=0-${clen}`;
          }

          if (status.downloadUrl !== dlUrl) {
            status.downloadUrl = dlUrl;
            report();
          }
        }
      } catch (e) { }
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

    const finalResponse = await ORIGINAL_FETCH.apply(this, args);
    if (url.includes('googlevideo.com/videoplayback') && (finalResponse.status === 403 || finalResponse.status === 401)) {
      const urlObj = new URL(url);
      let failedItag = urlObj.searchParams.get('itag');
      if (!failedItag) {
        const match = urlObj.pathname.match(/\/itag\/(\d+)/);
        if (match) failedItag = match[1];
      }
      if (failedItag && Number(failedItag) === Number(status.activeAudioItag)) {
        console.warn(TAG, `[REASON_4] [Fallback] Player got HTTP ${finalResponse.status} for injected ITAG ${failedItag}. Player is falling back to original!`);
        status.fallbackReason = `Player fallback (HTTP ${finalResponse.status})`;
        report();
      }
    }
    return finalResponse;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
      try {
        // Read-only. The `_ytss_*` param rewrite that used to run here corrupted
        // the signed URL — see the ITAG disguise comment in processPlayerResponse.
        // `dUrl` is only ever read from, never re-serialized back onto `url`.
        const dUrl = new URL(url);
        const reqItags = dUrl.searchParams.getAll('itag').map(Number);
        const pathMatch = dUrl.pathname.match(/\/itag\/(\d+)/);
        if (pathMatch) reqItags.push(Number(pathMatch[1]));

        const activeItag = Number(status.activeAudioItag);

        let isMatch = reqItags.includes(activeItag);
        if (!isMatch) {
          if (activeItag === 774 && reqItags.includes(251)) isMatch = true;
          if (activeItag === 141 && reqItags.includes(140)) isMatch = true;
        }

        if (isMatch) {
          const clen = status.contentLength || url.match(/[\?&]clen=(\d+)/)?.[1] || '999999999';
          let dlUrl = url;
          if (dlUrl.includes('range=')) {
            dlUrl = dlUrl.replace(/([\?&])range=[^&]*/, `$1range=0-${clen}`);
          } else {
            dlUrl += `&range=0-${clen}`;
          }

          console.log(TAG, `[XHRCapture] Captured download URL for itag ${activeItag}:`, dlUrl);
          if (status.downloadUrl !== dlUrl) {
            status.downloadUrl = dlUrl;
            report();
          }
        } else {
          console.log(TAG, `[XHRCapture] Unmatched videoplayback: reqItags=${reqItags}, activeItag=${activeItag} | URL:`, url);
        }
      } catch (e) {
        console.error(TAG, `[XHRCapture] Error:`, e);
      }
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
            const json = JSON.parse(self.responseText);
            const videoId = json.videoDetails?.videoId;
            const cached = videoId ? cacheGet(videoId) : null;
            const isCurrentActive = isCurrentWatchVideo(videoId);

            if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
              const modified = isCurrentActive ? processPlayerResponse(json, cached) : json;
              Object.defineProperty(self, 'responseText', { value: JSON.stringify(modified), configurable: true });
              Object.defineProperty(self, 'response', { value: JSON.stringify(modified), configurable: true });
              reloadedVideos.add(videoId);

              if (isCurrentActive) {
                const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
                const real774Candidates = getAll774Candidates(formats);
                const tv774 = formats.find(f => (f.itag === 774 || f._origItag === 774));
                if (real774Candidates.length > 0) {
                  const best = real774Candidates[0];
                  const itag = best._origItag || best.itag || 774;
                  status.activeAudioItag = itag;
                  status.activeMethod = best._src || 'WEB_REMIX';
                  status.fallbackReason = null;
                  status.bestAudioInfo = `ITAG ${itag} [HQ ★] | Opus ${Math.round((best.bitrate || 280000) / 1000)}kbps | Method: ${status.activeMethod}`;
                  SeparateAudioEngine.loadReal774(videoId, real774Candidates);
                  report();
                } else if (tv774) {
                  status.activeAudioItag = 774;
                  status.activeMethod = tv774._src || 'TVHTML5';
                  status.fallbackReason = null;
                  status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${Math.round((tv774.bitrate || 274000) / 1000)}kbps | Method: ${status.activeMethod} (SABR)`;
                  SeparateAudioEngine.stopAndUnmute();
                  report();
                } else {
                  status.activeAudioItag = 251;
                  status.activeMethod = 'original';
                  status.fallbackReason = 'Using best original stream (ITAG 251)';
                  status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
                  SeparateAudioEngine.stopAndUnmute();
                  report();
                }
              }
            } else if (S.hqFetch && videoId) {
              // Cache miss: fetch in background and reload once ready.
              fetchAllHQAudio(videoId).then(hqData => {
                const hasFormats = hqData && (hqData.formats?.length > 0 || hqData.length > 0 || hqData.streamingContext);
                if (hasFormats) {
                  const isWatch = location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts') || location.pathname.startsWith('/live') || location.pathname.startsWith('/tv') || isMusicSite;

                  if (isWatch && isCurrentWatchVideo(videoId)) {
                    const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
                    const real774Candidates = getAll774Candidates(formats);
                    const tv774 = formats.find(f => (f.itag === 774 || f._origItag === 774));
                    if (real774Candidates.length > 0) {
                      const best = real774Candidates[0];
                      const itag = best._origItag || best.itag || 774;
                      status.activeAudioItag = itag;
                      status.activeMethod = best._src || 'WEB_REMIX';
                      status.fallbackReason = null;
                      status.bestAudioInfo = `ITAG ${itag} [HQ ★] | Opus ${Math.round((best.bitrate || 280000) / 1000)}kbps | Method: ${status.activeMethod}`;
                      SeparateAudioEngine.loadReal774(videoId, real774Candidates);
                      report();
                    } else if (tv774) {
                      status.activeAudioItag = 774;
                      status.activeMethod = tv774._src || 'TVHTML5';
                      status.fallbackReason = null;
                      status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${Math.round((tv774.bitrate || 274000) / 1000)}kbps | Method: ${status.activeMethod} (SABR)`;
                      SeparateAudioEngine.stopAndUnmute();
                      report();
                    } else {
                      status.activeAudioItag = 251;
                      status.activeMethod = 'original';
                      status.fallbackReason = 'Using best original stream (ITAG 251)';
                      status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
                      SeparateAudioEngine.stopAndUnmute();
                      report();
                    }
                    if (!isMusicSite) {
                      console.log(TAG, `[FetchIntercept] Background HQ fetch done, reloading player...`);
                    }
                    forcePlayerReload(videoId, hqData);
                  }
                }
              }).catch(() => { });
            }
          } catch (e) { }
        }
        if (origHandler) origHandler.apply(self, arguments);
      };
    } else if (url && typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
      const self = this;
      const origHandler = this.onreadystatechange;
      this.onreadystatechange = function () {
        if (self.readyState === 4 && (self.status === 403 || self.status === 401)) {
          try {
            const urlObj = new URL(self._ytssUrl);
            let failedItag = urlObj.searchParams.get('itag');
            if (!failedItag) {
              const match = urlObj.pathname.match(/\/itag\/(\d+)/);
              if (match) failedItag = match[1];
            }
            if (failedItag && Number(failedItag) === Number(status.activeAudioItag)) {
              console.warn(TAG, `[Fallback] Player got HTTP ${self.status} for injected ITAG ${failedItag} via XHR. Player is falling back to original!`);
              status.fallbackReason = `Player fallback (HTTP ${self.status})`;
              report();
            }
          } catch (e) { }
        }
        if (origHandler) origHandler.apply(self, arguments);
      };
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  // ─── EXPOSE API TO POPUP ──────────────────────────────────────────
  window.YTSS_SpoofingMethods = {
    getStatus: () => ({ ...status, settings: { ...S } }),
    getNativeBooster: () => NativeAudioBooster,
    setShadowVolume: (v) => NativeAudioBooster.setVolume(v),
    applySettings: (newSettings) => {
      Object.assign(S, pickSettings(newSettings));
      persistSettings();
      if (newSettings.shadowVolume !== undefined) {
        NativeAudioBooster.setVolume(newSettings.shadowVolume);
      }
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
      try {
        for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
          const key = window.sessionStorage.key(i);
          if (key && key.startsWith('ytss_hq_')) window.sessionStorage.removeItem(key);
        }
      } catch (e) { }
    }
  };

  console.log(TAG, 'Injected — Pre-warm + ytplayer.config + ITAG disguise + ForceReload active');
})();
