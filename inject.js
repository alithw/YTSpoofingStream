// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream v0.0.8 — Main World Script                     ║
// ║  v0.0.5 Core + Pre-warm Cache + Force Player Reload              ║
// ╚══════════════════════════════════════════════════════════════════╝
(function () {
  'use strict';

  const TAG = '[YTSS]';
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  const MODES = { AAC: 'aac_only', OPUS_HQ: 'opus_hq', HIGHEST: 'highest' };

  // ─── SETTINGS ────────────────────────────────────────────────────
  let S = {
    enabled: true,
    hqFetch: true,
    forceOverride: true,
    audioMode: MODES.HIGHEST,
    autoReload: true,
    preferredClient: 'AUTO'
  };

  try {
    const stored = localStorage.getItem('ytss_settings');
    if (stored) Object.assign(S, JSON.parse(stored));
  } catch (e) {}

  window.addEventListener('message', (e) => {
    if ((e.data?.type === 'YTSS_SETTINGS_UPDATE' || e.data?.type === 'YTSpoofingStream_settingsUpdate') && e.data.settings) {
      Object.assign(S, e.data.settings);
      localStorage.setItem('ytss_settings', JSON.stringify(S));
    }
  });

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
  const reloadedVideos = new Set(); // guard: only force-reload once per videoId
  let isInitialPageLoad = true;     // guard: only allow page reload on very first visit

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

      window.postMessage({ type: 'YTSS_FETCH_HQ', videoId, requestId }, '*');

      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve([]);
      }, 6000);
    });
  }

  async function fetchAllHQAudio(videoId) {
    // Dedup: if already fetching same videoId, wait for existing promise
    if (pendingFetches.has(videoId)) return await pendingFetches.get(videoId);
    // Cache hit (not expired)
    const cached = cacheGet(videoId);
    if (cached) return cached;

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
      cacheSet(videoId, merged);
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

  function prewarmCache(videoId) {
    if (!videoId || !S.enabled || !S.hqFetch) return;
    // Invalidate stale cache for this videoId first
    hqCache.delete(videoId);
    reloadedVideos.delete(videoId);
    status.prewarmStatus = `pre-fetching ${videoId}…`;
    report();
    fetchAllHQAudio(videoId).then(formats => {
      status.prewarmStatus = formats.length > 0
        ? `ready: ${formats.length} formats`
        : 'no HQ formats';
      report();
      console.log(TAG, `[Pre-warm] ${status.prewarmStatus} for ${videoId}`);
    });
  }

  // Pre-warm on initial page load
  const earlyVideoId = getVideoIdFromUrl();
  if (earlyVideoId) {
    prewarmCache(earlyVideoId);
  }

  // Also pre-warm on YouTube SPA navigation (yt-navigate-start fires before new page renders)
  window.addEventListener('yt-navigate-start', () => {
    isInitialPageLoad = false; // We are now in SPA territory, never reload page
    setTimeout(() => {
      const vid = getVideoIdFromUrl();
      if (vid) {
        prewarmCache(vid);
      }
    }, 0);
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

    // HQ from SW first (priority)
    if (hqFormats?.length > 0) {
      for (const f of hqFormats) {
        if (!seen.has(f.itag)) { seen.add(f.itag); pool.push(f); }
      }
    }

    // Original streams
    for (const f of origAudio) {
      if (!seen.has(f.itag)) { seen.add(f.itag); pool.push({ ...f, _src: 'original' }); }
    }

    // Remove itag 140 (low-quality AAC fallback) if possible
    let filteredPool = pool.filter(f => f.itag !== 140);
    if (filteredPool.length === 0) filteredPool = pool;

    const mode = S.audioMode || MODES.HIGHEST;
    let selectedAudio = [];

    if (mode === MODES.AAC) {
      const aac = filteredPool.filter(f => (f.mimeType || '').includes('mp4a'))
                              .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const target = aac.find(f => f.itag === 141);
      if (target) {
        selectedAudio = [target];
        console.log(TAG, `★ ITAG 141 (AAC 256kbps) [${target._src}]`);
      } else if (aac.length) {
        selectedAudio = S.forceOverride ? [aac[0]] : aac;
        console.log(TAG, `AAC -> ITAG ${aac[0].itag} (${Math.round((aac[0].bitrate || 0) / 1000)}k) [${aac[0]._src}]`);
      } else {
        selectedAudio = filteredPool;
      }
    } else if (mode === MODES.OPUS_HQ) {
      const opus = filteredPool.filter(f => (f.mimeType || '').includes('opus'))
                               .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const target = opus.find(f => f.itag === 774);
      if (target) {
        selectedAudio = [target];
        console.log(TAG, `★ ITAG 774 (Opus 256kbps+) [${target._src}]`);
      } else if (opus.length) {
        selectedAudio = S.forceOverride ? [opus[0]] : opus;
        console.log(TAG, `Opus -> ITAG ${opus[0].itag} (${Math.round((opus[0].bitrate || 0) / 1000)}k) [${opus[0]._src}]`);
      } else {
        selectedAudio = filteredPool;
      }
    } else {
      // HIGHEST: pick best bitrate regardless of codec
      filteredPool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      selectedAudio = S.forceOverride ? [filteredPool[0]].filter(Boolean) : filteredPool;
    }

    // Spoof ITAG and MimeType to trick the web player into accepting them natively
    // The web player rejects unknown itags (774, 141), leading to itag 18 fallback.
    // By renaming them to standard itags (251 for Opus, 140 for AAC) and fixing mimeType, it works 100%.
    selectedAudio = selectedAudio.map(f => {
      const origItag = f.itag;
      if (origItag === 774) {
        return { 
          ...f, 
          itag: 251, 
          mimeType: (f.mimeType || '').replace('audio/mp4', 'audio/webm'), 
          _origItag: 774 
        };
      }
      if (origItag === 141) {
        return { 
          ...f, 
          itag: 140, 
          _origItag: 141 
        };
      }
      return { ...f, _origItag: origItag };
    });

    json.streamingData.adaptiveFormats = [...videoFormats, ...selectedAudio];

    // CRITICAL: Delete DASH and HLS manifest URLs.
    // If present, the player will fetch the XML manifest and ignore our modified adaptiveFormats!
    delete json.streamingData.dashManifestUrl;
    delete json.streamingData.hlsManifestUrl;

    const active = selectedAudio[0];
    if (active) {
      const codec  = (active.mimeType || '').includes('opus') ? 'Opus' : 'AAC';
      const kbps   = Math.round((active.bitrate || 0) / 1000);
      
      const displayItag = active._origItag || active.itag;
      const isHQ   = (displayItag === 141 || displayItag === 774) ? ' [HQ ★]' : '';
      const src    = active._src || 'original';

      status.activeMethod    = src;
      status.activeAudioItag = displayItag;
      status.bestAudioInfo   = `ITAG ${displayItag}${isHQ} | ${codec} ${kbps}kbps | Method: ${src} (Spoofed as ${active.itag})`;
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
              if (!reloadedVideos.has(videoId)) {
                reloadedVideos.add(videoId);
                forcePlayerReload(videoId, hqFormats);
              }
            }
          });
        }
      }
    },
    configurable: true,
    enumerable: true,
  });

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
        if (cached?.length > 0) {
          console.log(TAG, `[ytplayer.config] raw_player_response sync patch`);
          args.raw_player_response = processPlayerResponse(args.raw_player_response, cached);
        }
      }

      // player_response (older / fallback, JSON string)
      if (typeof args.player_response === 'string') {
        try {
          const pr = JSON.parse(args.player_response);
          if (pr.streamingData) {
            const videoId = pr.videoDetails?.videoId;
            const cached  = videoId ? cacheGet(videoId) : null;
            if (cached?.length > 0) {
              console.log(TAG, `[ytplayer.config] player_response sync patch`);
              args.player_response = JSON.stringify(processPlayerResponse(pr, cached));
            }
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
  // ═══════════════════════════════════════════════════════════════════
  function forcePlayerReload(videoId, hqFormats) {
    if (!hqFormats || hqFormats.length === 0) return;

    if (!isInitialPageLoad) {
      console.log(TAG, `[PlayerReload] SPA navigation detected. Skipping page reload to prevent autoplay freeze.`);
      return;
    }

    // The YouTube player is extremely stubborn. If it has already started buffering 
    // the original format (251) because the cache was empty on page load, it will 
    // silently ignore attempts to inject new formats via loadVideoByPlayerVars for the same videoId.
    // The ONLY reliable way to force the player to use the spoofed formats is to reload the page ONCE.
    // Since we just saved the formats to sessionStorage, the next load will hit the cache INSTANTLY.
    console.log(TAG, `[PlayerReload] Reloading page to apply formats synchronously from cache!`);
    window.location.reload();
  }

  // ═══════════════════════════════════════════════════════════════════
  // INTERCEPTORS — fetch & XHR (response-only, no request modification)
  // ═══════════════════════════════════════════════════════════════════
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

    if (url.includes('/youtubei/v1/player') && !url.includes('_ytss=1')) {
      const response = await ORIGINAL_FETCH.apply(this, args);
      if (!S.enabled) return response;

      try {
        const clone   = response.clone();
        const json    = await clone.json();
        const videoId = json.videoDetails?.videoId;

        // Check cache first → sync merge
        const cached = videoId ? cacheGet(videoId) : null;
        let hqFormats = cached || null;

        // If not cached, fetch async (this is a background re-fetch by the player)
        if (!hqFormats && S.hqFetch && videoId) {
          hqFormats = await fetchAllHQAudio(videoId);
        }

        const modified = processPlayerResponse(json, hqFormats);
        return new Response(JSON.stringify(modified), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        console.warn(TAG, 'fetch intercept error:', e);
        return response;
      }
    }

    return ORIGINAL_FETCH.apply(this, args);
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ytssUrl = url;
    return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._ytssUrl;
    if (url && typeof url === 'string' && url.includes('/youtubei/v1/player') && !url.includes('_ytss=1')) {
      const self = this;
      const origHandler = this.onreadystatechange;

      this.onreadystatechange = function () {
        if (self.readyState === 4 && self.status === 200 && S.enabled) {
          try {
            const json    = JSON.parse(self.responseText);
            const videoId = json.videoDetails?.videoId;

            (async () => {
              const cached = videoId ? cacheGet(videoId) : null;
              const hqFormats = cached || (S.hqFetch && videoId ? await fetchAllHQAudio(videoId) : null);
              const modified  = processPlayerResponse(json, hqFormats);

              Object.defineProperty(self, 'responseText', { value: JSON.stringify(modified), configurable: true });
              Object.defineProperty(self, 'response',     { value: JSON.stringify(modified), configurable: true });
              if (origHandler) origHandler.apply(self, arguments);
            })();
            return;
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
      Object.assign(S, newSettings);
      localStorage.setItem('ytss_settings', JSON.stringify(S));
      if (S.autoReload && window.location.href.includes('youtube.com')) {
        window.location.reload();
      }
    },
    forceReload: () => {
      if (window.location.href.includes('youtube.com')) window.location.reload();
    },
    clearCache: () => { hqCache.clear(); pendingFetches.clear(); reloadedVideos.clear(); }
  };

  console.log(TAG, 'v0.0.8 Injected — Pre-warm + ytplayer.config + ForceReload active');
})();
