// YTSpoofingStream v0.1.7 — Popup Controller (Studio 774 Dual-Stream Engine)
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

  async function setLanguage(lang) {
    if (!['en', 'vi'].includes(lang)) lang = 'en';
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
        const sysLang = (navigator.language || '').toLowerCase();
        lang = sysLang.startsWith('vi') ? 'vi' : 'en';
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
      if (stText) stText.textContent = t('statusDisabled');
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
    let lastAuth = null;

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

          const pollUI = setInterval(() => {
            chrome.runtime.sendMessage({ type: 'CHECK_CLIENT_AUTH', client: clientKey }, (check) => {
              if (check && check.isAuth) {
                clearInterval(pollUI);
                lastAuth = { isAuth: true };
                renderAuth();
                log(`${labelName} Auth Successful!`);
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
            const isCurrentPlaying = (d.activeMethod === client) && !isErr;
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
