// YTSpoofingStream v0.1.3 — Popup Controller (Studio 774 Dual-Stream Engine)
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const log = (msg) => console.log('[YTSS Popup]', msg);

  // ─── SETTINGS ────────────────────────────────────────────────────
  const KEYS = {
    enabled: '#en',
    autoReload: '#ar',
    shadowPlayer: '#sp',
  };

  let settings = {
    enabled: true,
    autoReload: true,
    operationMode: 'HYBRID_HQ',
    shadowPlayer: true,
    shadowVolume: 1.0,
  };

  // chrome.storage.local also holds `tvOAuthToken` (access_token + refresh_token).
  // `settings` gets handed to executeScript and written into the page's localStorage,
  // so it must never pick up anything outside this list.
  const SETTING_KEYS = Object.keys(settings);

  function pickSettings(data) {
    const out = {};
    if (!data) return out;
    for (const key of SETTING_KEYS) {
      if (data[key] !== undefined) out[key] = data[key];
    }
    return out;
  }

  // Load from chrome.storage
  chrome.storage.local.get(SETTING_KEYS, (data) => {
    if (data && Object.keys(data).length > 0) {
      Object.assign(settings, pickSettings(data));
      if (settings.operationMode === 'SAFE_NATIVE') {
        settings.operationMode = 'HYBRID_HQ';
        chrome.storage.local.set({ operationMode: 'HYBRID_HQ' });
      }
    } else {
      loadLegacy();
    }
    applyUI();
    log('Settings loaded. OpMode: ' + settings.operationMode);
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
            Object.assign(settings, pickSettings(JSON.parse(results[0].result)));
            if (settings.operationMode === 'SAFE_NATIVE') {
              settings.operationMode = 'HYBRID_HQ';
            }
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

    const activeOpMode = (settings.operationMode === 'SAFE_NATIVE' || !settings.operationMode) ? 'HYBRID_HQ' : settings.operationMode;
    document.querySelectorAll('.op-mode').forEach(m => {
      const isActive = m.dataset.opmode === activeOpMode;
      m.classList.toggle('active', isActive);
      const radio = m.querySelector('input');
      if (radio) radio.checked = isActive;
    });

    const isEnabled = !!settings.enabled;
    const wrapper = $('#mainContentWrapper');
    if (wrapper) {
      wrapper.classList.toggle('disabled-ui', !isEnabled);
    }
    const stText = $('#stText');
    const stBadge = $('#stBadge');
    if (!isEnabled) {
      if (stText) stText.textContent = 'Disabled';
      if (stBadge) {
        stBadge.style.background = 'rgba(120, 120, 120, 0.2)';
        stBadge.style.color = '#aaa';
      }
    }
  }

  function save() {
    if ($('#en')) settings.enabled = $('#en').checked;
    if ($('#ar')) settings.autoReload = $('#ar').checked;
    if ($('#sp')) settings.shadowPlayer = $('#sp').checked;

    applyUI();
    chrome.storage.local.set(settings);
    log(`Settings saved. OpMode: ${settings.operationMode}, StatsOverride: ${settings.shadowPlayer}`);

    // Note: YouTube page must refresh after applying config
    // Send settings to content script and trigger reload
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;

      // Send settings to content script (inject.js) via messaging
      chrome.scripting.executeScript({
        target: { tabId },
        func: (s) => {
          localStorage.setItem('ytss_settings', JSON.stringify(s));
          localStorage.setItem('ytSpoofingStream_settings', JSON.stringify(s));
          if (window.YTSS_SpoofingMethods && typeof window.YTSS_SpoofingMethods.applySettings === 'function') {
            window.YTSS_SpoofingMethods.applySettings(s);
          } else {
            window.postMessage({ type: 'YTSpoofingStream_settingsUpdate', settings: s }, '*');
          }

          // Force reload YouTube page to apply new config
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

  // ─── CLIENT OAUTH HANDLERS ─────────────────────────────────────────
  function setupAuthControl(clientKey, statusElId, codeContId, codeElId, loginBtnId, logoutBtnId, labelName) {
    function checkAuth() {
      chrome.runtime.sendMessage({ type: 'CHECK_CLIENT_AUTH', client: clientKey }, (res) => {
        if (res && res.isAuth) {
          $(statusElId).textContent = `Status: Logged In (${labelName} Authenticated)`;
          $(statusElId).style.color = 'var(--green)';
          $(loginBtnId).style.display = 'none';
          $(logoutBtnId).style.display = 'block';
          $(codeContId).style.display = 'none';
        } else {
          $(statusElId).textContent = `Status: Not Logged In`;
          $(statusElId).style.color = 'var(--dim)';
          $(loginBtnId).style.display = 'block';
          $(logoutBtnId).style.display = 'none';
        }
      });
    }

    $(loginBtnId)?.addEventListener('click', () => {
      $(loginBtnId).disabled = true;
      $(loginBtnId).textContent = 'Loading...';

      chrome.runtime.sendMessage({ type: 'START_CLIENT_AUTH', client: clientKey }, (res) => {
        $(loginBtnId).disabled = false;
        $(loginBtnId).textContent = `Login to ${labelName}`;
        if (res && res.success && res.data) {
          const d = res.data;
          $(statusElId).textContent = 'Status: Waiting for you to activate...';
          $(statusElId).style.color = 'var(--gold)';

          $(codeElId).textContent = d.user_code;
          $(codeContId).style.display = 'block';

          const pollUI = setInterval(() => {
            chrome.runtime.sendMessage({ type: 'CHECK_CLIENT_AUTH', client: clientKey }, (check) => {
              if (check && check.isAuth) {
                clearInterval(pollUI);
                checkAuth();
                log(`${labelName} Auth Successful!`);
              }
            });
          }, 3000);
        } else {
          $(statusElId).textContent = 'Status: Error - ' + (res?.error || 'Unknown');
          $(statusElId).style.color = 'var(--accent)';
        }
      });
    });

    $(logoutBtnId)?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'LOGOUT_CLIENT', client: clientKey }, () => {
        checkAuth();
        log(`${labelName} Logged out.`);
      });
    });

    checkAuth();
  }

  // Set up auth for TVHTML5
  setupAuthControl('TVHTML5', '#tvAuthStatus', '#tvAuthCodeContainer', '#tvAuthCode', '#btnTvLogin', '#btnTvLogout', 'TVHTML5');

  // ─── EVENT LISTENERS ──────────────────────────────────────────────
  for (const sel of Object.values(KEYS)) {
    $(sel)?.addEventListener('change', save);
  }

  document.querySelectorAll('.op-mode').forEach(m => {
    m.addEventListener('click', () => {
      settings.operationMode = m.dataset.opmode;
      document.querySelectorAll('.op-mode').forEach(x => {
        x.classList.toggle('active', x === m);
        x.querySelector('input').checked = x === m;
      });
      save();
      log(`Operation Mode: ${settings.operationMode}`);
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
        if (d.activeAudioItag) {
          badge?.classList.remove('off');
          if (text) text.textContent = 'Active';
        } else {
          badge?.classList.add('off');
          if (text) text.textContent = 'Inactive';
        }

        // SW status ping
        chrome.runtime.sendMessage({ type: 'SW_PING' }, (resp) => {
          const swEl = $('#swSt');
          if (swEl) {
            if (resp && resp.ready) {
              swEl.textContent = `SW: v${resp.version} Active`;
              swEl.style.color = '#00c853';
            } else {
              swEl.textContent = 'SW: Offline (Reload required)';
              swEl.style.color = '#e94560';
            }
          }
        });

        // Info
        const modeEl = $('#iMode');
        if (modeEl) {
          modeEl.textContent = `${settings.operationMode || 'HYBRID_HQ'} (774 ★)`;
        }

        const streamsEl = $('#iStreams');
        if (streamsEl) streamsEl.textContent = d.injectedStreams ?? 0;

        const methodEl = $('#iMethod');
        const audioEl = $('#iAudio');

        if (d.fallbackReason) {
          if (methodEl) {
            methodEl.textContent = 'FALLBACK TO ORIGINAL';
            methodEl.style.color = '#e94560';
          }
          if (audioEl) {
            audioEl.textContent = d.fallbackReason;
            audioEl.style.color = '#e94560';
            audioEl.style.fontSize = '11px';
          }
        } else {
          if (methodEl) {
            methodEl.style.color = 'var(--gold)';
            methodEl.textContent = d.activeMethod ? `${d.activeMethod} (Active)` : 'Original';
          }
          if (audioEl) {
            audioEl.style.color = '';
            audioEl.style.fontSize = '';
            audioEl.textContent = d.bestAudioInfo || '—';
          }
        }

        // Client Stats Grid
        const grid = $('#statsGrid');
        if (grid && d.clientStats) {
          grid.innerHTML = '';
          Object.entries(d.clientStats).forEach(([client, stat]) => {
            const isOk = stat.includes('str') || stat.includes('OK') || stat.includes('★') || stat.includes('Session Cache');
            const isErr = stat.includes('HTTP') || stat.includes('Error') || stat.includes('Fail') ||
                          stat.includes('Login') || stat.includes('không') || stat.includes('robot') ||
                          stat.includes('đăng nhập') || stat.includes('Unavailable');
            const isHQ = stat.includes('★') || stat.includes('774') || stat.includes('141');
            const isCurrentPlaying = (d.activeMethod === client) && !isErr;
            const cls = isCurrentPlaying ? 'hq' : (isHQ ? 'ok' : (isOk ? 'ok' : (isErr ? 'err' : '')));

            const formatName = (name) => {
              switch (name) {
                case 'WEB_REMIX': return 'Web Remix (Music)';
                case 'TVHTML5': return 'TVHTML5 (YouTube TV)';
                case 'ANDROID': return 'Android (Mobile)';
                case 'ANDROID_MUSIC': return 'Android Music';
                case 'ANDROID_VR': return 'Android VR';
                case 'CACHE': return 'Session Cache';
                default: return name;
              }
            };

            const item = document.createElement('div');
            item.className = `grid-item ${cls}`;
            const activeBadge = isCurrentPlaying ? ' 🎯' : '';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'cn';
            nameSpan.textContent = `${formatName(client)}${activeBadge}`;
            const statSpan = document.createElement('span');
            statSpan.className = 'cs';
            statSpan.textContent = stat;
            item.append(nameSpan, statSpan);
            grid.appendChild(item);
          });
        }
      });
    });
  }

  pollStatus();
  setInterval(pollStatus, 1500);
})();
