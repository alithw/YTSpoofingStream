// YTSpoofingStream v0.0.8 — Popup Controller (TV-First 774)
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const log = (msg) => {
    const el = $('#log');
    const ts = new Date().toLocaleTimeString();
    el.textContent = `[${ts}] ${msg}\n` + el.textContent;
  };

  // ─── SETTINGS ────────────────────────────────────────────────────
  const KEYS = {
    enabled: '#en',
    hqFetch: '#hq',
    forceOverride: '#fo',
    autoReload: '#ar',
  };

  let settings = {
    enabled: true,
    hqFetch: true,
    forceOverride: true,
    autoReload: true,
    audioMode: 'opus_hq',
    preferredClient: 'AUTO',
  };

  // Load from chrome.storage
  chrome.storage.local.get(null, (data) => {
    if (data && Object.keys(data).length > 0) {
      Object.assign(settings, data);
    } else {
      loadLegacy();
    }
    applyUI();
    log('Settings loaded. Mode: ' + settings.audioMode);
  });

  function loadLegacy() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => localStorage.getItem('ytss_settings'),
      }, (results) => {
        if (results?.[0]?.result) {
          try {
            Object.assign(settings, JSON.parse(results[0].result));
            chrome.storage.local.set(settings);
            applyUI();
          } catch (e) { }
        }
      });
    });
  }

  function applyUI() {
    for (const [key, sel] of Object.entries(KEYS)) {
      const el = $(sel);
      if (el) el.checked = !!settings[key];
    }
    if ($('#preferredClient')) {
      $('#preferredClient').value = settings.preferredClient || 'AUTO';
    }
    document.querySelectorAll('.mode').forEach(m => {
      m.classList.toggle('active', m.dataset.mode === settings.audioMode);
      const radio = m.querySelector('input');
      if (radio) radio.checked = m.dataset.mode === settings.audioMode;
    });
  }

  function save() {
    settings.enabled = $('#en').checked;
    settings.hqFetch = $('#hq').checked;
    settings.forceOverride = $('#fo').checked;
    settings.autoReload = $('#ar').checked;
    if ($('#preferredClient')) {
      settings.preferredClient = $('#preferredClient').value;
    }

    chrome.storage.local.set(settings);
    log(`Settings saved. Method: ${settings.preferredClient}, Mode: ${settings.audioMode}`);

    // Yêu cầu: YouTube page PHẢI refresh sau mỗi lần load config
    // Gửi settings đến content script và force reload
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;

      // Send settings to content script (inject.js) via messaging
      chrome.scripting.executeScript({
        target: { tabId },
        func: (s) => {
          localStorage.setItem('ytss_settings', JSON.stringify(s));
          localStorage.setItem('ytSpoofingStream_settings', JSON.stringify(s));
          window.postMessage({ type: 'YTSpoofingStream_settingsUpdate', settings: s }, '*');

          // YÊU CẦU: Force reload YouTube page để apply config mới
          if (s.autoReload && window.location.href.includes('youtube.com')) {
            window.location.reload();
          }
        },
        args: [settings],
      }, () => {
        if (settings.autoReload && /youtube\.com/.test(tabs[0].url || '')) {
          log('Config applied — reloading YouTube page...');
        }
      });
    });
  }

  // ─── TV OAUTH ──────────────────────────────────────────────────────
  function checkTvAuth() {
    chrome.runtime.sendMessage({ type: 'CHECK_TV_AUTH' }, (res) => {
      if (res && res.isAuth) {
        $('#tvAuthStatus').textContent = 'Status: Logged In (Ready for Premium 774)';
        $('#tvAuthStatus').style.color = 'var(--green)';
        $('#btnTvLogin').style.display = 'none';
        $('#btnTvLogout').style.display = 'block';
        $('#tvAuthCodeContainer').style.display = 'none';
      } else {
        $('#tvAuthStatus').textContent = 'Status: Not Logged In (Required for TVHTML5 774)';
        $('#tvAuthStatus').style.color = 'var(--dim)';
        $('#btnTvLogin').style.display = 'block';
        $('#btnTvLogout').style.display = 'none';
      }
    });
  }

  $('#btnTvLogin')?.addEventListener('click', () => {
    $('#btnTvLogin').disabled = true;
    $('#btnTvLogin').textContent = 'Loading...';

    chrome.runtime.sendMessage({ type: 'START_TV_AUTH' }, (res) => {
      $('#btnTvLogin').textContent = 'Login to TV';
      if (res && res.success && res.data) {
        const d = res.data;
        $('#tvAuthStatus').textContent = 'Status: Waiting for you to activate...';
        $('#tvAuthStatus').style.color = 'var(--gold)';

        $('#tvAuthCode').textContent = d.user_code;
        $('#tvAuthCodeContainer').style.display = 'block';

        // Setup polling in popup just to update UI when done
        const pollUI = setInterval(() => {
          chrome.runtime.sendMessage({ type: 'CHECK_TV_AUTH' }, (check) => {
            if (check && check.isAuth) {
              clearInterval(pollUI);
              checkTvAuth();
              log('TV Auth Successful! TVHTML5 774 ready.');
            }
          });
        }, 3000);
      } else {
        $('#btnTvLogin').disabled = false;
        $('#tvAuthStatus').textContent = 'Status: Error - ' + (res?.error || 'Unknown');
        $('#tvAuthStatus').style.color = 'var(--accent)';
      }
    });
  });

  $('#btnTvLogout')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'LOGOUT_TV' }, () => {
      checkTvAuth();
      $('#btnTvLogin').disabled = false;
      log('TV Auth Logged out. TVHTML5 774 unavailable.');
    });
  });

  checkTvAuth();

  // ─── EVENT LISTENERS ──────────────────────────────────────────────
  for (const sel of Object.values(KEYS)) {
    $(sel)?.addEventListener('change', save);
  }
  $('#preferredClient')?.addEventListener('change', save);

  document.querySelectorAll('.mode').forEach(m => {
    m.addEventListener('click', () => {
      settings.audioMode = m.dataset.mode;
      document.querySelectorAll('.mode').forEach(x => {
        x.classList.toggle('active', x === m);
        x.querySelector('input').checked = x === m;
      });
      save();
    });
  });

  $('#btnR')?.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.reload(tabs[0].id);
    });
    log('Page refreshed');
  });

  $('#btnL')?.addEventListener('click', () => {
    chrome.runtime.reload();
    log('Extension reloaded');
  });

  // ─── STATUS POLLING ───────────────────────────────────────────────
  function pollStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          try {
            return JSON.parse(localStorage.getItem('ytSpoofingStream_status') || '{}');
          } catch { return {}; }
        },
      }, (results) => {
        const d = results?.[0]?.result || {};

        // Status badge
        const badge = $('#stBadge');
        const text = $('#stText');
        if (d.activeMode) {
          badge.classList.remove('off');
          text.textContent = 'Active';
        } else {
          badge.classList.add('off');
          text.textContent = 'Inactive';
        }

        // SW status ping
        chrome.runtime.sendMessage({ type: 'SW_PING' }, (resp) => {
          const swEl = $('#swSt');
          if (resp && resp.ready) {
            swEl.textContent = `SW: v${resp.version} Active`;
            swEl.style.color = '#00c853';
          } else {
            swEl.textContent = 'SW: Offline (Reload required)';
            swEl.style.color = '#e94560';
          }
        });

        // Info
        const modeLabels = { aac_only: 'AAC Only (141)', opus_hq: 'Opus HQ (774)', highest: 'Highest Bitrate' };
        $('#iMode').textContent = modeLabels[d.activeMode] || d.activeMode || '—';
        $('#iMethod').textContent = d.activeMethod ? `${d.activeMethod} (Active)` : 'Original';
        $('#iStreams').textContent = d.injectedStreams ?? 0;
        $('#iAudio').textContent = d.bestAudioInfo || '—';

        // Client Stats Grid
        const grid = $('#statsGrid');
        if (grid && d.clientStats) {
          grid.innerHTML = '';
          Object.entries(d.clientStats).forEach(([client, stat]) => {
            const isCurrentPlaying = d.activeMethod === client;
            const isOk = stat.includes('str') || stat.includes('OK');
            const isErr = stat.includes('HTTP') || stat.includes('Error') || stat.includes('Fail') || stat.includes('Login');
            const isHQ = stat.includes('★');
            const cls = isCurrentPlaying ? 'hq' : (isHQ ? 'ok' : (isOk ? 'ok' : (isErr ? 'err' : '')));

            const item = document.createElement('div');
            item.className = `grid-item ${cls}`;
            const activeBadge = isCurrentPlaying ? ' 🎯' : '';
            item.innerHTML = `<span class="cn">${client}${activeBadge}</span><span class="cs">${stat}</span>`;
            grid.appendChild(item);
          });
        }

        // Error
        if (d.lastError) {
          log(`Error: ${d.lastError}`);
        }
      });
    });
  }

  pollStatus();
  setInterval(pollStatus, 1500);
})();
