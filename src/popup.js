// YTSpoofingStream v0.2.6 — Popup Controller (Studio 774 Dual-Stream Engine)
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const log = (msg) => console.log('[YTSS Popup]', msg);

  // ─── LOCALIZATION (i18n) ─────────────────────────────────────────
  const localesCache = {};
  let currentLang = 'en';
  let currentLocaleData = {};
  let enLocaleData = {};
  let tvAuthHandler = null;

  async function loadLocale(lang) {
    if (localesCache[lang]) return localesCache[lang];
    try {
      const url = chrome.runtime.getURL(`locales/${lang}.json`);
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        localesCache[lang] = data;
        return data;
      }
    } catch (e) {
      log('Failed to load locale: ' + lang);
    }
    return {};
  }

  function t(key, params = {}) {
    let str = currentLocaleData[key] || enLocaleData[key] || key;
    if (typeof str !== 'string') return key;
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
    return str;
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key && (currentLocaleData[key] || enLocaleData[key])) {
        el.textContent = t(key);
      }
    });

    const langSelect = $('#langSelect');
    if (langSelect && langSelect.value !== currentLang) {
      langSelect.value = currentLang;
    }

    if (tvAuthHandler && typeof tvAuthHandler.renderAuth === 'function') {
      tvAuthHandler.renderAuth();
    }

    applyUI();
    pollStatus();
  }

  const SUPPORTED_LANGS = ['en', 'vi', 'ja', 'ru', 'zh-cn', 'zh-tw'];

  function detectBrowserLang() {
    const sysLang = (navigator.language || '').toLowerCase();
    if (sysLang.startsWith('vi')) return 'vi';
    if (sysLang.startsWith('ja')) return 'ja';
    if (sysLang.startsWith('ru')) return 'ru';
    if (sysLang === 'zh-tw' || sysLang === 'zh-hk' || sysLang === 'zh-mo' || sysLang.includes('hant')) return 'zh-tw';
    if (sysLang.startsWith('zh')) return 'zh-cn';
    return 'en';
  }

  async function setLanguage(lang) {
    const normalized = String(lang || '').toLowerCase();
    lang = SUPPORTED_LANGS.includes(normalized) ? normalized : 'en';
    currentLang = lang;
    currentLocaleData = await loadLocale(lang);
    chrome.storage.local.set({ uiLanguage: lang });
    applyTranslations();
  }

  async function initI18n() {
    enLocaleData = await loadLocale('en');
    chrome.storage.local.get(['uiLanguage'], async (res) => {
      let lang = res?.uiLanguage;
      if (!lang) {
        lang = detectBrowserLang();
      }
      await setLanguage(lang);
    });

    $('#langSelect')?.addEventListener('change', (e) => {
      setLanguage(e.target.value);
    });
  }

  initI18n();

  // ─── SETTINGS ────────────────────────────────────────────────────
  const KEYS = {
    enabled: '#en',
    audioOnly: '#ao',
    volumeBalance: '#vb',
    autoReload: '#ar',
    shadowPlayer: '#sp',
  };

  let settings = {
    enabled: true,
    audioOnly: false,
    volumeBalance: true,
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

  // Same scope as the inject.js/bridge.js content scripts: youtube.com, minus YTM.
  // The popup acts on whatever tab is active, so without this check it would read
  // and write localStorage on any site the user happens to have open.
  function isYouTubeTab(tab) {
    try {
      const u = new URL(tab?.url || '');
      return u.protocol === 'https:'
        && (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com'))
        && u.hostname !== 'music.youtube.com';
    } catch (e) {
      return false;
    }
  }

  function execInYouTubeTab(tab, opts, callback) {
    if (!isYouTubeTab(tab)) {
      if (callback) callback(undefined);
      return;
    }
    chrome.scripting.executeScript({ target: { tabId: tab.id }, ...opts }, callback);
  }

  // Load from chrome.storage
  chrome.storage.local.get(SETTING_KEYS, (data) => {
    if (data && Object.keys(data).length > 0) {
      Object.assign(settings, pickSettings(data));
      if (settings.operationMode === 'SAFE_NATIVE') {
        settings.operationMode = 'HYBRID_HQ';
        chrome.storage.local.set({ operationMode: 'HYBRID_HQ' });
      } else if (settings.operationMode === 'TV_UMP_MSE') {
        settings.operationMode = 'TV_HEADLESS';
        chrome.storage.local.set({ operationMode: 'TV_HEADLESS' });
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
      execInYouTubeTab(tabs[0], {
        func: () => localStorage.getItem('ytss_settings'),
      }, (results) => {
        if (results?.[0]?.result) {
          try {
            Object.assign(settings, pickSettings(JSON.parse(results[0].result)));
            if (settings.operationMode === 'SAFE_NATIVE') {
              settings.operationMode = 'HYBRID_HQ';
            } else if (settings.operationMode === 'TV_UMP_MSE') {
              settings.operationMode = 'TV_HEADLESS';
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

    if (settings.operationMode === 'TV_UMP_MSE') settings.operationMode = 'TV_HEADLESS';
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
      if (stText) stText.textContent = t('statusDisabled');
      if (stBadge) {
        stBadge.style.background = 'rgba(120, 120, 120, 0.2)';
        stBadge.style.color = '#aaa';
      }
    } else if (stBadge) {
      stBadge.style.background = '';
      stBadge.style.color = '';
    }
  }

  let pendingSelfSaves = 0;

  // Keep popup UI in sync when settings (e.g. audioOnly via in-player HUD) change externally while popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes || pendingSelfSaves > 0) return;
    let updated = false;
    for (const key of SETTING_KEYS) {
      if (changes[key] && changes[key].newValue !== undefined && settings[key] !== changes[key].newValue) {
        settings[key] = changes[key].newValue;
        updated = true;
      }
    }
    if (updated) {
      applyUI();
    }
  });

  function save(e) {
    if ($('#en')) settings.enabled = $('#en').checked;
    if ($('#ao')) settings.audioOnly = $('#ao').checked;
    if ($('#vb')) settings.volumeBalance = $('#vb').checked;
    if ($('#ar')) settings.autoReload = $('#ar').checked;
    if ($('#sp')) settings.shadowPlayer = $('#sp').checked;

    const isLiveToggle = Boolean(e && e.target && (e.target.id === 'ao' || e.target.id === 'vb'));

    applyUI();
    pendingSelfSaves++;
    chrome.storage.local.set(settings, () => {
      pendingSelfSaves = Math.max(0, pendingSelfSaves - 1);
    });
    log(`Settings saved. OpMode: ${settings.operationMode}, AudioOnly: ${settings.audioOnly}, VolBalance: ${settings.volumeBalance}, StatsOverride: ${settings.shadowPlayer}`);

    // Note: YouTube page must refresh after applying config (except for audioOnly and volumeBalance live toggles)
    // Send settings to content script and trigger reload if necessary
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;

      // Send settings to content script (inject.js) via messaging
      execInYouTubeTab(tabs[0], {
        func: (s, isLive) => {
          localStorage.setItem('ytss_settings', JSON.stringify(s));
          localStorage.setItem('ytSpoofingStream_settings', JSON.stringify(s));
          if (window.YTSS_SpoofingMethods && typeof window.YTSS_SpoofingMethods.applySettings === 'function') {
            window.YTSS_SpoofingMethods.applySettings(s);
          } else {
            window.postMessage({ type: 'YTSpoofingStream_settingsUpdate', settings: s }, '*');
          }
          if (s.audioOnly !== undefined) {
            window.postMessage({ type: 'YTSS_SET_AUDIO_ONLY', audioOnly: s.audioOnly }, '*');
          }

          // Force reload YouTube page to apply new config (skip reload for live toggles)
          if (!isLive && s.autoReload && window.location.href.includes('youtube.com')) {
            window.location.reload();
          }
        },
        args: [settings, isLiveToggle],
      }, () => {
        if (!isLiveToggle && settings.autoReload && isYouTubeTab(tabs[0])) {
          log('Config applied — reloading YouTube page...');
        }
      });
    });
  }

  // ─── CLIENT OAUTH HANDLERS ─────────────────────────────────────────
  function setupAuthControl(clientKey, statusElId, codeContId, codeElId, loginBtnId, logoutBtnId, labelName) {
    let lastAuth = null;
    let pollUI = null;

    function stopPollUI() {
      if (pollUI) {
        clearInterval(pollUI);
        pollUI = null;
      }
    }

    function renderAuth() {
      const statusEl = $(statusElId);
      const loginBtn = $(loginBtnId);
      const logoutBtn = $(logoutBtnId);
      const codeCont = $(codeContId);
      const codeEl = $(codeElId);
      const enterCodeEl = $('#tvEnterCodeText');

      if (enterCodeEl) {
        enterCodeEl.innerHTML = t('tvEnterCode', {
          url: '<a href="https://youtube.com/activate" target="_blank" style="color: var(--accent);">youtube.com/activate</a>'
        });
      }

      if (!lastAuth) {
        if (statusEl) {
          statusEl.textContent = t('tvStatusChecking');
          statusEl.style.color = 'var(--dim)';
        }
        return;
      }

      if (lastAuth.isAuth) {
        if (statusEl) {
          statusEl.textContent = t('tvStatusLoggedIn', { label: labelName });
          statusEl.style.color = 'var(--green)';
        }
        if (loginBtn) loginBtn.style.display = 'none';
        if (logoutBtn) {
          logoutBtn.style.display = 'block';
          logoutBtn.textContent = t('tvBtnLogout');
        }
        if (codeCont) codeCont.style.display = 'none';
      } else if (lastAuth.waiting) {
        if (statusEl) {
          statusEl.textContent = t('tvStatusWaiting');
          statusEl.style.color = 'var(--gold)';
        }
        if (loginBtn) {
          loginBtn.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.textContent = t('tvBtnLogin', { label: labelName });
        }
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (codeCont) codeCont.style.display = 'block';
        if (codeEl && lastAuth.code) codeEl.textContent = lastAuth.code;
      } else if (lastAuth.error) {
        if (statusEl) {
          statusEl.textContent = t('tvStatusError', { error: lastAuth.error });
          statusEl.style.color = 'var(--accent)';
        }
        if (loginBtn) {
          loginBtn.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.textContent = t('tvBtnLogin', { label: labelName });
        }
        if (logoutBtn) logoutBtn.style.display = 'none';
      } else {
        if (statusEl) {
          statusEl.textContent = t('tvStatusNotLoggedIn');
          statusEl.style.color = 'var(--dim)';
        }
        if (loginBtn) {
          loginBtn.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.textContent = t('tvBtnLogin', { label: labelName });
        }
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (codeCont) codeCont.style.display = 'none';
      }
    }

    function checkAuth() {
      chrome.runtime.sendMessage({ type: 'CHECK_CLIENT_AUTH', client: clientKey }, (res) => {
        lastAuth = { isAuth: !!(res && res.isAuth) };
        renderAuth();
      });
    }

    $(loginBtnId)?.addEventListener('click', () => {
      stopPollUI();
      const loginBtn = $(loginBtnId);
      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = t('tvBtnLoading');
      }

      chrome.runtime.sendMessage({ type: 'START_CLIENT_AUTH', client: clientKey }, (res) => {
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = t('tvBtnLogin', { label: labelName });
        }
        if (res && res.success && res.data) {
          const d = res.data;
          lastAuth = { isAuth: false, waiting: true, code: d.user_code };
          renderAuth();

          stopPollUI();
          pollUI = setInterval(() => {
            chrome.runtime.sendMessage({ type: 'CHECK_CLIENT_AUTH', client: clientKey }, (check) => {
              if (check && check.isAuth) {
                stopPollUI();
                lastAuth = { isAuth: true };
                renderAuth();
                log(`${labelName} Auth Successful!`);
              } else if (check && check.waiting === false) {
                stopPollUI();
                lastAuth = { isAuth: false, error: 'expired_token' };
                renderAuth();
              }
            });
          }, 3000);
        } else {
          lastAuth = { isAuth: false, error: res?.error || 'Unknown' };
          renderAuth();
        }
      });
    });

    $(logoutBtnId)?.addEventListener('click', () => {
      stopPollUI();
      chrome.runtime.sendMessage({ type: 'LOGOUT_CLIENT', client: clientKey }, () => {
        lastAuth = { isAuth: false };
        renderAuth();
        log(`${labelName} Logged out.`);
      });
    });

    checkAuth();
    return { renderAuth, checkAuth };
  }

  // Set up auth for TVHTML5
  tvAuthHandler = setupAuthControl('TVHTML5', '#tvAuthStatus', '#tvAuthCodeContainer', '#tvAuthCode', '#btnTvLogin', '#btnTvLogout', 'TVHTML5');

  // ─── EVENT LISTENERS ──────────────────────────────────────────────
  for (const sel of Object.values(KEYS)) {
    $(sel)?.addEventListener('change', save);
  }

  document.querySelectorAll('.op-mode').forEach(m => {
    m.addEventListener('click', () => {
      const mode = m.dataset.opmode;
      if (settings.operationMode === mode) return;
      settings.operationMode = mode;
      document.querySelectorAll('.op-mode').forEach(x => {
        x.classList.toggle('active', x === m);
        const radio = x.querySelector('input');
        if (radio) radio.checked = (x === m);
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

      execInYouTubeTab(tabs[0], {
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
        const isEnabled = !!settings.enabled;
        if (!isEnabled) {
          badge?.classList.add('off');
          if (text) text.textContent = t('statusDisabled');
        } else if (d.activeAudioItag) {
          badge?.classList.remove('off');
          if (text) text.textContent = t('statusActive');
        } else {
          badge?.classList.add('off');
          if (text) text.textContent = t('statusInactive');
        }

        // SW status ping
        chrome.runtime.sendMessage({ type: 'SW_PING' }, (resp) => {
          const swEl = $('#swSt');
          if (swEl) {
            if (resp && resp.ready) {
              swEl.textContent = t('swActive', { version: resp.version });
              swEl.style.color = '#00c853';
            } else {
              swEl.textContent = t('swOffline');
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

        const audioBufferRow = $('#rowAudioBuffer');
        const audioBufferEl = $('#iAudioBuffer');
        const is774 = d.activeAudioItag === 774 || (d.bestAudioInfo && d.bestAudioInfo.includes('774'));
        if (audioBufferRow && audioBufferEl) {
          if (is774 && d.audioBufferSec !== undefined && d.audioBufferSec !== null && !isNaN(d.audioBufferSec) && Number(d.audioBufferSec) >= 0) {
            audioBufferRow.style.display = 'flex';
            audioBufferEl.textContent = `${Number(d.audioBufferSec).toFixed(1)} s`;
          } else {
            audioBufferRow.style.display = 'none';
          }
        }

        const methodEl = $('#iMethod');
        const audioEl = $('#iAudio');

        if (d.fallbackReason) {
          if (methodEl) {
            methodEl.textContent = t('statusFallback');
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
            methodEl.textContent = d.activeMethod ? t('statusMethodActive', { method: d.activeMethod }) : t('statusOriginal');
          }
          if (audioEl) {
            audioEl.style.color = '';
            audioEl.style.fontSize = '';
            audioEl.textContent = d.bestAudioInfo || t('statusNoAudio');
          }
        }

        // Client Stats Grid
        const grid = $('#statsGrid');
        if (grid && d.clientStats) {
          grid.innerHTML = '';
          Object.entries(d.clientStats).forEach(([client, stat]) => {
            const isOk = stat.includes('str') || stat.includes('OK') || stat.includes('★') || stat.includes('Session Cache');
            const isErr = stat.includes('HTTP') || stat.includes('Error') || stat.includes('Fail') ||
                          stat.includes('Login') || stat.includes('robot') || stat.includes('Unavailable');
            const isHQ = stat.includes('★') || stat.includes('774') || stat.includes('141');
            const isCurrentPlaying = (d.activeMethod === client || (typeof d.activeMethod === 'string' && d.activeMethod.startsWith(client))) && !isErr;
            const cls = isCurrentPlaying ? 'hq' : (isHQ ? 'ok' : (isOk ? 'ok' : (isErr ? 'err' : '')));

            const formatName = (name) => {
              switch (name) {
                case 'WEB_REMIX': return t('clientWebRemix');
                case 'TVHTML5': return t('clientTvHtml5');
                case 'ANDROID': return t('clientAndroid');
                case 'ANDROID_MUSIC': return t('clientAndroidMusic');
                case 'ANDROID_VR': return t('clientAndroidVr');
                case 'CACHE': return t('clientCache');
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
