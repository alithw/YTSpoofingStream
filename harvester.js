// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Offscreen Harvester (Mode 1 & Mode 4)         ║
// ║  Harvests direct HQ formats from YTM and UMP chunks from TV      ║
// ╚══════════════════════════════════════════════════════════════════╝

const TAG = '[YTSpoofHarvester]';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_HARVEST_YTM') {
    const { videoId } = msg;
    const iframe = document.getElementById('harvesterFrame');
    if (iframe) {
      console.log(TAG, `Loading YTM harvest session for ${videoId}...`);
      iframe.src = `https://music.youtube.com/watch?v=${videoId}`;
    }
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP_HARVEST') {
    const iframe = document.getElementById('harvesterFrame');
    if (iframe) {
      iframe.src = 'about:blank';
    }
    sendResponse({ success: true });
    return true;
  }
});

window.addEventListener('message', (e) => {
  if (e.data?.type === 'HARVEST_ABORT') {
    console.warn(TAG, `Iframe reported abort for ${e.data.videoId}: ${e.data.reason}`);
    const iframe = document.getElementById('harvesterFrame');
    if (iframe) {
      iframe.src = 'about:blank';
    }
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_HARVEST_ABORT',
      videoId: e.data.videoId,
      reason: e.data.reason
    }).catch(() => {});
  }
});

console.log(TAG, 'Offscreen Harvester initialized.');
