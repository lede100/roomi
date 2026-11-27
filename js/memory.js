import {
  runtime,
  getActiveCharacter,
  scheduleSave,
  isModelMarkedNoThinking,
  markModelFieldUnsupported
} from './state.js';
import { fetchWithTimeout, cnNumToInt } from './utils.js';
import { stripThinkingTags, formatMessageForModel } from './prompt.js';

export function isTrivialEventFact(key, value) {
  const text = `${key || ''} ${value || ''}`;
  return /(今日第\s*\d+\s*次|隔空贴贴|贴贴互动|喝水提醒|喝了一杯|喝满\s*\d|看板互动|照片事件|照片互动|发了一张|重拍照片|再发一张|发照片|本轮|刚才|截止目前|截至本轮|已记录为)/.test(text);
}

export function upsertMemory(key, value, targetMemories = null, forcePinned = null, allowAny = false) {
  const state = runtime.state;
  const k = String(key || '').trim().slice(0, 24);
  const v = String(value || '').trim().slice(0, 120);
  if (!k || !v) return false;
  if (!allowAny && isTrivialEventFact(k, v)) return false;
  const list = Array.isArray(targetMemories)
    ? targetMemories
    : (Array.isArray(state.memories) ? state.memories : (state.memories = []));
  const idx = list.findIndex(m => m.key.toLowerCase() === k.toLowerCase());
  if (idx >= 0) {
    list[idx].key = k;
    list[idx].value = v;
    list[idx].updatedAt = Date.now();
    if (forcePinned !== null) list[idx].pinned = Boolean(forcePinned);
  } else {
    list.unshift({
      id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      key: k,
      value: v,
      pinned: Boolean(forcePinned),
      updatedAt: Date.now()
    });
    if (list.length > 120) {
      const pinned = list.filter(item => item.pinned);
      const normal = list.filter(item => !item.pinned).slice(0, Math.max(20, 120 - pinned.length));
      list.splice(0, list.length, ...pinned, ...normal);
    }
  }
  return true;
}

export function removeMemoryByKey(key, targetMemories = null) {
  const state = runtime.state;
  const k = String(key || '').trim().toLowerCase();
  const list = Array.isArray(targetMemories) ? targetMemories : state.memories;
  if (!k || !Array.isArray(list)) return;
  for (let i = list.length - 1; i >= 0; i--) {
    if (String(list[i].key || '').toLowerCase() === k) list.splice(i, 1);
  }
}

export const SCENE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

export function pruneSceneStates(list = runtime.state.sceneStates) {
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  const valid = list
    .filter(item => item && typeof item === 'object' && item.key && item.value && (now - (Number(item.updatedAt) || 0) <= SCENE_STATE_TTL_MS))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, 12);
  if (list === runtime.state.sceneStates && valid.length !== list.length) {
    runtime.state.sceneStates = valid;
  }
  return valid;
}

export function upsertSceneState(key, value) {
  const state = runtime.state;
  const k = String(key || '').trim().slice(0, 20);
  const v = String(value || '').trim().slice(0, 60);
  if (!k || !v) return false;
  state.sceneStates = pruneSceneStates(state.sceneStates);
  const low = k.toLowerCase();
  const existing = state.sceneStates.find(item => String(item.key || '').trim().toLowerCase() === low);
  if (existing) {
    existing.key = k;
    existing.value = v;
    existing.updatedAt = Date.now();
  } else {
    state.sceneStates.unshift({ key: k, value: v, updatedAt: Date.now() });
    if (state.sceneStates.length > 12) state.sceneStates.length = 12;
  }
  return true;
}

export function removeSceneStateByKey(key) {
  const state = runtime.state;
  const k = String(key || '').trim().toLowerCase();
  if (!k || !Array.isArray(state.sceneStates)) return;
  state.sceneStates = state.sceneStates.filter(item => String(item?.key || '').trim().toLowerCase() !== k);
}

export function formatSceneAge(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - (Number(ts) || Date.now())) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  return `${Math.floor(diffMin / 60)}小时前`;
}

export const MEMORY_SYNONYM_GROUPS = [
  ['吃', '吃饭', '饭', '菜', '美食', '点外卖', '外卖', '忌口', '口味', '偏爱', '爱吃', '讨厌吃', '饮食', '辣', '甜', '火锅', '奶茶'],
  ['睡', '睡觉', '熬夜', '困', '早睡', '起床', '作息', '失眠', '夜猫'],
  ['喝水', '饮水', '杯', '口渴'],
  ['上班', '工作', '加班', '开会', '公司', '老板', '领导', '同事', '通勤', '职业'],
  ['学校', '上课', '作业', '考试', '放假', '老师', '同学'],
  ['累', '难受', '生气', '烦', '哭', '委屈', '焦虑', '情绪', '开心'],
  ['猫', '猫咪', '小猫', '主子', '狗', '小狗', '宠物'],
  ['对象', '伴侣', '恋人', '男友', '女友', '老公', '老婆', '宝宝'],
  ['生日', '纪念日', '周年', '约定', '旅行', '旅游', '计划']
];

export function extractMemoryQueryTokens(text) {
  const direct = new Set();
  const expanded = new Set();
  const clean = String(text || '').toLowerCase();
  (clean.match(/[a-z0-9]{2,}/g) || []).forEach(w => direct.add(w));
  (clean.match(/[\u4e00-\u9fa5]{2,}/g) || []).forEach(seg => {
    for (let i = 0; i < seg.length - 1; i++) {
      direct.add(seg.slice(i, i + 2));
    }
  });
  for (const single of ['猫', '狗', '茶', '酒', '辣', '甜', '冷', '病', '车', '饭', '睡', '吃', '家']) {
    if (clean.includes(single)) direct.add(single);
  }
  for (const grp of MEMORY_SYNONYM_GROUPS) {
    if (grp.some(kw => clean.includes(kw))) {
      grp.forEach(kw => { if (!direct.has(kw)) expanded.add(kw); });
    }
  }
  return { direct: [...direct], expanded: [...expanded] };
}

export function selectRelevantMemories() {
  const state = runtime.state;
  const list = Array.isArray(state.memories) ? state.memories : [];
  if (!list.length) return [];
  const recentText = state.messages
    .slice(-8)
    .map(m => m?.text || '')
    .join(' ');
  const { direct, expanded } = extractMemoryQueryTokens(recentText);
  const total = list.length;

  const pinned = [];
  const candidates = [];
  list.forEach((m, idx) => {
    const hay = `${m.key || ''} ${m.value || ''}`.toLowerCase();
    let directHits = 0;
    let synHits = 0;
    for (const tok of direct) {
      if (hay.includes(tok)) directHits += 1;
    }
    for (const tok of expanded) {
      if (hay.includes(tok)) synHits += 1;
    }
    const matchScore = directHits * 30 + Math.min(synHits, 3) * 10;
    if (m.pinned) {
      pinned.push({ m, score: matchScore + (total - idx) * 0.15 });
    } else if (matchScore > 0) {
      candidates.push({ m, score: matchScore + (total - idx) * 0.15 });
    }
  });

  pinned.sort((a, b) => b.score - a.score);
  candidates.sort((a, b) => b.score - a.score);

  const picked = [];
  let chars = 0;
  for (const item of [...pinned.slice(0, 8), ...candidates.slice(0, 8)]) {
    const lineLen = (item.m.key?.length || 0) + (item.m.value?.length || 0) + 8;
    if (picked.length >= 3 && chars + lineLen > 1400) break;
    picked.push(item.m);
    chars += lineLen;
  }
  return picked;
}

export function getSpecialDateCue() {
  const state = runtime.state;
  const mems = Array.isArray(state.memories) ? state.memories : [];
  if (!mems.length) return '';
  const now = new Date();
  const mo = now.getMonth() + 1;
  const da = now.getDate();
  const hits = [];
  for (const m of mems) {
    const combined = `${m.key || ''} ${m.value || ''}`;
    if (!/(生日|纪念日|周年|在一起|初遇|相识|领证|结婚|求婚)/.test(combined)) continue;
    let matched = false;
    const reNum = /(?:^|[^\d])(?:(\d{4})[-/.年])?0?(\d{1,2})[-/.月]0?(\d{1,2})[日号]?(?!\d)/g;
    let match;
    while ((match = reNum.exec(combined)) !== null) {
      if (Number(match[2]) === mo && Number(match[3]) === da) {
        const yr = Number(match[1]);
        const years = (yr > 1900 && yr <= now.getFullYear()) ? (now.getFullYear() - yr) : 0;
        hits.push(`${m.key}：${m.value}${years > 0 ? `（今天正好满${years}年）` : ''}`);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const reCn = /([一二三四五六七八九十]{1,2})月([一二三四五六七八九十廿卅]{1,3})[日号]/g;
      let mCn;
      while ((mCn = reCn.exec(combined)) !== null) {
        if (cnNumToInt(mCn[1]) === mo && cnNumToInt(mCn[2]) === da) {
          hits.push(`${m.key}：${m.value}`);
          break;
        }
      }
    }
  }
  if (!hits.length) return '';
  return `🎉 特殊日子提醒：今天正好是「${hits.slice(0, 3).join('；')}」，自然提起并给对方一点心意或小惊喜吧！`;
}

// ---- Rolling Context Compression & Fact Extraction (Per-Character Isolated) ----
const compressingChars = new Set();
const compressCooldownByChar = new Map();

export function extractFirstJsonObject(rawText) {
  const cleaned = stripThinkingTags(rawText).trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fence ? fence[1].trim() : cleaned;
  const start = src.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return JSON.parse(src.slice(start, i + 1));
        }
      }
    }
  }
  return null;
}

export async function maybeCompressHistory(force = false, onStatsUpdated = null) {
  const state = runtime.state;
  const targetCharId = state.activeCharId;
  const targetChar = getActiveCharacter();
  if (!targetChar || compressingChars.has(targetCharId)) {
    return { ok: false, reason: 'busy' };
  }
  if (!force && (compressCooldownByChar.get(targetCharId) || 0) > Date.now()) {
    return { ok: false, reason: 'cooldown' };
  }
  const { baseUrl, apiKey, model } = state.settings;
  if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
    return { ok: false, reason: 'no_api' };
  }

  const msgsRef = state.messages;
  const curSummarized = Math.max(0, Math.min(state.summarizedCount || 0, msgsRef.length));
  const safeEnd = force
    ? Math.max(0, msgsRef.length - 8)
    : Math.max(0, msgsRef.length - 24);

  const pendingCount = safeEnd - curSummarized;
  if (!force && pendingCount < 20) return { ok: false, reason: 'few' };
  if (pendingCount < 3) return { ok: false, reason: 'few' };

  const maxBatchEnd = Math.min(safeEnd, curSummarized + 36);
  const chunkLines = [];
  let chunkChars = 0;
  let sliceEnd = curSummarized;
  for (let i = curSummarized; i < maxBatchEnd; i++) {
    const formatted = formatMessageForModel(msgsRef[i]);
    sliceEnd = i + 1;
    if (!formatted || !formatted.content) continue;
    const line = `${formatted.role === 'user' ? '用户' : '伴侣'}: ${formatted.content}`;
    if (chunkLines.length >= 2 && chunkChars + line.length > 5600) {
      sliceEnd = i;
      break;
    }
    chunkLines.push(line);
    chunkChars += line.length + 1;
  }
  const chunk = chunkLines.join('\n');

  if (!chunk.trim()) {
    targetChar.summarizedCount = sliceEnd;
    if (runtime.state.activeCharId === targetCharId) runtime.state.summarizedCount = sliceEnd;
    scheduleSave();
    return { ok: true, moved: sliceEnd - curSummarized };
  }

  compressingChars.add(targetCharId);
  try {
    const memSnapshot = Array.isArray(targetChar.memories) ? targetChar.memories : [];
    const existingKeys = memSnapshot.slice(0, 40).map(m => `${m.key}:${m.value}`).join('；') || '无';
    const url = baseUrl.trim().replace(/\/+$/, '') + '/chat/completions';
    const prompt = `请把下面滑出对话窗口的旧聊天记录与原有前情摘要合并压缩，并按严格门槛整理长期记忆。

【原有前情摘要】
${targetChar.memorySummary || '（暂无）'}

【已有长期记忆】
${existingKeys}

【待归档的新增旧对话】
${chunk}

【记忆筛选红线（极其重要）】
1. facts 只能记录对未来一个月后依然成立的用户个人长期事实（如：昵称/职业/城市、作息习惯、饮食喜好或忌口、生日纪念日、养的宠物、重要约定）。
2. 严禁写入一次性琐事与流水账（例如：喝了几杯水、隔空贴贴第几次、拍过照/重拍照片、看板点击、AI 自己说过的话、当时一时的玩笑话）。若没有值得长期记录的新事实，facts 必须输出空数组 []！
3. 如果【已有长期记忆】里已经混入了上述流水账/废话，或有被新事实推翻的旧标签，请把它们的标签名放进 dropKeys 清理掉。

请严格只输出一个 JSON 对象：
{"summary":"450字以内的连贯前情摘要，保留重要经历、关系进展与未完成约定","facts":[],"dropKeys":[]}`;

    const compressBody = {
      model: model.trim(),
      temperature: 0.2,
      stream: false,
      messages: [{ role: 'user', content: prompt }]
    };
    if (!isModelMarkedNoThinking(model, baseUrl)) {
      compressBody.thinking = { type: 'disabled' };
    }
    const postCompress = bodyObj => fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(bodyObj)
    }, 45000);
    let res = await postCompress(compressBody);
    if (!res.ok && (res.status === 400 || res.status === 422) && compressBody.thinking) {
      const errText = await res.text().catch(() => '');
      if (/(thinking|unknown[_ ]field|extra[_ ]inputs|unrecognized[_ ]request|unsupported[_ ]param|additional[_ ]properties|not[_ ]allowed)/i.test(errText)) {
        const fallbackBody = { ...compressBody };
        delete fallbackBody.thinking;
        res = await postCompress(fallbackBody);
        if (res.ok) markModelFieldUnsupported('nonThinkingModels', model, baseUrl);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content || '';
    const parsed = extractFirstJsonObject(raw);
    if (!parsed) throw new Error('摘要格式解析失败');
    compressCooldownByChar.delete(targetCharId);

    const destChar = runtime.state.characters.find(c => c.id === targetCharId);
    if (!destChar) return { ok: false, reason: 'char_removed' };
    const isStillActive = runtime.state.activeCharId === targetCharId;
    const destMemories = isStillActive ? runtime.state.memories : destChar.memories;

    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      const cleanSummary = parsed.summary.trim().slice(0, 1200);
      destChar.memorySummary = cleanSummary;
      if (isStillActive) runtime.state.memorySummary = cleanSummary;
    }
    if (Array.isArray(parsed.dropKeys)) {
      parsed.dropKeys.forEach(dk => {
        if (dk) removeMemoryByKey(dk, destMemories);
      });
    }
    if (Array.isArray(parsed.facts)) {
      parsed.facts.forEach(f => {
        if (f && f.key && f.value) upsertMemory(f.key, f.value, destMemories);
      });
    }
    destChar.summarizedCount = sliceEnd;
    if (isStillActive) {
      runtime.state.summarizedCount = sliceEnd;
      if (onStatsUpdated) onStatsUpdated();
    }
    scheduleSave();
    return { ok: true, moved: sliceEnd - curSummarized };
  } catch (err) {
    compressCooldownByChar.set(targetCharId, Date.now() + 5 * 60 * 1000);
    return { ok: false, reason: err.message };
  } finally {
    compressingChars.delete(targetCharId);
  }
}
