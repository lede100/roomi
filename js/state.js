import { STORE_KEY, StorageAdapter } from './storage.js';
import {
  DEFAULT_PERSONA,
  CONTEXT_TIERS,
  CHAR_TEMPLATES,
  STARTER_WIDGET,
  cloneStarterWidget,
  buildNaturalStarter
} from './presets.js';

export function makeCharacterCard(opts = {}) {
  const id = opts.id || ('char_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
  const name = String(opts.name || '林澈').trim() || '林澈';
  const rawMsgs = Array.isArray(opts.messages)
    ? opts.messages.filter(m => m && !m.imgPending).map((m, idx) => m.id ? m : { ...m, id: `msg_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}` })
    : (Array.isArray(opts.greeting)
        ? opts.greeting.map((t, idx) => ({ id: `msg_init_${Date.now()}_${idx}`, role: 'assistant', text: t, isStarter: true, createdAt: Date.now() }))
        : [{ id: `msg_init_${Date.now()}`, role: 'assistant', text: buildNaturalStarter(name), isStarter: true, createdAt: Date.now() }]);
  return {
    id,
    name,
    age: String(opts.age || '').trim(),
    gender: String(opts.gender || '').trim(),
    chatMode: opts.chatMode === 'story' ? 'story' : 'wechat',
    persona: String(opts.persona || DEFAULT_PERSONA).trim() || DEFAULT_PERSONA,
    anchors: String(opts.anchors || '').trim(),
    sampleDialogue: String(opts.sampleDialogue || '').trim(),
    appearance: String(opts.appearance || '').trim(),
    avatarImage: String(opts.avatarImage || '').trim(),
    wallpaper: String(opts.wallpaper || '').trim(),
    avatarColor: opts.avatarColor || '',
    lastActiveAt: Number(opts.lastActiveAt) || Date.now(),
    affection: typeof opts.affection === 'number' ? opts.affection : 68,
    mood: (!opts.mood || opts.mood === '正在传照片…') ? '在线等你' : opts.mood,
    memories: Array.isArray(opts.memories) ? opts.memories.filter(m => m && typeof m === 'object' && m.key && m.value) : [],
    sceneStates: Array.isArray(opts.sceneStates) ? opts.sceneStates.filter(s => s && typeof s === 'object' && s.key && s.value) : [],
    memorySummary: String(opts.memorySummary || ''),
    summarizedCount: Number(opts.summarizedCount) || 0,
    favorites: Array.isArray(opts.favorites) ? opts.favorites.filter(f => f && f.text) : [],
    dailyNote: (opts.dailyNote && typeof opts.dailyNote === 'object') ? { date: String(opts.dailyNote.date || ''), text: String(opts.dailyNote.text || '') } : { date: '', text: '' },
    messages: rawMsgs,
    widgets: Array.isArray(opts.widgets)
      ? opts.widgets.filter(w => w && typeof w === 'object' && w.id && w.html).map(w => (
          w.id === 'starter_checkin' && String(w.html).includes('background: #ffffff')
            ? { ...w, html: STARTER_WIDGET.html }
            : w
        ))
      : [cloneStarterWidget()],
    widgetStates: (opts.widgetStates && typeof opts.widgetStates === 'object') ? opts.widgetStates : {}
  };
}

export function defaultState() {
  const firstChar = makeCharacterCard({
    id: 'char_linche',
    ...CHAR_TEMPLATES.linche,
    widgets: [cloneStarterWidget()]
  });
  return {
    settings: {
      _v: 11,
      theme: 'claude',
      baseUrl: '',
      apiKey: '',
      model: '',
      thinkingMode: 'auto',
      contextMode: 'long',
      maxContextChars: CONTEXT_TIERS.long.chars,
      maxContextMsgs: CONTEXT_TIERS.long.msgs,
      temperatureMode: 'balanced',
      name: firstChar.name,
      age: firstChar.age,
      gender: firstChar.gender,
      chatMode: firstChar.chatMode || 'wechat',
      persona: firstChar.persona,
      anchors: firstChar.anchors || '',
      sampleDialogue: firstChar.sampleDialogue || '',
      appearance: firstChar.appearance,
      avatarImage: firstChar.avatarImage,
      wallpaper: firstChar.wallpaper || '',
      autoReact: true,
      debounceSend: false,
      autoGreetOnOpen: true,
      dailyNotify: false,
      notifyMorning: '08:30',
      notifyNight: '23:30',
      privacyLock: false,
      privacyPin: '',
      stream: true,
      imgProvider: 'off',
      imgBaseUrl: '',
      imgApiKey: '',
      imgModel: 'Tongyi-MAI/Z-Image-Turbo',
      msImgPreset: 'Tongyi-MAI/Z-Image-Turbo',
      msImgCustomModel: '',
      openaiImgModel: '',
      imgTrigger: 'asked',
      imgDefaultSize: '1152x1536'
    },
    activeCharId: firstChar.id,
    characters: [firstChar],
    affection: firstChar.affection,
    mood: firstChar.mood,
    memories: firstChar.memories,
    sceneStates: firstChar.sceneStates,
    memorySummary: firstChar.memorySummary,
    summarizedCount: firstChar.summarizedCount,
    favorites: firstChar.favorites,
    dailyNote: firstChar.dailyNote,
    stickers: [],
    nonVisionModels: [],
    nonThinkingModels: [],
    noReasoningModels: [],
    messages: firstChar.messages,
    widgets: firstChar.widgets,
    widgetStates: firstChar.widgetStates
  };
}

export const runtime = {
  state: defaultState(),
  currentPage: 0,
  isBusy: false,
  activeAbortController: null,
  bannerTimer: null,
  saveTimer: null,
  keyGuideDismissedSession: false,
  personaShiftPending: false,
  iframeRegistry: new Map(),
  pendingEventQueue: [],
  eventFlushTimer: null,
  pendingImgCountByChar: new Map(),
  visibleChatStart: -1,
  lastWindowStartIndex: 0,
  replyAbortRequested: false,
  onVisionCompatChange: null
};

export function getState() {
  return runtime.state;
}

export function setState(nextState) {
  runtime.state = nextState;
}

export function getActiveCharacter() {
  const state = runtime.state;
  if (!Array.isArray(state.characters) || !state.characters.length) return null;
  return state.characters.find(c => c.id === state.activeCharId) || state.characters[0];
}

export function flushActiveCharToList() {
  const state = runtime.state;
  const active = getActiveCharacter();
  if (!active) return;
  active.name = state.settings.name || active.name || '林澈';
  active.age = state.settings.age || '';
  active.gender = state.settings.gender || '';
  active.chatMode = state.settings.chatMode === 'story' ? 'story' : 'wechat';
  active.persona = state.settings.persona || active.persona || DEFAULT_PERSONA;
  active.anchors = state.settings.anchors || '';
  active.sampleDialogue = state.settings.sampleDialogue || '';
  active.appearance = state.settings.appearance || '';
  active.avatarImage = state.settings.avatarImage || '';
  active.wallpaper = state.settings.wallpaper || '';
  active.affection = state.affection;
  active.mood = state.mood;
  active.memories = Array.isArray(state.memories) ? state.memories : [];
  active.sceneStates = Array.isArray(state.sceneStates) ? state.sceneStates : [];
  active.memorySummary = state.memorySummary || '';
  active.summarizedCount = state.summarizedCount || 0;
  active.favorites = Array.isArray(state.favorites) ? state.favorites : [];
  active.dailyNote = state.dailyNote || { date: '', text: '' };
  active.messages = Array.isArray(state.messages) ? state.messages : [];
  active.widgets = Array.isArray(state.widgets) ? state.widgets : [];
  active.widgetStates = state.widgetStates || {};
}

export function loadCharacterIntoRuntime(char) {
  if (!char) return;
  const state = runtime.state;
  state.activeCharId = char.id;
  state.settings.name = char.name || '林澈';
  state.settings.age = char.age || '';
  state.settings.gender = char.gender || '';
  state.settings.chatMode = char.chatMode === 'story' ? 'story' : 'wechat';
  state.settings.persona = char.persona || DEFAULT_PERSONA;
  state.settings.anchors = char.anchors || '';
  state.settings.sampleDialogue = char.sampleDialogue || '';
  state.settings.appearance = char.appearance || '';
  state.settings.avatarImage = char.avatarImage || '';
  state.settings.wallpaper = char.wallpaper || '';
  state.affection = typeof char.affection === 'number' ? char.affection : 68;
  state.mood = char.mood || '在线等你';
  state.memories = Array.isArray(char.memories) ? char.memories : [];
  state.sceneStates = Array.isArray(char.sceneStates) ? char.sceneStates : [];
  state.memorySummary = char.memorySummary || '';
  state.summarizedCount = Number(char.summarizedCount) || 0;
  state.favorites = Array.isArray(char.favorites) ? char.favorites : [];
  state.dailyNote = (char.dailyNote && typeof char.dailyNote === 'object') ? char.dailyNote : { date: '', text: '' };
  state.messages = Array.isArray(char.messages) ? char.messages : [];
  state.widgets = Array.isArray(char.widgets) ? char.widgets : [];
  state.widgetStates = (char.widgetStates && typeof char.widgetStates === 'object') ? char.widgetStates : {};
}

export function normalizeState(raw) {
  const base = defaultState();
  const mergedSettings = Object.assign(base.settings, raw?.settings || {});
  const next = Object.assign(base, raw || {}, { settings: mergedSettings });

  // v3 -> v4 migration: promote legacy single companion into first CharacterCard
  if (!Array.isArray(next.characters) || !next.characters.length) {
    const legacyChar = makeCharacterCard({
      id: 'char_linche',
      name: mergedSettings.name || '林澈',
      persona: mergedSettings.persona || DEFAULT_PERSONA,
      appearance: mergedSettings.appearance || '',
      avatarImage: mergedSettings.avatarImage || '',
      affection: typeof raw?.affection === 'number' ? raw.affection : 68,
      mood: raw?.mood || '在线等你',
      memories: Array.isArray(raw?.memories) ? raw.memories : [],
      memorySummary: raw?.memorySummary || '',
      summarizedCount: Number(raw?.summarizedCount) || 0,
      messages: Array.isArray(raw?.messages) ? raw.messages : base.messages,
      widgets: Array.isArray(raw?.widgets) ? raw.widgets : base.widgets,
      widgetStates: raw?.widgetStates || {}
    });
    next.characters = [legacyChar];
    next.activeCharId = legacyChar.id;
  } else {
    next.characters = next.characters.map(c => makeCharacterCard(c));
    if (!next.characters.some(c => c.id === next.activeCharId)) {
      next.activeCharId = next.characters[0].id;
    }
  }

  if ((mergedSettings._v || 0) < 3) {
    if ((mergedSettings._v || 0) < 2 && !mergedSettings.apiKey.trim()) {
      mergedSettings.baseUrl = '';
      mergedSettings.model = '';
    }
    if (mergedSettings.theme === 'deepseek') {
      mergedSettings.theme = 'claude';
    }
  }
  if (!['claude', 'deepseek', 'glass-light', 'glass-dark'].includes(mergedSettings.theme)) {
    mergedSettings.theme = 'claude';
  }
  if (String(mergedSettings.baseUrl || '').includes('opencode.ai/zen') && mergedSettings.apiKey === 'public') {
    mergedSettings.baseUrl = '';
    mergedSettings.apiKey = '';
    mergedSettings.model = '';
  }
  if ((mergedSettings._v || 0) < 6 && (!raw?.settings?.contextMode || (mergedSettings.maxContextChars || 16000) <= 16000)) {
    mergedSettings.contextMode = 'long';
    mergedSettings.maxContextChars = CONTEXT_TIERS.long.chars;
    mergedSettings.maxContextMsgs = CONTEXT_TIERS.long.msgs;
  }
  const ctxTier = CONTEXT_TIERS[mergedSettings.contextMode] || CONTEXT_TIERS.long;
  if (!mergedSettings.contextMode || !CONTEXT_TIERS[mergedSettings.contextMode]) {
    mergedSettings.contextMode = 'long';
  }
  mergedSettings.maxContextChars = ctxTier.chars;
  mergedSettings.maxContextMsgs = ctxTier.msgs;
  if (!['auto', 'off', 'low', 'high'].includes(mergedSettings.thinkingMode)) {
    mergedSettings.thinkingMode = 'auto';
  }
  if (!['calm', 'balanced', 'vivid'].includes(mergedSettings.temperatureMode)) {
    mergedSettings.temperatureMode = 'balanced';
  }
  if ((mergedSettings._v || 0) < 11) {
    // Reset previously un-scoped / over-broad model compat caches so endpoints probe cleanly with TTL
    next.nonThinkingModels = [];
    next.noReasoningModels = [];
    next.nonVisionModels = [];
  }
  if (!Array.isArray(next.nonThinkingModels)) next.nonThinkingModels = [];
  if (!Array.isArray(next.noReasoningModels)) next.noReasoningModels = [];
  if (!Array.isArray(next.stickers)) next.stickers = [];
  if (typeof mergedSettings.autoGreetOnOpen !== 'boolean') mergedSettings.autoGreetOnOpen = true;
  mergedSettings.debounceSend = Boolean(mergedSettings.debounceSend);
  mergedSettings.dailyNotify = Boolean(mergedSettings.dailyNotify);
  if (!/^\d{2}:\d{2}$/.test(mergedSettings.notifyMorning || '')) mergedSettings.notifyMorning = '08:30';
  if (!/^\d{2}:\d{2}$/.test(mergedSettings.notifyNight || '')) mergedSettings.notifyNight = '23:30';
  if (!/^\d{3,4}x\d{3,4}$/.test(mergedSettings.imgDefaultSize || '')) mergedSettings.imgDefaultSize = '1152x1536';
  const msFixedModels = ['Tongyi-MAI/Z-Image-Turbo', 'krea/Krea-2-Turbo', 'Qwen/Qwen-Image-2.1'];
  if (!mergedSettings.msImgPreset && !mergedSettings.msImgCustomModel) {
    if (mergedSettings.imgProvider === 'modelscope' && mergedSettings.imgModel) {
      if (msFixedModels.includes(mergedSettings.imgModel)) {
        mergedSettings.msImgPreset = mergedSettings.imgModel;
        mergedSettings.msImgCustomModel = '';
      } else {
        mergedSettings.msImgPreset = 'Tongyi-MAI/Z-Image-Turbo';
        mergedSettings.msImgCustomModel = mergedSettings.imgModel;
      }
    } else {
      mergedSettings.msImgPreset = 'Tongyi-MAI/Z-Image-Turbo';
      mergedSettings.msImgCustomModel = '';
    }
  }
  if (!msFixedModels.includes(mergedSettings.msImgPreset)) mergedSettings.msImgPreset = 'Tongyi-MAI/Z-Image-Turbo';
  mergedSettings.msImgCustomModel = String(mergedSettings.msImgCustomModel || '').trim();
  if (!mergedSettings.openaiImgModel && mergedSettings.imgProvider === 'openai' && mergedSettings.imgModel) {
    mergedSettings.openaiImgModel = String(mergedSettings.imgModel).trim();
  }
  mergedSettings.openaiImgModel = String(mergedSettings.openaiImgModel || '').trim();
  mergedSettings.privacyLock = Boolean(mergedSettings.privacyLock);
  mergedSettings.privacyPin = String(mergedSettings.privacyPin || '').replace(/\D/g, '').slice(0, 4);
  mergedSettings._v = 11;

  const active = next.characters.find(c => c.id === next.activeCharId) || next.characters[0];
  next.activeCharId = active.id;
  next.settings.name = active.name;
  next.settings.age = active.age || '';
  next.settings.gender = active.gender || '';
  next.settings.chatMode = active.chatMode === 'story' ? 'story' : 'wechat';
  next.settings.persona = active.persona;
  next.settings.anchors = active.anchors || '';
  next.settings.sampleDialogue = active.sampleDialogue || '';
  next.settings.appearance = active.appearance || '';
  next.settings.avatarImage = active.avatarImage || '';
  next.settings.wallpaper = active.wallpaper || '';
  next.affection = active.affection;
  next.mood = active.mood;
  next.memories = active.memories;
  next.sceneStates = Array.isArray(active.sceneStates) ? active.sceneStates : [];
  next.memorySummary = active.memorySummary;
  next.summarizedCount = active.summarizedCount;
  next.favorites = active.favorites;
  next.dailyNote = active.dailyNote;
  next.messages = active.messages;
  next.widgets = active.widgets;
  next.widgetStates = active.widgetStates;
  return next;
}

export function showWarn(msg, isInfo = false) {
  const box = document.getElementById('warnToast');
  const txt = document.getElementById('warnToastText');
  if (!box || !txt) return;
  txt.textContent = msg;
  box.classList.toggle('info', Boolean(isInfo));
  box.classList.add('show');
}

export function scheduleSave() {
  clearTimeout(runtime.saveTimer);
  runtime.saveTimer = setTimeout(async () => {
    try {
      flushActiveCharToList();
      await StorageAdapter.set(STORE_KEY, runtime.state);
    } catch (err) {
      showWarn(`本地存储空间不足或写入失败：${err.message || '请导出备份并清理部分旧组件'}`);
    }
  }, 120);
}

// ---- Model Compatibility Cache (BaseURL + Model Scoped with TTL) ----
export const MODEL_COMPAT_TTL_MS = 6 * 60 * 60 * 1000;
export const VISION_COMPAT_TTL_MS = 24 * 60 * 60 * 1000;

export function getModelEndpointKey(baseUrl, modelName) {
  const m = String(modelName || '').trim().toLowerCase();
  if (!m) return '';
  let hostKey = String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  try {
    const u = new URL(hostKey);
    hostKey = `${u.origin}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {}
  return `${hostKey || 'default'}::${m}`;
}

export function isModelFieldUnsupported(list, modelName, baseUrl = runtime.state.settings.baseUrl, ttlMs = MODEL_COMPAT_TTL_MS) {
  const epKey = getModelEndpointKey(baseUrl, modelName);
  if (!epKey || !Array.isArray(list)) return false;
  const now = Date.now();
  return list.some(item => {
    if (typeof item === 'string') return false;
    if (!item || typeof item !== 'object') return false;
    return item.key === epKey && (now - (Number(item.at) || 0) <= ttlMs);
  });
}

export function markModelFieldUnsupported(prop, modelName, baseUrl = runtime.state.settings.baseUrl) {
  const state = runtime.state;
  const epKey = getModelEndpointKey(baseUrl, modelName);
  if (!epKey) return;
  if (!Array.isArray(state[prop])) state[prop] = [];
  const now = Date.now();
  state[prop] = state[prop].filter(item => item && typeof item === 'object' && item.key && item.key !== epKey);
  state[prop].push({ key: epKey, at: now });
  if (state[prop].length > 40) state[prop] = state[prop].slice(-40);
  scheduleSave();
}

export function clearModelCompatCache(baseUrl = '', modelName = '', clearAll = false) {
  const state = runtime.state;
  if (clearAll) {
    state.nonThinkingModels = [];
    state.noReasoningModels = [];
    state.nonVisionModels = [];
    if (runtime.onVisionCompatChange) runtime.onVisionCompatChange();
    return;
  }
  const epKey = getModelEndpointKey(baseUrl, modelName);
  if (!epKey) return;
  for (const prop of ['nonThinkingModels', 'noReasoningModels', 'nonVisionModels']) {
    if (Array.isArray(state[prop])) {
      state[prop] = state[prop].filter(item => item && typeof item === 'object' && item.key !== epKey);
    }
  }
  if (runtime.onVisionCompatChange) runtime.onVisionCompatChange();
}

export function isModelMarkedNonVision(modelName, baseUrl = runtime.state.settings.baseUrl) {
  return isModelFieldUnsupported(runtime.state.nonVisionModels, modelName, baseUrl, VISION_COMPAT_TTL_MS);
}

export function markModelNonVision(modelName, baseUrl = runtime.state.settings.baseUrl) {
  markModelFieldUnsupported('nonVisionModels', modelName, baseUrl);
  if (runtime.onVisionCompatChange) runtime.onVisionCompatChange();
}

export function isModelMarkedNoThinking(modelName, baseUrl = runtime.state.settings.baseUrl) {
  return isModelFieldUnsupported(runtime.state.nonThinkingModels, modelName, baseUrl, MODEL_COMPAT_TTL_MS);
}

export function isModelMarkedNoReasoning(modelName, baseUrl = runtime.state.settings.baseUrl) {
  return isModelFieldUnsupported(runtime.state.noReasoningModels, modelName, baseUrl, MODEL_COMPAT_TTL_MS);
}
