// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — YTM Harvester Content Script (MAIN world)     ║
// ║  Harvests direct HQ formats from YouTube Music player session     ║
// ╚══════════════════════════════════════════════════════════════════╝

(function() {
  'use strict';
  
  // Only activate if we are inside a subframe (harvester iframe)
  const isFramed = window.self !== window.top;
  if (!isFramed) return;

  const TAG = '[YTM-Harvester]';
  const urlVid = new URLSearchParams(location.search).get('v');
  console.log(TAG, `Active inside YTM harvester frame. Target videoId: ${urlVid}, URL: ${location.href}`);

  let isAborted = false;

  function notifyAbort(reason) {
    if (isAborted) return;
    isAborted = true;
    console.warn(TAG, `[ABORT] Harvest aborted for ${urlVid}: ${reason}`);
    try {
      window.parent.postMessage({
        type: 'HARVEST_ABORT',
        videoId: urlVid,
        reason
      }, '*');
    } catch (e) {}

    // Stop all media playback immediately
    const video = document.querySelector('video');
    if (video) {
      video.pause();
      video.src = '';
    }
    const moviePlayer = document.getElementById('movie_player');
    if (moviePlayer) {
      try {
        moviePlayer.pauseVideo?.();
        moviePlayer.stopVideo?.();
      } catch (e) {}
    }
  }

  let cached774Metadata = null;

  function filterAndPrioritize774(json) {
    if (!json?.streamingData?.adaptiveFormats) return json;
    const af = json.streamingData.adaptiveFormats;

    // Strict 774 requirement:
    const target774 = af.find(f => f.itag === 774);
    if (target774) {
      console.log(TAG, `★ Genuine ITAG 774 found for ${urlVid}! Locking audio formats strictly to 774`);
      cached774Metadata = {
        bitrate: target774.bitrate,
        averageBitrate: target774.averageBitrate,
        contentLength: target774.contentLength,
        approxDurationMs: target774.approxDurationMs,
        audioSampleRate: target774.audioSampleRate
      };
      // Keep only 774 for audio, stripping all lower formats (251, 250, 249, 140, 141)
      json.streamingData.adaptiveFormats = af.filter(f => f.itag === 774 || !f.mimeType?.includes('audio/'));
      return json;
    }

    // No 774 stream available for this video -> Abort harvest and let native audio play
    console.warn(TAG, `Video ${urlVid} has NO ITAG 774 stream. Aborting harvest.`);
    notifyAbort('NO_774_STREAM');
    json.streamingData = null;
    return json;
  }

  function validatePlayerResponse(json) {
    if (!json) return false;
    const videoId = json.videoDetails?.videoId;

    if (json.playabilityStatus?.status && json.playabilityStatus.status !== 'OK') {
      const reason = json.playabilityStatus.reason || json.playabilityStatus.status;
      console.warn(TAG, `Track ${urlVid} is UNPLAYABLE on YTM (${reason}). Cancelling.`);
      notifyAbort(`UNPLAYABLE: ${reason}`);
      return false;
    }

    // STRICT CHECK: Verify videoId matches urlVid EXACTLY.
    // YouTube Music auto-skips to similar tracks on unavailable videos. We must BLOCK this!
    if (videoId && urlVid && videoId !== urlVid) {
      console.warn(TAG, `YTM attempted to substitute ${urlVid} with different track ${videoId}! BLOCKING.`);
      notifyAbort(`TRACK_MISMATCH: YTM skipped to ${videoId}`);
      return false;
    }

    return true;
  }

  // 1. Hook ytInitialPlayerResponse
  let initial = window.ytInitialPlayerResponse;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    get() { return initial; },
    set(v) {
      if (!v) {
        initial = v;
        return;
      }
      const vid = v.videoDetails?.videoId;
      if (vid && urlVid && vid !== urlVid) {
        // Stale initial hydration data (YTM template). Neutralize streamingData without aborting,
        // so YTM can proceed to fetch the actual target video (urlVid).
        console.log(TAG, `Ignoring stale hydration track ${vid} (waiting for ${urlVid})`);
        if (v.streamingData) v.streamingData = null;
        initial = v;
        return;
      }
      if (!validatePlayerResponse(v)) {
        if (v && v.streamingData) v.streamingData = null;
        initial = v;
        return;
      }
      initial = filterAndPrioritize774(v);
    },
    configurable: true
  });

  function haltPlayback() {
    try {
      const moviePlayer = document.getElementById('movie_player');
      if (moviePlayer) {
        moviePlayer.pauseVideo?.();
        moviePlayer.stopVideo?.();
        moviePlayer.clearVideo?.();
      }
      const mediaElements = document.querySelectorAll('video, audio');
      mediaElements.forEach(el => {
        try {
          el.pause();
          el.removeAttribute('src');
          el.src = '';
          el.load?.();
        } catch (e) {}
      });
    } catch (e) {}
  }

  function cleanStreamUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    try {
      const u = new URL(rawUrl);
      u.searchParams.delete('range');
      u.searchParams.delete('rn');
      u.searchParams.delete('rbuf');
      u.searchParams.delete('ump');
      u.searchParams.delete('sabr');
      u.searchParams.delete('alr');
      u.searchParams.delete('sq');
      return u.toString();
    } catch (e) {
      return rawUrl
        .replace(/[?&]range=[^&]*/g, '')
        .replace(/[?&]rn=[^&]*/g, '')
        .replace(/[?&]rbuf=[^&]*/g, '')
        .replace(/[?&]ump=[^&]*/g, '')
        .replace(/[?&]sabr=[^&]*/g, '')
        .replace(/[?&]alr=[^&]*/g, '')
        .replace(/[?&]sq=[^&]*/g, '');
    }
  }

  function notify774Found(streamUrl) {
    if (isAborted || !streamUrl || !urlVid) return;

    try {
      const u = new URL(streamUrl);
      const docid = u.searchParams.get('docid');
      if (docid && urlVid && docid !== urlVid) {
        console.warn(TAG, `Ignored ITAG 774 stream for mismatched track docid=${docid} (expected ${urlVid})`);
        return;
      }
    } catch (e) {}

    isAborted = true;
    clearInterval(pollInterval);
    haltPlayback();

    const cleanUrl = cleanStreamUrl(streamUrl);
    console.log(TAG, `[DirectCapture] Found deciphered 774 URL for ${urlVid}`);
    try {
      window.parent.postMessage({
        type: 'HARVEST_774_URL',
        videoId: urlVid,
        url: cleanUrl,
        bitrate: cached774Metadata?.bitrate,
        averageBitrate: cached774Metadata?.averageBitrate,
        contentLength: cached774Metadata?.contentLength,
        approxDurationMs: cached774Metadata?.approxDurationMs
      }, '*');
    } catch (e) {}
  }

  // Intercept navigator.sendBeacon to swallow telemetry pings that trigger concurrent stream limits
  try {
    const origBeacon = navigator.sendBeacon;
    if (origBeacon) {
      navigator.sendBeacon = function(url, data) {
        if (typeof url === 'string' && (url.includes('/api/stats/') || url.includes('/playback/'))) {
          return true;
        }
        return origBeacon.call(this, url, data);
      };
    }
  } catch (e) {}

  // Hook HTMLMediaElement src setter
  try {
    const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (origSrcDesc && origSrcDesc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get() { return origSrcDesc.get.call(this); },
        set(val) {
          if (typeof val === 'string' && val.includes('videoplayback') && val.includes('itag=774')) {
            notify774Found(val);
          }
          return origSrcDesc.set.call(this, val);
        },
        configurable: true
      });
    }
  } catch (e) {}

  // Hook XMLHttpRequest: capture 774 and drop telemetry requests
  try {
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._ytssUrl = url;
      if (typeof url === 'string') {
        if (url.includes('videoplayback') && url.includes('itag=774')) {
          notify774Found(url);
        }
        if (url.includes('/api/stats/') || url.includes('/playback/')) {
          this._ytssBlockedTelemetry = true;
        }
      }
      return origXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      if (this._ytssBlockedTelemetry) {
        try {
          Object.defineProperty(this, 'status', { value: 204, configurable: true });
          Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
        } catch (e) {}
        setTimeout(() => {
          this.dispatchEvent(new Event('readystatechange'));
          this.dispatchEvent(new Event('load'));
        }, 10);
        return;
      }
      return origXhrSend.apply(this, args);
    };
  } catch (e) {}

  // 2. Hook fetch for async player requests, videoplayback, and swallow telemetry
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (typeof url === 'string') {
      if (url.includes('videoplayback') && url.includes('itag=774')) {
        notify774Found(url);
      }
      if (url.includes('/api/stats/') || url.includes('/playback/')) {
        // Drop stats/watchtime/heartbeat pings that trigger concurrent stream limits (TOO_MANY_STREAMS_PER_USER)
        return new Response('', { status: 204 });
      }
    }
    const res = await origFetch.apply(this, args);
    if (typeof url === 'string' && url.includes('/player') && url.includes('youtubei/v1')) {
      try {
        const json = await res.clone().json();
        if (!validatePlayerResponse(json)) {
          return new Response(JSON.stringify({
            playabilityStatus: { status: 'UNPLAYABLE', reason: 'Blocked track mismatch by YTSpoofingStream' }
          }), {
            status: 200,
            headers: res.headers
          });
        }
        const modified = filterAndPrioritize774(json);
        return new Response(JSON.stringify(modified), {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers
        });
      } catch (e) {}
    }
    return res;
  };

  // 3. Auto-play muted to prompt player engine to decipher stream & trigger requests
  function autoPlayMuted() {
    if (isAborted) return;
    const video = document.querySelector('video');
    if (video) {
      video.muted = true;
      video.volume = 0;
      video.play().catch(() => {});
    }
    const moviePlayer = document.getElementById('movie_player');
    if (moviePlayer && moviePlayer.playVideo) {
      try {
        moviePlayer.mute?.();
        moviePlayer.playVideo();
      } catch (e) {}
    }
  }

  const pollInterval = setInterval(() => {
    if (isAborted) {
      clearInterval(pollInterval);
      return;
    }
    autoPlayMuted();
  }, 250);
  setTimeout(() => {
    clearInterval(pollInterval);
    if (!isAborted) haltPlayback();
  }, 8000);
})();
