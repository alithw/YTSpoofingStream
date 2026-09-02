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
    rawItag: '#ri',
    shadowPlayer: '#sp',
  };

  let settings = {
    enabled: true,
    hqFetch: true,
    forceOverride: true,
    autoReload: true,
    audioMode: 'highest',
    preferredClient: 'AUTO',
    rawItag: false,
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
            Object.assign(settings, pickSettings(JSON.parse(results[0].result)));
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
    if ($('#sv')) {
      const vol = settings.shadowVolume !== undefined ? settings.shadowVolume : 1.0;
      $('#sv').value = Math.round(vol * 100);
      if ($('#svVal')) $('#svVal').textContent = `${Math.round(vol * 100)}%`;
    }
    document.querySelectorAll('.mode').forEach(m => {
      m.classList.toggle('active', m.dataset.mode === settings.audioMode);
      const radio = m.querySelector('input');
      if (radio) radio.checked = m.dataset.mode === settings.audioMode;
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
    settings.enabled = $('#en').checked;
    settings.hqFetch = $('#hq').checked;
    settings.forceOverride = $('#fo').checked;
    settings.autoReload = $('#ar').checked;
    if ($('#ri')) settings.rawItag = $('#ri').checked;
    if ($('#sp')) settings.shadowPlayer = $('#sp').checked;
    if ($('#sv')) settings.shadowVolume = parseInt($('#sv').value, 10) / 100;
    if ($('#preferredClient')) {
      settings.preferredClient = $('#preferredClient').value;
    }

    applyUI();
    chrome.storage.local.set(settings);
    log(`Settings saved. Method: ${settings.preferredClient}, Mode: ${settings.audioMode}`
      + `${settings.rawItag ? ', RAW ITAG' : ''}`
      + `${settings.shadowPlayer ? ', Shadow Audio ON' : ''}`);

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
  $('#preferredClient')?.addEventListener('change', save);

  $('#sv')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if ($('#svVal')) $('#svVal').textContent = `${val}%`;
    settings.shadowVolume = val / 100;
    save();
  });

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
        $('#iStreams').textContent = d.injectedStreams ?? 0;
        if (d.fallbackReason) {
          $('#iMethod').textContent = 'FALLBACK TO ORIGINAL';
          $('#iMethod').style.color = '#e94560';
          // Same reasoning as the notes below: page-controlled string, so textContent.
          $('#iAudio').textContent = d.fallbackReason;
          $('#iAudio').style.color = '#e94560';
          $('#iAudio').style.fontSize = '11px';
        } else {
          $('#iMethod').style.color = 'var(--gold)';
          $('#iAudio').style.color = '';
          $('#iAudio').style.fontSize = '';
          $('#iMethod').textContent = d.activeMethod ? `${d.activeMethod} (Active)` : 'Original';
          // Two different reasons the popup can look like it succeeded when it didn't:
          //   clientFallback — the chosen Spoofing Method returned no HQ, another client
          //     supplied the stream, so "Active" names a client you didn't pick.
          //   noUrlDrop — the SW did return 774/141, but as metadata with no url
          //     (SABR-only), so it could never be injected. The client grid still shows
          //     ★774 in that case, which reads as success.
          // Built as DOM nodes, not innerHTML: `d` is parsed out of the *page's*
          // localStorage, so every string in it is attacker-controllable by any
          // script running on the tab. textContent makes that unexploitable.
          const notes = [d.clientFallback, d.noUrlDrop].filter(Boolean);
          const audioEl = $('#iAudio');
          audioEl.textContent = d.bestAudioInfo || '—';
          for (const n of notes) {
            audioEl.appendChild(document.createElement('br'));
            const span = document.createElement('span');
            span.style.color = 'var(--gold)';
            span.style.fontSize = '10px';
            span.textContent = n;
            audioEl.appendChild(span);
          }
        }



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

            const formatName = (name) => {
              switch (name) {
                case 'WEB_REMIX': return 'Web Remix (Music)';
                case 'TVHTML5': return 'TVHTML5 (YouTube TV)';
                case 'ANDROID': return 'Android (Mobile)';
                case 'ANDROID_MUSIC': return 'Android Music';
                case 'ANDROID_VR': return 'Android VR';
                default: return name;
              }
            };

            const item = document.createElement('div');
            item.className = `grid-item ${cls}`;
            const activeBadge = isCurrentPlaying ? ' 🎯' : '';
            // `client` and `stat` both come from the page's localStorage — see the
            // note on #iAudio above. Nodes + textContent, not innerHTML.
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
