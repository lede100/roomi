import { STORE_KEY, StorageAdapter } from './storage.js';
import {
  runtime,
  makeCharacterCard,
  defaultState,
  normalizeState,
  getActiveCharacter,
  flushActiveCharToList,
  loadCharacterIntoRuntime,
  scheduleSave,
  showWarn,
  clearModelCompatCache
} from './state.js';
import {
  DEFAULT_PERSONA,
  CONTEXT_TIERS,
  CHAR_TEMPLATES,
  cloneStarterWidget,
  buildNaturalStarter,
  THEME_ORDER,
  THEME_LABELS
} from './presets.js';
import {
  todayKey,
  escapeHtml,
  fetchWithTimeout,
  compressImageFile,
  extractCharaFromPng,
  normalizeImportedCardData
} from './utils.js';
import {
  upsertMemory,
  pruneSceneStates,
  removeSceneStateByKey,
  formatSceneAge,
  maybeCompressHistory
} from './memory.js';
import { stripThinkingTags } from './prompt.js';
import {
  buildBackupPackage,
  saveLocalBackupFile,
  isEncryptedBackup,
  decryptBackupPayload,
  summarizeBackupData
} from './backup.js';
import { ui, registerUI } from './ui-bridge.js';

export function initSettingsUI() {
  function syncThemePickerUI(theme) {
    const activeT = THEME_ORDER.includes(theme) ? theme : 'claude';
    document.querySelectorAll('#themePicker [data-theme-choice]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeChoice === activeT);
    });
  }

  function applyTheme(theme) {
    const t = THEME_ORDER.includes(theme) ? theme : 'claude';
    if (document.documentElement.getAttribute('data-theme') !== t) {
      document.documentElement.setAttribute('data-theme', t);
    }
    syncThemePickerUI(t);
    const sb = window.Capacitor?.Plugins?.StatusBar;
    if (sb?.setStyle) {
      // Capacitor StatusBar: LIGHT = dark text on light bg, DARK = light text on dark bg
      sb.setStyle({ style: t === 'glass-dark' ? 'DARK' : 'LIGHT' }).catch(() => {});
    }
  }

  document.getElementById('quickThemeBtn').onclick = () => {
    const cur = THEME_ORDER.includes(runtime.state.settings.theme) ? runtime.state.settings.theme : 'claude';
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    runtime.state.settings.theme = next;
    applyTheme(next);
    ui.renderWidgets?.();
    scheduleSave();
    showWarn(`已切换到「${THEME_LABELS[next] || next}」风格`, true);
    setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1400);
  };

  document.querySelectorAll('#themePicker [data-theme-choice]').forEach(btn => {
    btn.onclick = () => {
      const next = btn.dataset.themeChoice || 'claude';
      runtime.state.settings.theme = next;
      applyTheme(next);
      syncSettingsAccordionBadges();
      ui.renderWidgets?.();
      scheduleSave();
    };
  });

  const settingsModal = document.getElementById('settingsModal');
  const cfgBaseUrl = document.getElementById('cfgBaseUrl');
  const cfgApiKey = document.getElementById('cfgApiKey');
  const cfgModel = document.getElementById('cfgModel');
  const fetchModelsBtn = document.getElementById('fetchModelsBtn');
  const testConnBtn = document.getElementById('testConnBtn');
  const modelStatus = document.getElementById('modelStatus');
  const modelSuggestions = document.getElementById('modelSuggestions');
  let detectedModels = [];
  let keyDetectTimer = null;
  let detectSeq = 0;

  function setModelStatus(text, type = '') {
    modelStatus.textContent = text;
    modelStatus.className = 'model-status' + (type ? ' ' + type : '');
  }

  function renderModelSuggestions(filterText = '') {
    if (!detectedModels.length) {
      modelSuggestions.classList.remove('show');
      modelSuggestions.innerHTML = '';
      return;
    }
    const q = filterText.trim().toLowerCase();
    const matched = q
      ? detectedModels.filter(id => id.toLowerCase().includes(q))
      : detectedModels;
    const list = matched.slice(0, 60);
    if (!list.length) {
      modelSuggestions.classList.remove('show');
      return;
    }
    const currentVal = cfgModel.value.trim();
    modelSuggestions.innerHTML = '';
    list.forEach(id => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-pill' + (id === currentVal ? ' active' : '');
      btn.textContent = id;
      btn.onclick = () => {
        cfgModel.value = id;
        renderModelSuggestions('');
      };
      modelSuggestions.appendChild(btn);
    });
    modelSuggestions.classList.add('show');
  }

  async function detectAvailableModels(autoPickIfDefault = true) {
    const base = cfgBaseUrl.value.trim().replace(/\/+$/, '');
    const key = cfgApiKey.value.trim();
    if (!base || !key) {
      setModelStatus('选择服务商并填入 API Key 后会自动检测模型');
      detectedModels = [];
      renderModelSuggestions();
      return;
    }
    const mySeq = ++detectSeq;
    fetchModelsBtn.disabled = true;
    fetchModelsBtn.textContent = '检测中…';
    setModelStatus('正在查询 /models 接口…');
    try {
        const res = await fetchWithTimeout(`${base}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${key}` }
        }, 25000);
      if (mySeq !== detectSeq) return;
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${errText.slice(0, 80)}`);
      }
      const json = await res.json();
      if (mySeq !== detectSeq) return;
      const rawList = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
      const ids = [...new Set(rawList.map(item => (typeof item === 'string' ? item : item?.id || item?.name)).filter(Boolean))].sort();
      if (!ids.length) {
        detectedModels = [];
        renderModelSuggestions();
        setModelStatus('接口未返回模型列表，请手动填写模型名称');
        return;
      }
      detectedModels = ids;
      const cur = cfgModel.value.trim();
      if (!cur || !ids.includes(cur)) {
        const preferred = ids.find(id => /chat|deepseek|gpt|claude|gemini|qwen/i.test(id)) || ids[0];
        cfgModel.value = autoPickIfDefault ? preferred : '';
      }
      setModelStatus(`✓ 已检测到 ${ids.length} 个模型${ids.length > 60 ? '（输入关键词可筛选）' : '，点击下方即可选用'}`, 'ok');
      renderModelSuggestions('');
    } catch (err) {
      if (mySeq !== detectSeq) return;
      detectedModels = [];
      renderModelSuggestions();
      setModelStatus(`未能自动获取模型列表（${err.message}），可手动填写`, 'err');
    } finally {
      if (mySeq === detectSeq) {
        fetchModelsBtn.disabled = false;
        fetchModelsBtn.textContent = '↻ 检测模型';
      }
    }
  }

  fetchModelsBtn.onclick = () => detectAvailableModels(false);

  testConnBtn.onclick = async () => {
    const base = cfgBaseUrl.value.trim().replace(/\/+$/, '');
    const key = cfgApiKey.value.trim();
    const model = cfgModel.value.trim();
    if (!base) {
      setModelStatus('请先点选上方的接口服务商（或填写自定义地址）', 'err');
      return;
    }
    if (!key) {
      setModelStatus('请先填入 API Key', 'err');
      cfgApiKey.focus();
      return;
    }
    if (!model) {
      setModelStatus('请先检测或填写模型名称', 'err');
      cfgModel.focus();
      return;
    }
    testConnBtn.disabled = true;
    testConnBtn.textContent = '测通中…';
    setModelStatus('正在测试对话连通性…');
    const t0 = Date.now();
    try {
        const res = await fetchWithTimeout(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model,
            max_tokens: 12,
            temperature: 0.1,
            stream: false,
            messages: [{ role: 'user', content: 'hi' }]
          })
        }, 25000);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const hint = res.status === 401 ? '（Key 无效或已过期）'
          : (res.status === 402 || res.status === 429) ? '（额度不足或限流）'
          : res.status === 404 ? '（模型名或接口地址有误）' : '';
        throw new Error(`HTTP ${res.status}${hint} ${txt.slice(0, 60)}`);
      }
      const ms = Date.now() - t0;
      setModelStatus(`✓ 对话接口可用（响应 ${ms}ms），点下方「保存并应用」即可开聊`, 'ok');
    } catch (err) {
      setModelStatus(`✗ 测通失败：${err.message}`, 'err');
    } finally {
      testConnBtn.disabled = false;
      testConnBtn.textContent = '⚡ 测通对话';
    }
  };

  cfgApiKey.addEventListener('input', () => {
    clearTimeout(keyDetectTimer);
    if (!cfgApiKey.value.trim()) {
      detectedModels = [];
      renderModelSuggestions();
      setModelStatus('');
      return;
    }
    keyDetectTimer = setTimeout(() => detectAvailableModels(true), 750);
  });
  cfgApiKey.addEventListener('change', () => {
    clearTimeout(keyDetectTimer);
    if (cfgApiKey.value.trim()) detectAvailableModels(true);
  });
  cfgBaseUrl.addEventListener('change', () => {
    if (cfgApiKey.value.trim()) detectAvailableModels(true);
  });
  cfgModel.addEventListener('input', () => renderModelSuggestions(cfgModel.value));
  cfgModel.addEventListener('focus', () => {
    if (detectedModels.length) renderModelSuggestions('');
  });

  const memSummaryInput = document.getElementById('memSummaryInput');
  const memListEl = document.getElementById('memList');
  const memCompressStatus = document.getElementById('memCompressStatus');
  const memTabCount = document.getElementById('memTabCount');
  const modelCfgDot = document.getElementById('modelCfgDot');

  let isCreateSubView = false;

  function syncSaveRowVisibility(activeTabKey) {
    const saveRow = document.getElementById('saveSettingsRow');
    if (!saveRow) return;
    saveRow.style.display = (activeTabKey === 'companion' && isCreateSubView) ? 'none' : 'flex';
  }

  function switchSettingsTab(tabKey) {
    const safeKey = tabKey === 'model' ? 'model' : 'companion';
    document.querySelectorAll('#setTabBar .set-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.setTab === safeKey);
    });
    document.querySelectorAll('#settingsModal .set-pane').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.setPane === safeKey);
    });
    syncSaveRowVisibility(safeKey);
  }

  document.querySelectorAll('#setTabBar .set-tab').forEach(btn => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.setTab));
  });

  function updateMemStats() {
    const memCount = Array.isArray(runtime.state.memories) ? runtime.state.memories.length : 0;
    const stateCount = Array.isArray(runtime.state.sceneStates) ? runtime.state.sceneStates.length : 0;
    const totalCount = memCount + stateCount;
    if (memTabCount) memTabCount.textContent = totalCount ? String(totalCount) : '';
    if (modelCfgDot) {
      const missingCfg = !String(runtime.state.settings.apiKey || "").trim() || !String(runtime.state.settings.model || "").trim();
      modelCfgDot.classList.toggle('show', missingCfg);
    }
  }

  function refreshMemoryView() {
    if (memSummaryInput && document.activeElement !== memSummaryInput) {
      memSummaryInput.value = runtime.state.memorySummary || '';
    }
    renderMemoryModalList();
    renderSceneStatesList();
    updateMemStats();
  }

  if (memSummaryInput) {
    const commitSummary = () => {
      const val = memSummaryInput.value.trim().slice(0, 1200);
      if (val !== (runtime.state.memorySummary || '')) {
        runtime.state.memorySummary = val;
        scheduleSave();
      }
    };
    memSummaryInput.addEventListener('input', commitSummary);
    memSummaryInput.addEventListener('blur', commitSummary);
  }

  function renderMemoryModalList(editingIdx = -1) {
    const list = Array.isArray(runtime.state.memories) ? runtime.state.memories : [];
    memListEl.innerHTML = '';
    if (!list.length) {
      memListEl.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:12px;text-align:center;background:var(--bg-sub);border-radius:10px;">小本本还是空的，聊到你的作息/喜好时会自动记下来</div>`;
      return;
    }
    list.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'mem-item';
      if (idx === editingIdx) {
        row.innerHTML = `
          <div class="mem-edit-form">
            <div class="mem-edit-inputs">
              <input type="text" class="mem-ek" style="width:34%;" value="${escapeHtml(m.key)}" placeholder="标签" />
              <input type="text" class="mem-ev" style="flex:1;" value="${escapeHtml(m.value)}" placeholder="内容" />
            </div>
            <div style="display:flex;justify-content:flex-end;gap:6px;">
              <button type="button" class="mini-btn" data-act="cancel">取消</button>
              <button type="button" class="detect-btn" data-act="save">保存</button>
            </div>
          </div>`;
        row.querySelector('[data-act="cancel"]').onclick = () => renderMemoryModalList(-1);
        row.querySelector('[data-act="save"]').onclick = () => {
          const nk = row.querySelector('.mem-ek').value.trim().slice(0, 24);
          const nv = row.querySelector('.mem-ev').value.trim().slice(0, 120);
          if (nk && nv) {
            m.key = nk;
            m.value = nv;
            m.updatedAt = Date.now();
            scheduleSave();
          }
          renderMemoryModalList(-1);
          updateMemStats();
        };
        memListEl.appendChild(row);
        return;
      }
      row.innerHTML = `
        <div style="flex:1;min-width:0;"><span class="mem-item-key">${m.pinned ? '📌 ' : ''}${escapeHtml(m.key)}</span><span>${escapeHtml(m.value)}</span></div>
        <div class="mem-actions">
          <button type="button" class="mini-btn mem-pin-btn ${m.pinned ? 'pinned' : ''}" data-act="pin" title="${m.pinned ? '取消置顶' : '设为置顶核心记忆'}">📌</button>
          <button type="button" class="mini-btn" data-act="edit" title="修改">✎</button>
          <button type="button" class="mini-btn danger" data-act="del" title="删除">✕</button>
        </div>`;
      row.querySelector('[data-act="pin"]').onclick = () => {
        m.pinned = !m.pinned;
        scheduleSave();
        renderMemoryModalList(-1);
      };
      row.querySelector('[data-act="edit"]').onclick = () => renderMemoryModalList(idx);
      row.querySelector('[data-act="del"]').onclick = () => {
        runtime.state.memories.splice(idx, 1);
        scheduleSave();
        renderMemoryModalList(-1);
        updateMemStats();
      };
      memListEl.appendChild(row);
    });
  }

  const customUrlField = document.getElementById('customUrlField');

  function syncProviderPickerUI(urlVal, forceCustom = false) {
    const clean = String(urlVal || '').trim().replace(/\/+$/, '');
    let matchedBtn = null;
    document.querySelectorAll('#providerPicker .preset-btn').forEach(btn => {
      const u = (btn.dataset.url || '').replace(/\/+$/, '');
      const isMatch = !forceCustom && clean && u === clean;
      if (isMatch) matchedBtn = btn;
      btn.classList.toggle('active', isMatch);
    });
    const customBtn = document.querySelector('#providerPicker .preset-btn[data-custom]');
    const showCustom = forceCustom || (Boolean(clean) && !matchedBtn);
    if (customBtn) customBtn.classList.toggle('active', showCustom);
    customUrlField.style.display = showCustom ? 'block' : 'none';
  }

  document.querySelectorAll('#providerPicker .preset-btn').forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.custom) {
        syncProviderPickerUI(cfgBaseUrl.value, true);
        cfgBaseUrl.focus();
        return;
      }
      cfgBaseUrl.value = btn.dataset.url;
      cfgModel.value = '';
      detectedModels = [];
      renderModelSuggestions();
      syncProviderPickerUI(btn.dataset.url, false);
      if (cfgApiKey.value.trim()) {
        detectAvailableModels(true);
      } else {
        setModelStatus('填入 API Key 后会自动检测可用模型');
      }
    };
  });

  const charBarEl = document.getElementById('charBar');
  const charEditView = document.getElementById('charEditView');
  const charCreateView = document.getElementById('charCreateView');
  const deleteCharBtn = document.getElementById('deleteCharBtn');
  const aiPersonaBtn = document.getElementById('aiPersonaBtn');
  const aiPersonaStatus = document.getElementById('aiPersonaStatus');
  const cfgImgBaseUrl = document.getElementById('cfgImgBaseUrl');
  const cfgImgApiKey = document.getElementById('cfgImgApiKey');
  const cfgMsCustomModel = document.getElementById('cfgMsCustomModel');
  const cfgImgModel = document.getElementById('cfgImgModel');
  const fetchImgModelsBtn = document.getElementById('fetchImgModelsBtn');
  const imgModelStatus = document.getElementById('imgModelStatus');
  const imgModelSuggestions = document.getElementById('imgModelSuggestions');
  const imgConfigFields = document.getElementById('imgConfigFields');
  const imgBaseUrlField = document.getElementById('imgBaseUrlField');
  const imgKeyLabel = document.getElementById('imgKeyLabel');
  const imgModelLabel = document.getElementById('imgModelLabel');
  const imgModelPresets = document.getElementById('imgModelPresets');
  const imgHintText = document.getElementById('imgHintText');
  const msTokenHelpLink = document.getElementById('msTokenHelpLink');
  let detectedImgModels = [];
  let detectImgSeq = 0;
  let draftMsPreset = 'Tongyi-MAI/Z-Image-Turbo';
  const cfgAge = document.getElementById('cfgAge');
  const cfgAppearance = document.getElementById('cfgAppearance');
  const avatarEditBtn = document.getElementById('avatarEditBtn');
  const charAvatarInput = document.getElementById('charAvatarInput');
  const avatarClearBadge = document.getElementById('avatarClearBadge');
  const gbAvatarBtn = document.getElementById('gbAvatarBtn');
  const gbAvatarInput = document.getElementById('gbAvatarInput');
  const gbAvatarClearBadge = document.getElementById('gbAvatarClearBadge');
  const gbName = document.getElementById('gbName');
  const gbAge = document.getElementById('gbAge');
  const gbPersonality = document.getElementById('gbPersonality');
  const gbRelation = document.getElementById('gbRelation');
  const gbAppearance = document.getElementById('gbAppearance');
  const gbHabits = document.getElementById('gbHabits');
  const gbGenerateBtn = document.getElementById('gbGenerateBtn');
  const gbStatus = document.getElementById('gbStatus');
  let draftImgProvider = 'off';
  let draftImgTrigger = 'asked';
  let draftImgSize = '1152x1536';
  let draftAiGreeting = '';
  let draftAvatarImage = '';
  let draftWallpaper = '';
  let gbDraftAvatarImage = '';
  let draftGender = '';
  let gbDraftGender = '';
  let draftChatMode = 'wechat';
  let draftPrivacyPin = '';
  let draftThinkingMode = 'auto';
  let draftContextMode = 'long';
  let draftTempMode = 'balanced';

  const cfgImgCustomSize = document.getElementById('cfgImgCustomSize');
  function syncImgSizePickerUI() {
    const customVal = (cfgImgCustomSize?.value || '').trim();
    document.querySelectorAll('#imgSizePicker [data-img-size]').forEach(btn => {
      btn.classList.toggle('active', !customVal && btn.dataset.imgSize === draftImgSize);
    });
  }
  document.querySelectorAll('#imgSizePicker [data-img-size]').forEach(btn => {
    btn.onclick = () => {
      draftImgSize = btn.dataset.imgSize || '1152x1536';
      if (cfgImgCustomSize) cfgImgCustomSize.value = '';
      syncImgSizePickerUI();
    };
  });
  if (cfgImgCustomSize) {
    cfgImgCustomSize.addEventListener('input', syncImgSizePickerUI);
  }

  function syncTempPickerUI() {
    document.querySelectorAll('#tempPicker [data-temp]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.temp === draftTempMode);
    });
  }
  document.querySelectorAll('#tempPicker [data-temp]').forEach(btn => {
    btn.onclick = () => {
      draftTempMode = btn.dataset.temp || 'balanced';
      syncTempPickerUI();
      syncSettingsAccordionBadges();
    };
  });

  function syncNotifyTimesRowUI() {
    const chk = document.getElementById('cfgDailyNotify');
    const row = document.getElementById('notifyTimesRow');
    if (chk && row) row.style.display = chk.checked ? 'flex' : 'none';
  }
  const cfgDailyNotifyEl = document.getElementById('cfgDailyNotify');
  if (cfgDailyNotifyEl) cfgDailyNotifyEl.onchange = syncNotifyTimesRowUI;
  document.getElementById('cfgPrivacyLock')?.addEventListener('change', syncSettingsAccordionBadges);
  document.getElementById('cfgAnchors')?.addEventListener('input', syncSettingsAccordionBadges);
  document.getElementById('cfgSampleDialogue')?.addEventListener('input', syncSettingsAccordionBadges);

  function syncChatModePickerUI() {
    const el = document.getElementById('cfgStoryMode');
    if (el) el.checked = draftChatMode === 'story';
  }
  const cfgStoryModeEl = document.getElementById('cfgStoryMode');
  if (cfgStoryModeEl) {
    cfgStoryModeEl.onchange = () => {
      draftChatMode = cfgStoryModeEl.checked ? 'story' : 'wechat';
    };
  }


  function syncSettingsAccordionBadges() {
    const thinkMap = { auto: '默认思考', off: '关思考', low: '轻量思考', high: '深度思考' };
    const ctxMap = { short: '省流', long: '超长', ultra: '1M' };
    const tempMap = { calm: '0.65', balanced: '0.85', vivid: '1.0' };
    const tuningBadge = document.getElementById('accModelTuningBadge');
    if (tuningBadge) {
      tuningBadge.textContent = `${thinkMap[draftThinkingMode] || '默认思考'} · ${ctxMap[draftContextMode] || '超长'} · ${tempMap[draftTempMode] || '0.85'}`;
    }
    const imgBadge = document.getElementById('accImgGenBadge');
    if (imgBadge) {
      const imgLabel = draftImgProvider === 'modelscope' ? '魔搭已开' : (draftImgProvider === 'openai' ? 'OpenAI 已开' : '已关闭');
      imgBadge.textContent = imgLabel;
      imgBadge.classList.toggle('on', draftImgProvider !== 'off');
    }
    const appBadge = document.getElementById('accAppearanceBadge');
    if (appBadge) {
      const tName = THEME_LABELS[runtime.state.settings.theme] || '暖纸张';
      const lockOn = document.getElementById('cfgPrivacyLock')?.checked;
      appBadge.textContent = lockOn ? `${tName} · 隐私锁开` : tName;
      appBadge.classList.toggle('on', Boolean(lockOn));
    }
    const charAdvBadge = document.getElementById('accCharAdvancedBadge');
    if (charAdvBadge) {
      const tags = [];
      if ((document.getElementById('cfgAnchors')?.value || '').trim()) tags.push('防飘');
      if ((document.getElementById('cfgSampleDialogue')?.value || '').trim()) tags.push('示范');
      if (draftWallpaper) tags.push('壁纸');
      charAdvBadge.textContent = tags.length ? `已设：${tags.join(' / ')}` : '外貌 / 防飘 / 壁纸';
      charAdvBadge.classList.toggle('on', tags.length > 0);
    }
  }

  function syncPrivacyPinStatusUI() {
    const el = document.getElementById('privacyPinStatus');
    if (el) {
      el.textContent = draftPrivacyPin && draftPrivacyPin.length === 4 ? '✓ 已设置 4 位隐私密码' : '尚未设置隐私密码';
    }
  }

  function syncGenderPickerUI(pickerId, val) {
    const el = document.getElementById(pickerId);
    if (!el) return;
    el.querySelectorAll('[data-gender]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.gender === (val || ''));
    });
  }

  function syncModelTuningPickersUI() {
    document.querySelectorAll('#thinkingPicker [data-thinking]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.thinking === draftThinkingMode);
    });
    document.querySelectorAll('#contextPicker [data-context]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.context === draftContextMode);
    });
  }

  document.querySelectorAll('#cfgGenderPicker [data-gender]').forEach(btn => {
    btn.onclick = () => {
      draftGender = btn.dataset.gender || '';
      syncGenderPickerUI('cfgGenderPicker', draftGender);
    };
  });
  document.querySelectorAll('#gbGenderPicker [data-gender]').forEach(btn => {
    btn.onclick = () => {
      gbDraftGender = btn.dataset.gender || '';
      syncGenderPickerUI('gbGenderPicker', gbDraftGender);
    };
  });
  document.querySelectorAll('#thinkingPicker [data-thinking]').forEach(btn => {
    btn.onclick = () => {
      draftThinkingMode = btn.dataset.thinking || 'auto';
      syncModelTuningPickersUI();
      syncSettingsAccordionBadges();
    };
  });
  document.querySelectorAll('#contextPicker [data-context]').forEach(btn => {
    btn.onclick = () => {
      draftContextMode = btn.dataset.context || 'long';
      syncModelTuningPickersUI();
      syncSettingsAccordionBadges();
    };
  });

  function setCompanionSubView(mode) {
    isCreateSubView = mode === 'create';
    charEditView.style.display = isCreateSubView ? 'none' : 'block';
    charCreateView.style.display = isCreateSubView ? 'block' : 'none';
    if (isCreateSubView) {
      refreshGbAvatarPreview();
      syncGenderPickerUI('gbGenderPicker', gbDraftGender);
    }
    const activeTab = document.querySelector('#setTabBar .set-tab.active')?.dataset?.setTab || 'companion';
    syncSaveRowVisibility(activeTab);
  }

  function refreshAvatarEditPreview() {
    const name = document.getElementById('cfgName').value.trim() || runtime.state.settings.name || '林澈';
    const active = getActiveCharacter();
    ui.applyAvatarToEl?.(avatarEditBtn, name, draftAvatarImage, active?.avatarColor);
    avatarClearBadge.classList.toggle('show', Boolean(draftAvatarImage));
  }

  function refreshGbAvatarPreview() {
    const name = gbName.value.trim() || '新伙伴';
    ui.applyAvatarToEl?.(gbAvatarBtn, name, gbDraftAvatarImage, 'linear-gradient(135deg, #d97757 0%, #e69679 100%)');
    gbAvatarClearBadge.classList.toggle('show', Boolean(gbDraftAvatarImage));
  }

  avatarEditBtn.onclick = () => charAvatarInput.click();
  charAvatarInput.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await compressImageFile(file, 256, 0.85);
      draftAvatarImage = res.dataUrl;
      refreshAvatarEditPreview();
    } catch (err) {
      showWarn(`头像处理失败：${err.message}`);
    } finally {
      charAvatarInput.value = '';
    }
  };
  avatarClearBadge.onclick = e => {
    e.stopPropagation();
    draftAvatarImage = '';
    refreshAvatarEditPreview();
  };

  gbAvatarBtn.onclick = () => gbAvatarInput.click();
  gbAvatarInput.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await compressImageFile(file, 256, 0.85);
      gbDraftAvatarImage = res.dataUrl;
      refreshGbAvatarPreview();
    } catch (err) {
      showWarn(`头像处理失败：${err.message}`);
    } finally {
      gbAvatarInput.value = '';
    }
  };
  gbAvatarClearBadge.onclick = e => {
    e.stopPropagation();
    gbDraftAvatarImage = '';
    refreshGbAvatarPreview();
  };
  gbName.addEventListener('input', refreshGbAvatarPreview);
  document.getElementById('cfgName').addEventListener('input', refreshAvatarEditPreview);
  document.getElementById('backToEditBtn').onclick = () => setCompanionSubView('edit');

  document.querySelectorAll('.guide-chips[data-fill-target]').forEach(group => {
    const targetInput = document.getElementById(group.dataset.fillTarget);
    group.querySelectorAll('.mini-chip').forEach(chip => {
      chip.onclick = () => {
        if (!targetInput) return;
        const val = chip.textContent.trim();
        const cur = targetInput.value.trim();
        const parts = cur ? cur.split(/[、,，\s]+/).filter(Boolean) : [];
        if (parts.includes(val)) {
          targetInput.value = parts.filter(p => p !== val).join('、');
          chip.classList.remove('active');
        } else {
          parts.push(val);
          targetInput.value = parts.join('、');
          chip.classList.add('active');
        }
      };
    });
  });

  function setImgModelStatus(text, type = '') {
    if (!imgModelStatus) return;
    imgModelStatus.textContent = text;
    imgModelStatus.className = 'model-status' + (type ? ' ' + type : '');
  }

  function renderImgModelSuggestions(filterText = '') {
    if (!imgModelSuggestions) return;
    if (draftImgProvider !== 'openai' || !detectedImgModels.length) {
      imgModelSuggestions.classList.remove('show');
      imgModelSuggestions.innerHTML = '';
      return;
    }
    const q = filterText.trim().toLowerCase();
    const matched = q
      ? detectedImgModels.filter(id => id.toLowerCase().includes(q))
      : detectedImgModels;
    const list = matched.slice(0, 60);
    imgModelSuggestions.innerHTML = '';
    if (!list.length) {
      imgModelSuggestions.classList.remove('show');
      return;
    }
    const currentVal = cfgImgModel.value.trim();
    list.forEach(id => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-pill' + (id === currentVal ? ' active' : '');
      btn.textContent = id;
      btn.onclick = () => {
        cfgImgModel.value = id;
        renderImgModelSuggestions('');
      };
      imgModelSuggestions.appendChild(btn);
    });
    imgModelSuggestions.classList.add('show');
  }

  async function detectAvailableImgModels() {
    const base = (cfgImgBaseUrl.value.trim() || cfgBaseUrl.value.trim()).replace(/\/+$/, '');
    const key = cfgImgApiKey.value.trim() || cfgApiKey.value.trim();
    if (!base || !key) {
      setImgModelStatus('请先填好生图或对话的 Base URL 和 API Key', 'err');
      return;
    }
    const mySeq = ++detectImgSeq;
    fetchImgModelsBtn.disabled = true;
    fetchImgModelsBtn.textContent = '检测中…';
    setImgModelStatus('正在查询 /models 接口…');
    try {
      const candidates = /\/v\d+$/i.test(base)
        ? [`${base}/models`]
        : [`${base}/models`, `${base}/v1/models`];
      let res = null;
      for (const ep of candidates) {
          res = await fetchWithTimeout(ep, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${key}` }
          }, 25000);
        if (res.ok || (res.status !== 404 && res.status !== 405)) break;
      }
      if (mySeq !== detectImgSeq) return;
      if (!res || !res.ok) {
        const errText = res ? await res.text().catch(() => '') : '';
        throw new Error(`HTTP ${res?.status || 'ERR'} ${errText.slice(0, 80)}`);
      }
      const json = await res.json();
      if (mySeq !== detectImgSeq) return;
      const rawList = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
      const ids = [...new Set(rawList.map(item => (typeof item === 'string' ? item : item?.id || item?.name)).filter(Boolean))].sort();
      if (!ids.length) {
        detectedImgModels = [];
        renderImgModelSuggestions();
        setImgModelStatus('接口未返回模型列表，可手动填写模型名称');
        return;
      }
      detectedImgModels = ids;
      setImgModelStatus(`✓ 已检测到 ${ids.length} 个模型${ids.length > 60 ? '（输入关键词可筛选）' : '，点击下方即可选用'}`, 'ok');
      renderImgModelSuggestions('');
    } catch (err) {
      if (mySeq !== detectImgSeq) return;
      detectedImgModels = [];
      renderImgModelSuggestions();
      setImgModelStatus(`未能获取模型列表（${err.message}），可手动填写`, 'err');
    } finally {
      if (mySeq === detectImgSeq) {
        fetchImgModelsBtn.disabled = false;
        fetchImgModelsBtn.textContent = '↻ 检测模型';
      }
    }
  }

  function syncImgProviderUI(provider, trigger = draftImgTrigger) {
    draftImgProvider = provider || 'off';
    draftImgTrigger = trigger === 'auto' ? 'auto' : 'asked';
    document.querySelectorAll('#imgProviderPicker [data-img-provider]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.imgProvider === draftImgProvider);
    });
    document.querySelectorAll('#imgTriggerPicker [data-img-trigger]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.imgTrigger === draftImgTrigger);
    });
    const enabled = draftImgProvider !== 'off';
    imgConfigFields.style.display = enabled ? 'block' : 'none';
    if (!enabled) return;
    const isMs = draftImgProvider === 'modelscope';
    imgBaseUrlField.style.display = isMs ? 'none' : 'block';
    imgModelPresets.style.display = isMs ? 'flex' : 'none';
    if (cfgMsCustomModel) cfgMsCustomModel.style.display = isMs ? 'block' : 'none';
    cfgImgModel.style.display = isMs ? 'none' : 'block';
    if (fetchImgModelsBtn) fetchImgModelsBtn.style.display = isMs ? 'none' : 'inline-flex';
    if (msTokenHelpLink) msTokenHelpLink.style.display = isMs ? 'inline-flex' : 'none';
    imgKeyLabel.textContent = isMs ? '魔搭访问令牌（Access Token）' : '生图 API Key（留空则复用上方对话 Key）';
    cfgImgApiKey.placeholder = isMs ? 'ms-...' : 'sk-...（留空复用）';
    imgModelLabel.textContent = isMs ? '生图模型（三选一，或下方手填优先）' : '生图模型名称';
    if (isMs) {
      const customVal = cfgMsCustomModel.value.trim();
      const activePreset = customVal ? '' : (draftMsPreset || 'Tongyi-MAI/Z-Image-Turbo');
      document.querySelectorAll('#imgModelPresets [data-img-model]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.imgModel === activePreset);
      });
      imgModelSuggestions.classList.remove('show');
      setImgModelStatus(customVal ? `当前将优先使用手填模型：${customVal}` : `当前已选固定模型：${activePreset}`);
    } else {
      renderImgModelSuggestions(cfgImgModel.value);
      if (!detectedImgModels.length) setImgModelStatus('');
    }
    imgHintText.textContent = isMs
      ? '魔搭每日约 250 魔粒免费额度；留空手填框时改图/换装自动切 Qwen-2.1，手填了别的模型名就用填的。'
      : '支持标准同步、ref="last" 改图与 task_id 异步轮询（后台并发，超时 200 秒）。';
  }

  if (fetchImgModelsBtn) {
    fetchImgModelsBtn.onclick = () => detectAvailableImgModels();
  }
  document.querySelectorAll('#imgProviderPicker [data-img-provider]').forEach(btn => {
    btn.onclick = () => {
      syncImgProviderUI(btn.dataset.imgProvider, draftImgTrigger);
      syncSettingsAccordionBadges();
    };
  });
  document.querySelectorAll('#imgModelPresets [data-img-model]').forEach(btn => {
    btn.onclick = () => {
      draftMsPreset = btn.dataset.imgModel;
      if (cfgMsCustomModel) cfgMsCustomModel.value = '';
      syncImgProviderUI(draftImgProvider, draftImgTrigger);
    };
  });
  if (cfgMsCustomModel) {
    cfgMsCustomModel.addEventListener('input', () => syncImgProviderUI(draftImgProvider, draftImgTrigger));
  }
  cfgImgModel.addEventListener('input', () => renderImgModelSuggestions(cfgImgModel.value));
  document.querySelectorAll('#imgTriggerPicker [data-img-trigger]').forEach(btn => {
    btn.onclick = () => syncImgProviderUI(draftImgProvider, btn.dataset.imgTrigger);
  });

  function renderCharacterBar() {
    if (!charBarEl) return;
    const chars = Array.isArray(runtime.state.characters) ? runtime.state.characters : [];
    charBarEl.innerHTML = '';
    chars.forEach(c => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'char-pill' + (c.id === runtime.state.activeCharId ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'char-pill-dot';
      ui.applyAvatarToEl?.(dot, c.name, c.avatarImage, c.avatarColor);
      const label = document.createElement('span');
      label.textContent = c.name || '未命名';
      pill.appendChild(dot);
      pill.appendChild(label);
      pill.onclick = () => switchCharacter(c.id);
      charBarEl.appendChild(pill);
    });
    const addPill = document.createElement('button');
    addPill.type = 'button';
    addPill.className = 'char-pill add';
    addPill.textContent = '+ 新建';
    addPill.onclick = () => setCompanionSubView('create');
    charBarEl.appendChild(addPill);

    if (deleteCharBtn) {
      deleteCharBtn.style.display = chars.length > 1 ? 'inline-flex' : 'none';
    }
  }

  function syncWallpaperBtnsUI() {
    const wpBtn = document.getElementById('cfgWallpaperBtn');
    const clearBtn = document.getElementById('cfgWallpaperClearBtn');
    if (wpBtn) wpBtn.textContent = draftWallpaper ? '🖼 换一张壁纸' : '🖼 聊天壁纸';
    if (clearBtn) clearBtn.style.display = draftWallpaper ? 'inline-flex' : 'none';
    syncSettingsAccordionBadges();
  }

  const wallpaperFileInput = document.getElementById('wallpaperFileInput');
  const cfgWallpaperBtn = document.getElementById('cfgWallpaperBtn');
  const cfgWallpaperClearBtn = document.getElementById('cfgWallpaperClearBtn');
  if (cfgWallpaperBtn && wallpaperFileInput) {
    cfgWallpaperBtn.onclick = () => wallpaperFileInput.click();
    wallpaperFileInput.onchange = async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const res = await compressImageFile(file, 1440, 0.82);
        draftWallpaper = res.dataUrl;
        runtime.state.settings.wallpaper = draftWallpaper;
        flushActiveCharToList();
        scheduleSave();
        syncWallpaperBtnsUI();
        ((wp) => { const l=document.getElementById('chatBgLayer'), v=document.getElementById('chatBgVeil'); if(!l||!v) return; if(wp){l.style.backgroundImage=`url(${wp})`;l.classList.add('show');v.classList.add('show');}else{l.style.backgroundImage='';l.classList.remove('show');v.classList.remove('show');} })(draftWallpaper);
        showWarn('✓ 已设为当前角色专属聊天壁纸', true);
        setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2000);
      } catch (err) {
        showWarn(err.message);
      } finally {
        wallpaperFileInput.value = '';
      }
    };
  }
  if (cfgWallpaperClearBtn) {
    cfgWallpaperClearBtn.onclick = () => {
      draftWallpaper = '';
      runtime.state.settings.wallpaper = '';
      flushActiveCharToList();
      scheduleSave();
      syncWallpaperBtnsUI();
      ((wp) => { const l=document.getElementById('chatBgLayer'), v=document.getElementById('chatBgVeil'); if(!l||!v) return; if(wp){l.style.backgroundImage=`url(${wp})`;l.classList.add('show');v.classList.add('show');}else{l.style.backgroundImage='';l.classList.remove('show');v.classList.remove('show');} })('');
    };
  }

  function syncDraftCharFieldsIfModalOpen() {
    if (!settingsModal.classList.contains('show')) return;
    const active = getActiveCharacter();
    if (!active) return;
    runtime.state.settings.name = document.getElementById('cfgName').value.trim() || runtime.state.settings.name;
    runtime.state.settings.age = cfgAge.value.trim();
    runtime.state.settings.gender = draftGender;
    runtime.state.settings.chatMode = draftChatMode;
    runtime.state.settings.persona = document.getElementById('cfgPersona').value.trim() || runtime.state.settings.persona;
    runtime.state.settings.anchors = (document.getElementById('cfgAnchors')?.value || '').trim();
    runtime.state.settings.sampleDialogue = (document.getElementById('cfgSampleDialogue')?.value || '').trim();
    runtime.state.settings.appearance = cfgAppearance.value.trim();
    runtime.state.settings.avatarImage = draftAvatarImage;
    runtime.state.settings.wallpaper = draftWallpaper;
    runtime.state.memorySummary = memSummaryInput.value.trim().slice(0, 1200);
    flushActiveCharToList();
  }

  function applyCardToEditorFields(card) {
    draftAvatarImage = card.avatarImage || '';
    draftWallpaper = card.wallpaper || '';
    draftGender = card.gender || '';
    draftChatMode = card.chatMode === 'story' ? 'story' : 'wechat';
    document.getElementById('cfgName').value = card.name || '';
    cfgAge.value = card.age || '';
    document.getElementById('cfgPersona').value = card.persona || '';
    const anchorsEl = document.getElementById('cfgAnchors');
    if (anchorsEl) anchorsEl.value = card.anchors || '';
    const sampleEl = document.getElementById('cfgSampleDialogue');
    if (sampleEl) sampleEl.value = card.sampleDialogue || '';
    cfgAppearance.value = card.appearance || '';
    memSummaryInput.value = card.memorySummary || '';
    const greetingField = document.getElementById('cfgGreetingField');
    const greetingInput = document.getElementById('cfgGreeting');
    if (greetingField && greetingInput) {
      const isActiveCard = !card.id || card.id === runtime.state.activeCharId;
      const cardMsgs = isActiveCard ? runtime.state.messages : (Array.isArray(card.messages) ? card.messages : []);
      const hasChatted = cardMsgs.some(m => m && (m.role === 'user' || m.role === 'event'));
      greetingField.style.display = hasChatted ? 'none' : 'block';
      const starterMsg = cardMsgs.find(m => m?.isStarter || m?.role === 'assistant');
      greetingInput.value = starterMsg?.text || '';
    }
    syncGenderPickerUI('cfgGenderPicker', draftGender);
    syncChatModePickerUI();
    refreshAvatarEditPreview();
    syncWallpaperBtnsUI();
    syncSettingsAccordionBadges();
  }

  function switchCharacter(charId) {
    if (runtime.isBusy) {
      showWarn('当前正在回复中，稍等一下再切换角色哦', true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2200);
      return;
    }
    if (charId === runtime.state.activeCharId) return;
    ui.exitSelectMode?.();
    ui.closeStickerDrawer?.();
    ui.cancelPendingSendBurst?.();
    ui.clearPendingQuote?.();
    syncDraftCharFieldsIfModalOpen();
    flushActiveCharToList();
    const target = runtime.state.characters.find(c => c.id === charId);
    if (!target) return;
    runtime.pendingEventQueue = [];
    clearTimeout(runtime.eventFlushTimer);
    runtime.lastWindowStartIndex = 0;
    runtime.visibleChatStart = -1;
    draftAiGreeting = '';
    runtime.personaShiftPending = false;
    loadCharacterIntoRuntime(target);
    if (settingsModal.classList.contains('show')) {
      applyCardToEditorFields(target);
    } else {
      draftAvatarImage = target.avatarImage || '';
    }
    refreshMemoryView();
    renderCharacterBar();
    ui.renderHeader?.();
    ui.syncChatModeQuickBtn?.();
    ui.renderChat?.();
    ui.renderWidgets?.();
    updateMemStats();
    scheduleSave();
  }

  document.querySelectorAll('#charTplPicker [data-char-tpl]').forEach(btn => {
    btn.onclick = () => {
      if (runtime.isBusy) return;
      const tplKey = btn.dataset.charTpl;
      const tpl = CHAR_TEMPLATES[tplKey] || CHAR_TEMPLATES.blank;
      syncDraftCharFieldsIfModalOpen();
      flushActiveCharToList();
      const card = makeCharacterCard({
        name: tpl.name,
        age: tpl.age || '',
        gender: tpl.gender || '',
        persona: tpl.persona,
        avatarColor: tpl.avatarColor,
        greeting: tpl.greeting,
        widgets: [cloneStarterWidget()]
      });
      runtime.state.characters.push(card);
      runtime.pendingEventQueue = [];
      runtime.lastWindowStartIndex = 0;
      runtime.visibleChatStart = -1;
      draftAiGreeting = '';
      runtime.personaShiftPending = false;
      loadCharacterIntoRuntime(card);
      applyCardToEditorFields(card);
      setCompanionSubView('edit');
      renderCharacterBar();
      renderMemoryModalList();
        renderSceneStatesList();
      ui.renderHeader?.();
      ui.syncChatModeQuickBtn?.();
      ui.renderChat?.();
      ui.renderWidgets?.();
      updateMemStats();
      scheduleSave();
    };
  });

  deleteCharBtn.onclick = () => {
    if (runtime.isBusy || runtime.state.characters.length <= 1) return;
    const active = getActiveCharacter();
    if (!confirm(`确定删除「${active?.name || '当前角色'}」及其独立聊天记录与记忆吗？`)) return;
    runtime.state.characters = runtime.state.characters.filter(c => c.id !== runtime.state.activeCharId);
    const fallback = runtime.state.characters[0];
    runtime.pendingEventQueue = [];
    ui.exitSelectMode?.();
    ui.closeStickerDrawer?.();
    ui.cancelPendingSendBurst?.();
    ui.clearPendingQuote?.();
    runtime.lastWindowStartIndex = 0;
    runtime.visibleChatStart = -1;
    draftAiGreeting = '';
    runtime.personaShiftPending = false;
    loadCharacterIntoRuntime(fallback);
    applyCardToEditorFields(fallback);
    renderCharacterBar();
    renderMemoryModalList();
        renderSceneStatesList();
    ui.renderHeader?.();
    ui.syncChatModeQuickBtn?.();
    ui.renderChat?.();
    ui.renderWidgets?.();
    updateMemStats();
    scheduleSave();
  };

  document.getElementById('clearCurrentChatBtn').onclick = () => {
    if (runtime.isBusy) return;
    const name = document.getElementById('cfgName').value.trim() || runtime.state.settings.name || '当前角色';
    if (!confirm(`清空与「${name}」的聊天记录？（TA 的人设、长期记忆与家里小组件都会保留）`)) return;
    const greetingVal = document.getElementById('cfgGreeting')?.value.trim() || '';
    runtime.state.messages = [{ id: `msg_init_${Date.now()}`, role: 'assistant', text: greetingVal || buildNaturalStarter(name), isStarter: true, createdAt: Date.now() }];
    runtime.state.sceneStates = [];
    runtime.state.summarizedCount = 0;
    runtime.visibleChatStart = -1;
    runtime.lastWindowStartIndex = 0;
    runtime.personaShiftPending = false;
    ui.exitSelectMode?.();
    ui.closeStickerDrawer?.();
    ui.cancelPendingSendBurst?.();
    ui.clearPendingQuote?.();
    flushActiveCharToList();
    refreshMemoryView();
    scheduleSave();
    applyCardToEditorFields({
      id: runtime.state.activeCharId,
      name,
      age: cfgAge.value.trim(),
      gender: draftGender,
      chatMode: draftChatMode,
      persona: document.getElementById('cfgPersona').value.trim(),
      anchors: (document.getElementById('cfgAnchors')?.value || '').trim(),
      sampleDialogue: (document.getElementById('cfgSampleDialogue')?.value || '').trim(),
      appearance: cfgAppearance.value.trim(),
      avatarImage: draftAvatarImage,
      wallpaper: draftWallpaper,
      memorySummary: memSummaryInput.value.trim(),
      messages: runtime.state.messages
    });
    ui.renderChat?.();
    showWarn(`已清空「${name}」的聊天记录`, true);
    setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2200);
  };

  document.getElementById('exportChatTxtBtn').onclick = async () => {
    syncDraftCharFieldsIfModalOpen();
    flushActiveCharToList();
    const active = getActiveCharacter();
    if (!active) return;
    const lines = active.messages
      .filter(m => m && !m.imgPending && (m.role === 'user' || m.role === 'assistant'))
      .map(m => {
        const who = m.role === 'user' ? '我' : (active.name || '伴侣');
        const ts = m.createdAt ? new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false }) : '';
        const body = m.image ? `[图片] ${m.text || ''}`.trim() : (m.text || '');
        return `[${ts}] ${who}：${body}`;
      });
    const txt = `Roomi 聊天记录 · ${active.name || '伴侣'}\n导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n====================================\n\n` + lines.join('\n\n');
    const fileName = `roomi-chat-${active.name || 'chat'}-${todayKey()}.txt`;
    const fs = window.Capacitor?.Plugins?.Filesystem;
    if (fs?.writeFile) {
      try {
        await fs.writeFile({ path: `Roomi/${fileName}`, data: txt, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
        showWarn(`✓ 已导出到文档 Roomi/${fileName}`, true);
        setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2600);
        return;
      } catch {}
    }
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };

  document.getElementById('exportCharBtn').onclick = () => {
    syncDraftCharFieldsIfModalOpen();
    flushActiveCharToList();
    const active = getActiveCharacter();
    if (!active) return;
    const firstGreeting = active.messages.find(m => m.role === 'assistant' && m.text)?.text || '';
    const cardPayload = {
      _type: 'roomi_character_card',
      version: 1,
      name: active.name,
      age: active.age || '',
      gender: active.gender || '',
      chatMode: active.chatMode || 'wechat',
      persona: active.persona,
      anchors: active.anchors || '',
      sampleDialogue: active.sampleDialogue || '',
      appearance: active.appearance || '',
      avatarImage: active.avatarImage || '',
      wallpaper: active.wallpaper || '',
      avatarColor: active.avatarColor || '',
      greeting: firstGreeting ? [firstGreeting] : undefined
    };
    const blob = new Blob([JSON.stringify(cardPayload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `roomi-card-${active.name}-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };


  function renderSceneStatesList() {
    const listEl = document.getElementById('sceneStateList');
    const countEl = document.getElementById('sceneStateCount');
    if (!listEl) return;
    const activeStates = pruneSceneStates(runtime.state.sceneStates);
    if (countEl) countEl.textContent = activeStates.length ? `(${activeStates.length})` : '';
    listEl.innerHTML = '';
    if (!activeStates.length) {
      listEl.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:10px;text-align:center;background:var(--bg-sub);border-radius:10px;">当前没有生效中的短时场景状态</div>`;
      return;
    }
    activeStates.forEach(s => {
      const row = document.createElement('div');
      row.className = 'mem-item';
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <span class="mem-item-key">${escapeHtml(s.key)}</span>
          <span>${escapeHtml(s.value)}</span>
          <span class="scene-state-age">${escapeHtml(formatSceneAge(s.updatedAt))}</span>
        </div>
        <div class="mem-actions">
          <button type="button" class="mini-btn danger" data-act="del" title="删除此场景状态">✕</button>
        </div>`;
      row.querySelector('[data-act="del"]').onclick = () => {
        removeSceneStateByKey(s.key);
        scheduleSave();
        renderSceneStatesList();
        updateMemStats();
      };
      listEl.appendChild(row);
    });
  }

  const clearSceneStatesBtn = document.getElementById('clearSceneStatesBtn');
  if (clearSceneStatesBtn) {
    clearSceneStatesBtn.onclick = () => {
      runtime.state.sceneStates = [];
      scheduleSave();
      renderSceneStatesList();
      updateMemStats();
    };
  }


  const importCharInput = document.getElementById('importCharInput');
  document.getElementById('importCharBtn').onclick = () => {
    if (!runtime.isBusy) importCharInput.click();
  };
  importCharInput.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file || runtime.isBusy) {
      importCharInput.value = '';
      return;
    }
    try {
      const isPng = file.type === 'image/png' || /\.png$/i.test(file.name || '');
      let parsed;
      let pngAvatar = '';
      if (isPng) {
        parsed = await extractCharaFromPng(file);
        try {
          const avRes = await compressImageFile(file, 320, 0.88);
          pngAvatar = avRes.dataUrl;
        } catch {}
      } else {
        parsed = JSON.parse(await file.text());
      }
      const norm = normalizeImportedCardData(parsed, pngAvatar);
      ui.cancelPendingSendBurst?.();
      ui.clearPendingQuote?.();
      syncDraftCharFieldsIfModalOpen();
      flushActiveCharToList();
      const card = makeCharacterCard({
        name: norm.name,
        age: norm.age,
        gender: norm.gender,
        chatMode: norm.chatMode,
        persona: norm.persona,
        anchors: norm.anchors,
        sampleDialogue: norm.sampleDialogue,
        appearance: norm.appearance,
        avatarImage: norm.avatarImage,
        wallpaper: norm.wallpaper,
        avatarColor: norm.avatarColor,
        greeting: norm.greeting.length ? norm.greeting : undefined,
        widgets: [cloneStarterWidget()]
      });
      runtime.state.characters.push(card);
      runtime.pendingEventQueue = [];
      runtime.lastWindowStartIndex = 0;
      runtime.visibleChatStart = -1;
      draftAiGreeting = '';
      runtime.personaShiftPending = false;
      loadCharacterIntoRuntime(card);
      applyCardToEditorFields(card);
      setCompanionSubView('edit');
      renderCharacterBar();
      renderMemoryModalList();
      renderSceneStatesList();
      ui.renderHeader?.();
      ui.syncChatModeQuickBtn?.();
      ui.renderChat?.();
      ui.renderWidgets?.();
      updateMemStats();
      scheduleSave();
      aiPersonaStatus.textContent = `✓ 已导入并切换到「${card.name}」，可随时微调`;
      aiPersonaStatus.className = 'model-status ok';
    } catch (err) {
      showWarn(`导入角色卡失败：${err.message}`);
    } finally {
      importCharInput.value = '';
    }
  };

  async function buildCharacterWithAI({ seedText, personality, appearance, relation, habits, statusEl, btnEl, idleLabel }) {
    const curName = document.getElementById('cfgName').value.trim();
    const curGender = draftGender;
    const key = (cfgApiKey.value || runtime.state.settings.apiKey || '').trim();
    const base = (cfgBaseUrl.value || runtime.state.settings.baseUrl || '').trim().replace(/\/+$/, '');
    const model = (cfgModel.value || runtime.state.settings.model || '').trim();

    if (!key || !base || !model) {
      const p = personality || '温柔体贴、偶尔嘴硬';
      const r = relation || '贴心伴侣';
      const a = appearance || '';
      const h = habits || '爱关心你的作息与日常';
      const fallbackName = (!curName || curName === '新伙伴') ? (curGender === '男' ? '顾言' : '夏知') : curName;
      if (!curName || curName === '新伙伴') document.getElementById('cfgName').value = fallbackName;
      document.getElementById('cfgPersona').value =
        `你是用户的${r}「${fallbackName}」${curGender ? '（' + curGender + '）' : ''}，性格${p}。平时有着${h}的小习惯。说话像真人微信聊天一样自然口语、短句为主，懂得分寸和偏心你，绝不端着说教或用列表腔。`;
      if (a) cfgAppearance.value = a;
      draftAiGreeting = `嗨～我是${fallbackName}，刚收拾好过来找你了，今天过得怎么样？`;
      refreshAvatarEditPreview();
      statusEl.textContent = '已按你的选择在本地拼好角色卡（填入对话 Key 后可由 AI 深度发挥）';
      statusEl.className = 'model-status ok';
      return;
    }

    btnEl.disabled = true;
    btnEl.textContent = '捏人中…';
    statusEl.textContent = '正在根据你的设定生成角色卡…';
    statusEl.className = 'model-status';
    try {
      const traits = [
        curGender ? `性别：${curGender}` : '',
        personality ? `性格气质：${personality}` : '',
        relation ? `与用户关系：${relation}` : '',
        appearance ? `外貌与身材：${appearance}` : '',
        habits ? `喜好与小习惯：${habits}` : '',
        seedText ? `原有/补充设定：${seedText}` : ''
      ].filter(Boolean).join('\n');

      const curAnchors = (document.getElementById('cfgAnchors')?.value || '').trim();
      const curSample = (document.getElementById('cfgSampleDialogue')?.value || '').trim();
      const ask = `请基于以下设定，润色并丰满这张角色卡，让 TA 聊起来像真实活人而非客服：
当前名称：${curName && curName !== '新伙伴' ? curName : '未定（请起一个自然有烟火气的名字）'}
${traits || '有鲜明性格与反差感的伴侣'}
${curAnchors ? `已有防飘规则（请优先保留原意再微调）：${curAnchors}` : ''}
${curSample ? `已有说话示范（请优先保留原有口吻再润色补充）：\n${curSample}` : ''}

要求：
1. 完整保留原有核心设定与关系定位，不篡改用户已定的风格、口癖或称呼；
2. persona 用第二人称（“你是…”）写，140~240字，把抽象性格改写成具体习惯、互动细节与情绪表达方式；
3. anchors（35~80字）提炼该角色专属的称呼、标点/句长风格及典型反应习惯；
4. sampleDialogue 写出 3 组贴合该角色画风的对白示范（每行一组「用户：... → TA：...」，多条短句可用 ||| 分隔）；
5. 只输出纯 JSON：
{"name":"角色名字","persona":"140~240字完整人设","anchors":"语言指纹与防飘铁规","sampleDialogue":"三行对话示范","appearance":"15~35字外貌身材穿搭描述","greeting":"1~2句自然开场白"}`;

      const res = await fetchWithTimeout(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0.85, stream: false, messages: [{ role: 'user', content: ask }] })
      }, 45000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw = stripThinkingTags(json.choices?.[0]?.message?.content || '');
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.name && (!curName || curName === '新伙伴')) {
          document.getElementById('cfgName').value = String(parsed.name).trim();
        }
        if (parsed.persona) {
          document.getElementById('cfgPersona').value = String(parsed.persona).trim();
        }
        if (parsed.anchors) {
          const anchorsEl = document.getElementById('cfgAnchors');
          if (anchorsEl) anchorsEl.value = String(parsed.anchors).trim();
        }
        if (parsed.sampleDialogue) {
          const sampleEl = document.getElementById('cfgSampleDialogue');
          if (sampleEl) {
            sampleEl.value = Array.isArray(parsed.sampleDialogue)
              ? parsed.sampleDialogue.join('\n').trim()
              : String(parsed.sampleDialogue).trim();
          }
        }
        if (parsed.appearance) {
          cfgAppearance.value = String(parsed.appearance).trim();
        }
        if (parsed.greeting) {
          draftAiGreeting = String(parsed.greeting).trim();
        }
      } else if (raw.trim()) {
        document.getElementById('cfgPersona').value = raw.trim();
      }
      refreshAvatarEditPreview();
      syncSettingsAccordionBadges();
      statusEl.textContent = '✓ 角色已捏好，点下方「保存并应用」立刻生效';
      statusEl.className = 'model-status ok';
    } catch (err) {
      statusEl.textContent = `生成失败：${err.message}`;
      statusEl.className = 'model-status err';
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = idleLabel;
    }
  }

  gbGenerateBtn.onclick = async () => {
    if (runtime.isBusy) return;
    const customName = gbName.value.trim();
    const customAge = gbAge.value.trim();
    const customGender = gbDraftGender;
    const personality = gbPersonality.value.trim();
    const relation = gbRelation.value.trim() || '私密恋人';
    const appearance = gbAppearance.value.trim();
    const habits = gbHabits.value.trim();
    const key = (cfgApiKey.value || runtime.state.settings.apiKey || '').trim();
    const base = (cfgBaseUrl.value || runtime.state.settings.baseUrl || '').trim().replace(/\/+$/, '');
    const model = (cfgModel.value || runtime.state.settings.model || '').trim();

    let genName = customName || (customGender === '男' ? '顾言' : '夏知');
    let genAge = customAge || '22';
    let genPersona = `你是用户的${relation}「${genName}」${customGender ? '（' + customGender + '）' : ''}${genAge ? '，' + genAge + '岁' : ''}，性格${personality || '温柔体贴又带点黏人撒娇'}。平时有着${habits || '深夜喜欢黏着你聊天的'}习惯。只对用户一个人偏心软萌、绝不端着或说教，说话自然像两个人的亲密微信私聊。`;
    let genAppearance = appearance;
    let genGreeting = buildNaturalStarter(genName);
    let genAnchors = '';
    let genSampleDialogue = '';

    if (key && base && model) {
      gbGenerateBtn.disabled = true;
      gbGenerateBtn.textContent = '生成角色卡中…';
      gbStatus.textContent = '正在为你生成专属角色卡…';
      gbStatus.className = 'model-status';
      try {
        const traits = [
          customName ? `姓名：${customName}` : '姓名：未定（请起一个自然好听的中文名）',
          customGender ? `性别：${customGender}` : '',
          customAge ? `年龄：${customAge}` : '',
          appearance ? `身材与外貌：${appearance}` : '',
          personality ? `性格气质：${personality}` : '',
          `与用户关系：${relation}`,
          habits ? `喜好与小习惯：${habits}` : ''
        ].filter(Boolean).join('\n');

        const ask = `请根据以下要素，为伴侣聊天 App 生成一张极具“活人感”的角色卡：
${traits}

要求：
1. 若用户已指定姓名、年龄、性别，必须严格沿用；
2. persona 用第二人称（“你是…”）写，140~240字，重点写性格里的真实反差、具体生活习惯、对用户的独特偏心方式与底线，少堆砌空泛形容词；
3. anchors（35~80字）写该角色专属的“语言指纹”：包含怎么称呼用户、标点与句长习惯（如偏爱短句还是细腻长句、用不用波浪号/句号）、以及遇到“被夸 / 被敷衍 / 吃醋”时的典型本能反应；
4. sampleDialogue 写 3 组不同情景的真实对话示范（每行一组，格式为「用户：... → TA：...」，气泡停顿可用 ||| 隔开）：
   - 第 1 组：日常随口闲聊
   - 第 2 组：用户只发极短或敷衍回复（如“哦哦”“嗯”）时 TA 的反应
   - 第 3 组：亲密互动、关心或带点小情绪时的反应
5. 只输出纯 JSON，不要附加解释：
{"name":"姓名","age":"年龄数字","persona":"完整人设","anchors":"称呼、标点句长习惯与典型反应","sampleDialogue":"三行对话示范","appearance":"15~35字身材外貌穿搭描述","greeting":"1句自然不端着的开场白"}`;

        const res = await fetchWithTimeout(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model, temperature: 0.85, stream: false, messages: [{ role: 'user', content: ask }] })
        }, 45000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const raw = stripThinkingTags(json.choices?.[0]?.message?.content || '');
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          if (!customName && parsed.name) genName = String(parsed.name).trim();
          if (!customAge && parsed.age) genAge = String(parsed.age).trim();
          if (parsed.persona) genPersona = String(parsed.persona).trim();
          if (parsed.anchors) genAnchors = String(parsed.anchors).trim();
          if (parsed.sampleDialogue) {
            genSampleDialogue = Array.isArray(parsed.sampleDialogue)
              ? parsed.sampleDialogue.join('\n').trim()
              : String(parsed.sampleDialogue).trim();
          }
          if (parsed.appearance) genAppearance = String(parsed.appearance).trim();
          if (parsed.greeting) genGreeting = String(parsed.greeting).trim();
        }
      } catch (err) {
        gbStatus.textContent = `生成失败：${err.message}`;
        gbStatus.className = 'model-status err';
        gbGenerateBtn.disabled = false;
        gbGenerateBtn.textContent = '✨ 自动生成角色卡';
        return;
      } finally {
        gbGenerateBtn.disabled = false;
        gbGenerateBtn.textContent = '✨ 自动生成角色卡';
      }
    }

    syncDraftCharFieldsIfModalOpen();
    flushActiveCharToList();
    const palette = [
      'linear-gradient(135deg, #ec4899 0%, #f472b6 100%)',
      'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
      'linear-gradient(135deg, #10b981 0%, #34d399 100%)',
      'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)'
    ];
    const card = makeCharacterCard({
      name: genName,
      age: genAge,
      gender: customGender,
      persona: genPersona,
      anchors: genAnchors,
      sampleDialogue: genSampleDialogue,
      appearance: genAppearance,
      avatarImage: gbDraftAvatarImage,
      avatarColor: palette[runtime.state.characters.length % palette.length],
      greeting: [genGreeting],
      widgets: [cloneStarterWidget()]
    });
    runtime.state.characters.push(card);

    gbDraftAvatarImage = '';
    gbDraftGender = '';
    [gbName, gbAge, gbPersonality, gbRelation, gbAppearance, gbHabits].forEach(el => { el.value = ''; });
    document.querySelectorAll('#charCreateView .mini-chip.active').forEach(c => c.classList.remove('active'));
    syncGenderPickerUI('gbGenderPicker', '');
    gbStatus.textContent = '';

    runtime.pendingEventQueue = [];
    runtime.lastWindowStartIndex = 0;
    runtime.visibleChatStart = -1;
    draftAiGreeting = '';
    runtime.personaShiftPending = false;
    loadCharacterIntoRuntime(card);
    applyCardToEditorFields(card);
    setCompanionSubView('edit');
    renderCharacterBar();
    renderMemoryModalList();
      renderSceneStatesList();
    ui.renderHeader?.();
    ui.syncChatModeQuickBtn?.();
    ui.renderChat?.();
    ui.renderWidgets?.();
    updateMemStats();
    scheduleSave();
    aiPersonaStatus.textContent = `✓ 已生成「${card.name}」，你可以在下方继续微调，满意后点保存`;
    aiPersonaStatus.className = 'model-status ok';
  };

  aiPersonaBtn.onclick = () => buildCharacterWithAI({
    seedText: document.getElementById('cfgPersona').value.trim(),
    personality: '',
    appearance: [cfgAge.value.trim() ? cfgAge.value.trim() + '岁' : '', cfgAppearance.value.trim()].filter(Boolean).join('，'),
    relation: '',
    habits: '',
    statusEl: aiPersonaStatus,
    btnEl: aiPersonaBtn,
    idleLabel: '✨ AI 润色'
  });

  function openSettingsTo(defaultTab = null, focusKey = false) {
    applyTheme(runtime.state.settings.theme);
    cfgBaseUrl.value = runtime.state.settings.baseUrl;
    cfgApiKey.value = runtime.state.settings.apiKey;
    cfgModel.value = runtime.state.settings.model;
    cfgImgBaseUrl.value = runtime.state.settings.imgBaseUrl || '';
    cfgImgApiKey.value = runtime.state.settings.imgApiKey || '';
    draftMsPreset = runtime.state.settings.msImgPreset || 'Tongyi-MAI/Z-Image-Turbo';
    if (cfgMsCustomModel) cfgMsCustomModel.value = runtime.state.settings.msImgCustomModel || '';
    cfgImgModel.value = runtime.state.settings.openaiImgModel || (runtime.state.settings.imgProvider === 'openai' ? (runtime.state.settings.imgModel || '') : '');
    detectedImgModels = [];
    syncImgProviderUI(runtime.state.settings.imgProvider || 'off', runtime.state.settings.imgTrigger || 'asked');
    draftImgSize = runtime.state.settings.imgDefaultSize || '1152x1536';
    if (cfgImgCustomSize) cfgImgCustomSize.value = runtime.state.settings.imgCustomSize || '';
    syncImgSizePickerUI();
    draftThinkingMode = runtime.state.settings.thinkingMode || 'auto';
    draftContextMode = runtime.state.settings.contextMode || 'long';
    draftTempMode = runtime.state.settings.temperatureMode || 'balanced';
    syncModelTuningPickersUI();
    syncTempPickerUI();
    syncSettingsAccordionBadges();
    draftPrivacyPin = runtime.state.settings.privacyPin || '';
    document.getElementById('cfgDebounceSend').checked = Boolean(runtime.state.settings.debounceSend);
    document.getElementById('cfgAutoGreet').checked = runtime.state.settings.autoGreetOnOpen !== false;
    document.getElementById('cfgDailyNotify').checked = Boolean(runtime.state.settings.dailyNotify);
    document.getElementById('cfgNotifyMorning').value = runtime.state.settings.notifyMorning || '08:30';
    document.getElementById('cfgNotifyNight').value = runtime.state.settings.notifyNight || '23:30';
    syncNotifyTimesRowUI();
    document.getElementById('cfgPrivacyLock').checked = Boolean(runtime.state.settings.privacyLock);
    syncPrivacyPinStatusUI();
    applyCardToEditorFields({
      id: runtime.state.activeCharId,
      name: runtime.state.settings.name,
      age: runtime.state.settings.age || '',
      gender: runtime.state.settings.gender || '',
      chatMode: runtime.state.settings.chatMode || 'wechat',
      persona: runtime.state.settings.persona,
      anchors: runtime.state.settings.anchors || '',
      sampleDialogue: runtime.state.settings.sampleDialogue || '',
      appearance: runtime.state.settings.appearance || '',
      avatarImage: runtime.state.settings.avatarImage || '',
      wallpaper: runtime.state.settings.wallpaper || '',
      memorySummary: runtime.state.memorySummary || ''
    });
    document.getElementById('cfgAutoReact').checked = runtime.state.settings.autoReact;
    draftAiGreeting = '';
    memCompressStatus.textContent = '';
    memCompressStatus.className = 'model-status';
    aiPersonaStatus.textContent = '';
    aiPersonaStatus.className = 'model-status';
    gbStatus.textContent = '';
    gbStatus.className = 'model-status';
    syncProviderPickerUI(runtime.state.settings.baseUrl, false);
    if (detectedModels.length) {
      renderModelSuggestions('');
    } else if (cfgApiKey.value.trim()) {
      setModelStatus('点右上「↻ 检测模型」可拉取最新列表');
    } else {
      setModelStatus('');
      renderModelSuggestions();
    }
    renderCharacterBar();
    renderMemoryModalList();
      renderSceneStatesList();
    updateMemStats();
    const chosenTab = defaultTab || (String(runtime.state.settings.apiKey || "").trim() ? 'companion' : 'model');
    setCompanionSubView('edit');
    switchSettingsTab(chosenTab);
    settingsModal.classList.add('show');
    if (focusKey && chosenTab === 'model') {
      setTimeout(() => cfgApiKey.focus(), 180);
    }
  }

  document.getElementById('openSettingsBtn').onclick = () => {
    openSettingsTo(null, !String(runtime.state.settings.apiKey || "").trim());
  };
  document.getElementById('modeBadge').onclick = () => {
    openSettingsTo('model', !String(runtime.state.settings.apiKey || "").trim());
  };
  document.getElementById('keyGuideGoBtn').onclick = () => {
    openSettingsTo('model', true);
  };
  document.getElementById('keyGuideCloseBtn').onclick = () => {
    runtime.keyGuideDismissedSession = true;
    document.getElementById('keyGuideBanner').classList.remove('show');
  };

  document.getElementById('closeSettingsBtn').onclick = () => settingsModal.classList.remove('show');
  settingsModal.addEventListener('click', e => {
    if (e.target === settingsModal) settingsModal.classList.remove('show');
  });

  document.getElementById('resetModelCompatBtn').onclick = () => {
    clearModelCompatCache('', '', true);
    scheduleSave();
    showWarn('已重置模型思考与识图兼容缓存，下一条消息会自动重新探测', true);
    setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2600);
  };

  document.getElementById('saveSettingsBtn').onclick = async () => {
    const prevBaseUrl = runtime.state.settings.baseUrl || '';
    const prevModel = runtime.state.settings.model || '';
    const prevThinkingMode = runtime.state.settings.thinkingMode || 'auto';
    const prevName = runtime.state.settings.name;
    const prevAge = runtime.state.settings.age || '';
    const prevGender = runtime.state.settings.gender || '';
    const prevChatMode = runtime.state.settings.chatMode || 'wechat';
    const prevPersona = runtime.state.settings.persona;
    const prevAnchors = runtime.state.settings.anchors || '';
    const prevSample = runtime.state.settings.sampleDialogue || '';
    const prevAppearance = runtime.state.settings.appearance || '';

    const wantLock = document.getElementById('cfgPrivacyLock').checked;
    if (wantLock && (!draftPrivacyPin || draftPrivacyPin.length !== 4)) {
      showWarn('开启隐私锁前，请先点击下方「设置密码」设好 4 位数字密码', true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2500);
      return;
    }

    const ctxTier = CONTEXT_TIERS[draftContextMode] || CONTEXT_TIERS.long;
    runtime.state.settings._v = 11;
    runtime.state.settings.baseUrl = cfgBaseUrl.value.trim();
    runtime.state.settings.apiKey = cfgApiKey.value.trim();
    runtime.state.settings.model = cfgModel.value.trim();
    runtime.state.settings.thinkingMode = draftThinkingMode || 'auto';
    if (
      prevBaseUrl !== runtime.state.settings.baseUrl ||
      prevModel !== runtime.state.settings.model ||
      prevThinkingMode !== runtime.state.settings.thinkingMode
    ) {
      clearModelCompatCache(prevBaseUrl, prevModel);
      clearModelCompatCache(runtime.state.settings.baseUrl, runtime.state.settings.model);
    }
    runtime.state.settings.contextMode = draftContextMode || 'long';
    runtime.state.settings.maxContextChars = ctxTier.chars;
    runtime.state.settings.maxContextMsgs = ctxTier.msgs;
    runtime.state.settings.temperatureMode = draftTempMode || 'balanced';
    runtime.state.settings.imgProvider = draftImgProvider;
    runtime.state.settings.imgBaseUrl = cfgImgBaseUrl.value.trim();
    runtime.state.settings.imgApiKey = cfgImgApiKey.value.trim();
    runtime.state.settings.msImgPreset = draftMsPreset || 'Tongyi-MAI/Z-Image-Turbo';
    runtime.state.settings.msImgCustomModel = cfgMsCustomModel ? cfgMsCustomModel.value.trim() : '';
    runtime.state.settings.openaiImgModel = cfgImgModel.value.trim();
    runtime.state.settings.imgModel = draftImgProvider === 'modelscope'
      ? (runtime.state.settings.msImgCustomModel || runtime.state.settings.msImgPreset)
      : (draftImgProvider === 'openai' ? runtime.state.settings.openaiImgModel : (runtime.state.settings.imgModel || ''));
    runtime.state.settings.imgTrigger = draftImgTrigger;
    runtime.state.settings.imgDefaultSize = draftImgSize || '1152x1536';
    const rawCustomSz = String(cfgImgCustomSize?.value || '').toLowerCase().replace(/\*/g, 'x').replace(/\s+/g, '').trim();
    runtime.state.settings.imgCustomSize = /^\d{3,4}x\d{3,4}$/.test(rawCustomSz) ? rawCustomSz : '';
    runtime.state.settings.name = document.getElementById('cfgName').value.trim() || '林澈';
    runtime.state.settings.age = cfgAge.value.trim();
    runtime.state.settings.gender = draftGender;
    runtime.state.settings.chatMode = draftChatMode;
    runtime.state.settings.persona = document.getElementById('cfgPersona').value.trim() || DEFAULT_PERSONA;
    runtime.state.settings.anchors = (document.getElementById('cfgAnchors')?.value || '').trim();
    runtime.state.settings.sampleDialogue = (document.getElementById('cfgSampleDialogue')?.value || '').trim();
    runtime.state.settings.appearance = cfgAppearance.value.trim();
    runtime.state.settings.avatarImage = draftAvatarImage;
    runtime.state.settings.wallpaper = draftWallpaper;
    runtime.state.settings.debounceSend = document.getElementById('cfgDebounceSend').checked;
    runtime.state.settings.autoReact = document.getElementById('cfgAutoReact').checked;
    runtime.state.settings.autoGreetOnOpen = document.getElementById('cfgAutoGreet').checked;
    runtime.state.settings.dailyNotify = document.getElementById('cfgDailyNotify').checked;
    runtime.state.settings.notifyMorning = document.getElementById('cfgNotifyMorning').value || '08:30';
    runtime.state.settings.notifyNight = document.getElementById('cfgNotifyNight').value || '23:30';
    runtime.state.settings.privacyLock = wantLock;
    runtime.state.settings.privacyPin = draftPrivacyPin;
    runtime.state.settings.stream = true;
    runtime.state.memorySummary = memSummaryInput.value.trim().slice(0, 1200);

    const hasUserChatted = runtime.state.messages.some(m => m && (m.role === 'user' || m.role === 'event'));
    const editedGreeting = document.getElementById('cfgGreeting')?.value.trim() || '';
    if (!hasUserChatted) {
      if (draftAiGreeting) {
          runtime.state.messages = [{ id: `msg_init_${Date.now()}`, role: 'assistant', text: draftAiGreeting, isStarter: true, createdAt: Date.now() }];
        } else if (editedGreeting) {
          const curStarter = runtime.state.messages.find(m => m?.isStarter || m?.role === 'assistant');
          const nextText = (prevName && prevName !== runtime.state.settings.name && editedGreeting.includes(prevName))
            ? editedGreeting.split(prevName).join(runtime.state.settings.name)
            : editedGreeting;
          if (curStarter) {
            curStarter.text = nextText;
          } else {
            runtime.state.messages = [{ id: `msg_init_${Date.now()}`, role: 'assistant', text: nextText, isStarter: true, createdAt: Date.now() }];
          }
        } else {
          runtime.state.messages = [{ id: `msg_init_${Date.now()}`, role: 'assistant', text: buildNaturalStarter(runtime.state.settings.name), isStarter: true, createdAt: Date.now() }];
        }
    } else if (
      prevName !== runtime.state.settings.name ||
      prevAge !== runtime.state.settings.age ||
      prevGender !== runtime.state.settings.gender ||
      prevChatMode !== runtime.state.settings.chatMode ||
      prevPersona !== runtime.state.settings.persona ||
      prevAnchors !== runtime.state.settings.anchors ||
      prevSample !== runtime.state.settings.sampleDialogue ||
      prevAppearance !== runtime.state.settings.appearance
    ) {
      runtime.personaShiftPending = true;
    }
    draftAiGreeting = '';

    flushActiveCharToList();
    scheduleSave();
    ui.renderHeader?.();
    ui.syncChatModeQuickBtn?.();
    ui.renderChat?.();
    updateMemStats();
    settingsModal.classList.remove('show');
    ui.syncDailyNotifications?.(runtime.state.settings.dailyNotify);
  };

  document.getElementById('exportDataBtn').onclick = async () => {
    syncDraftCharFieldsIfModalOpen();
    flushActiveCharToList();
    const btn = document.getElementById('exportDataBtn');
    const includeKeys = document.getElementById('cfgBackupIncludeKeys')?.checked !== false;
    const passEl = document.getElementById('cfgBackupPassphrase');
    const passphrase = passEl ? passEl.value.trim() : '';
    btn.disabled = true;
    btn.textContent = passphrase ? '加密备份中…' : '备份中…';
    try {
      const pkg = await buildBackupPackage(runtime.state, { includeKeys, passphrase });
      const res = await saveLocalBackupFile(pkg.jsonText, pkg.fileName);
      if (passEl) passEl.value = '';
      const keyTip = includeKeys ? (pkg.encrypted ? '已加密含 Key' : '含 Key 明文') : '不含 Key';
      const locTip = res.mode === 'capacitor_documents' ? `已存至手机 ${res.path}` : `已导出 ${res.path}`;
      showWarn(`✓ 全量备份完成（${keyTip}）：${locTip}`, true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 4200);
    } catch (err) {
      showWarn(`备份失败：${err.message || '请稍后重试'}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '📦 一键本地备份';
    }
  };

  const importFileInput = document.getElementById('importFileInput');
  document.getElementById('importDataBtn').onclick = () => {
    if (!runtime.isBusy) importFileInput.click();
  };
  importFileInput.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file || runtime.isBusy) {
      importFileInput.value = '';
      return;
    }
    try {
      if (file.size > 80 * 1024 * 1024) {
        throw new Error('备份文件超过 80 MB，请确认是否选错了文件');
      }
      const text = await file.text();
      let parsed = JSON.parse(text);
      if (isEncryptedBackup(parsed)) {
        const pass = prompt('这是一份加密备份，请输入导出时设置的解密口令：');
        if (pass === null) return;
        parsed = await decryptBackupPayload(parsed, pass.trim());
      }
      if (!parsed || (!Array.isArray(parsed.characters) && (!Array.isArray(parsed.messages) || !Array.isArray(parsed.widgets)))) {
        throw new Error('备份文件格式不对');
      }
      const sum = summarizeBackupData(parsed);
      const keyLabel = (sum.hasApiKey || sum.hasImgApiKey)
        ? `包含${[sum.hasApiKey ? '对话 API Key' : '', sum.hasImgApiKey ? '生图 Token' : ''].filter(Boolean).join('与')}`
        : '不含 API Key（将保留你当前的 Key）';
      const ok = confirm(
        `确认恢复这份本地备份吗？（将覆盖当前本地数据）\n` +
        `• 角色数：${sum.charCount} 个\n` +
        `• 聊天记录：${sum.msgCount} 条（含 ${sum.imgCount} 张照片）\n` +
        `• 长期记忆：${sum.memCount} 条 · 小组件：${sum.widgetCount} 个\n` +
        `• 密钥：${keyLabel}`
      );
      if (!ok) return;

      const rollbackSnapshot = runtime.state;
      const prevKey = runtime.state.settings.apiKey;
      const prevImgKey = runtime.state.settings.imgApiKey;
      const prevPin = runtime.state.settings.privacyPin;
      const prevLock = runtime.state.settings.privacyLock;
      try {
        const nextState = normalizeState(parsed);
        if (!nextState.settings.apiKey && prevKey) nextState.settings.apiKey = prevKey;
        if (!nextState.settings.imgApiKey && prevImgKey) nextState.settings.imgApiKey = prevImgKey;
        if (!nextState.settings.privacyPin && prevPin) {
          nextState.settings.privacyPin = prevPin;
          nextState.settings.privacyLock = prevLock;
        }
        // Swap memory BEFORE awaiting IDB so concurrent background flushSaveNow() never overwrites with old state (B2)
        clearTimeout(runtime.saveTimer);
        runtime.state = nextState;
        await StorageAdapter.set(STORE_KEY, runtime.state);
        runtime.visibleChatStart = -1;
        runtime.lastWindowStartIndex = 0;
        runtime.pendingEventQueue = [];
        runtime.personaShiftPending = false;
        ui.cancelPendingSendBurst?.();
        ui.clearPendingQuote?.();
        runtime.widgetRenderEpoch = (runtime.widgetRenderEpoch || 0) + 1;
        applyTheme(runtime.state.settings.theme);
        ui.renderHeader?.();
        ui.syncChatModeQuickBtn?.();
        ui.renderChat?.();
        ui.renderWidgets?.();
        refreshMemoryView();
        ui.syncDailyNotifications?.(runtime.state.settings.dailyNotify);
        settingsModal.classList.remove('show');
        showWarn(`✓ 已恢复 ${sum.charCount} 个角色与 ${sum.msgCount} 条聊天记录`, true);
        setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 3200);
      } catch (restoreErr) {
        runtime.state = rollbackSnapshot;
        applyTheme(runtime.state.settings.theme);
        ui.renderHeader?.();
        ui.renderChat?.();
        ui.renderWidgets?.();
        throw new Error(`恢复写入异常，已自动回滚原数据（${restoreErr.message || '未知错误'}）`);
      }
    } catch (err) {
      showWarn(`导入失败：${err.message}`);
    } finally {
      importFileInput.value = '';
    }
  };

  document.getElementById('resetAllBtn').onclick = async () => {
    if (runtime.isBusy) return;
    if (!confirm('确定清空所有角色、聊天记录和自定义小组件吗？')) return;
    await StorageAdapter.remove(STORE_KEY);
    runtime.state = defaultState();
    runtime.visibleChatStart = -1;
    runtime.lastWindowStartIndex = 0;
    runtime.pendingEventQueue = [];
    runtime.personaShiftPending = false;
    ui.cancelPendingSendBurst?.();
    ui.clearPendingQuote?.();
    runtime.widgetRenderEpoch = (runtime.widgetRenderEpoch || 0) + 1;
    applyTheme(runtime.state.settings.theme);
    ui.renderHeader?.();
    ui.syncChatModeQuickBtn?.();
    ui.renderChat?.();
    ui.renderWidgets?.();
    refreshMemoryView();
    ui.syncDailyNotifications?.(runtime.state.settings.dailyNotify);
    settingsModal.classList.remove('show');
  };

  document.getElementById('memAddBtn').onclick = () => {
    const kEl = document.getElementById('memNewKey');
    const vEl = document.getElementById('memNewVal');
    if (upsertMemory(kEl.value, vEl.value, null, null, true)) {
      kEl.value = '';
      vEl.value = '';
      scheduleSave();
      renderMemoryModalList();
      renderSceneStatesList();
      updateMemStats();
    }
  };

  document.getElementById('compressNowBtn').onclick = async () => {
    const btn = document.getElementById('compressNowBtn');
    btn.disabled = true;
    btn.textContent = '整理中…';
    memCompressStatus.textContent = '正在翻看之前的聊天并整理印象…';
    memCompressStatus.className = 'model-status';
    const res = await maybeCompressHistory(true, updateMemStats);
    btn.disabled = false;
    btn.textContent = '↻ 帮 TA 整理一下';
    if (res.ok) {
      memSummaryInput.value = runtime.state.memorySummary || '';
      renderMemoryModalList();
      renderSceneStatesList();
      memCompressStatus.textContent = `✓ 已整理 ${res.moved} 条旧消息并更新印象`;
      memCompressStatus.className = 'model-status ok';
    } else if (res.reason === 'no_api') {
      memCompressStatus.textContent = '演示模式下无法整理，请先到「模型与数据」配置 API Key';
      memCompressStatus.className = 'model-status err';
    } else if (res.reason === 'few') {
      memCompressStatus.textContent = '目前聊得还不算多，还不需要单独整理哦';
    } else {
      memCompressStatus.textContent = `整理失败：${res.reason}`;
      memCompressStatus.className = 'model-status err';
    }
  };

  document.getElementById('clearMemBtn').onclick = () => {
    if (!confirm('确定清空 TA 的长期记忆、临时场景状态和近期印象吗？（聊天记录不会被删除）')) return;
    runtime.state.memories = [];
    runtime.state.sceneStates = [];
    runtime.state.memorySummary = '';
    runtime.state.summarizedCount = 0;
    memSummaryInput.value = '';
    scheduleSave();
    renderMemoryModalList();
      renderSceneStatesList();
    updateMemStats();
  };

  // ---- Code Inspector Modal ----
  const codeModal = document.getElementById('codeModal');
  function openCodeModal(w) {
    document.getElementById('codeModalTitle').textContent = `${w.title} · 源码`;
    document.getElementById('codePreview').textContent = w.html;
    codeModal.classList.add('show');
  }
  document.getElementById('closeCodeBtn').onclick = () => codeModal.classList.remove('show');
  codeModal.addEventListener('click', e => {
    if (e.target === codeModal) codeModal.classList.remove('show');
  });

  registerUI({
    applyTheme,
    openSettingsTo,
    setCompanionSubView,
    switchCharacter,
    renderCharacterBar,
    syncChatModePickerUI,
    updateMemStats,
    refreshMemoryView,
    openCodeModal,
    setDraftAvatarImage: val => { draftAvatarImage = val; },
    setDraftChatMode: val => { draftChatMode = val; },
    setDraftPrivacyPin: val => { draftPrivacyPin = val; syncPrivacyPinStatusUI(); }
  });
}
