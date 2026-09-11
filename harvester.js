// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Offscreen Harvester (Mode 1 & Mode 4)        ║
// ║  Harvests direct HQ formats from YTM and UMP chunks from TV      ║
// ╚══════════════════════════════════════════════════════════════════╝

const TAG = '[YTSpoofHarvester]';

function teardownFrame() {
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach(iframe => {
    try { iframe.src = 'about:blank'; } catch (e) {}
    try { iframe.remove(); } catch (e) {}
  });
}
teardownFrame();

function createFrame() {
  teardownFrame();
  const iframe = document.createElement('iframe');
  iframe.id = 'harvesterFrame';
  iframe.setAttribute('allow', 'autoplay');
  iframe.style.cssText = 'position:absolute; top:-9999px; left:-9999px; width:640px; height:360px; border:none;';
  const root = document.body || document.documentElement;
  if (root) {
    root.appendChild(iframe);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      (document.body || document.documentElement)?.appendChild(iframe);
    }, { once: true });
  }
  return iframe;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_HARVEST_YTM') {
    const { videoId } = msg;
    const iframe = createFrame();
    console.log(TAG, `Loading clean YTM harvest session for ${videoId}...`);
    iframe.src = `https://music.youtube.com/watch?v=${videoId}`;
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP_HARVEST') {
    teardownFrame();
    sendResponse({ success: true });
    return true;
  }
});

window.addEventListener('message', (e) => {
  if (e.data?.type === 'HARVEST_774_URL') {
    console.log(TAG, `Iframe captured authentic 774 stream for ${e.data.videoId}`);
    teardownFrame();
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_HARVEST_SUCCESS',
      videoId: e.data.videoId,
      url: e.data.url,
      bitrate: e.data.bitrate,
      averageBitrate: e.data.averageBitrate,
      contentLength: e.data.contentLength,
      approxDurationMs: e.data.approxDurationMs
    }).catch(() => {});
    return;
  }

  if (e.data?.type === 'HARVEST_ABORT') {
    console.warn(TAG, `Iframe reported abort for ${e.data.videoId}: ${e.data.reason}`);
    teardownFrame();
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_HARVEST_ABORT',
      videoId: e.data.videoId,
      reason: e.data.reason
    }).catch(() => {});
    return;
  }
});

console.log(TAG, 'Offscreen Harvester initialized with strict DOM teardown.');
