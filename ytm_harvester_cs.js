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

  function filterAndPrioritize774(json) {
    if (!json?.streamingData?.adaptiveFormats) return json;
    const af = json.streamingData.adaptiveFormats;

    // Strict 774 requirement:
    if (af.some(f => f.itag === 774)) {
      console.log(TAG, `★ Genuine ITAG 774 found for ${urlVid}! Locking audio formats strictly to 774`);
      // Keep only 774 for audio, stripping all lower formats (251, 250, 249, 140, 141)
      json.streamingData.adaptiveFormats = af.filter(f => f.itag === 774 || !f.mimeType?.includes('audio/'));
      return json;
    }

    // No 774 available for this video -> Abort! As requested: "k có luồng 774 thì hủy đi"
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

  // 2. Hook fetch for async player requests
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (url.includes('/player') && url.includes('youtubei/v1')) {
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
  setTimeout(() => clearInterval(pollInterval), 8000);
})();
