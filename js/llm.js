import {
  runtime,
  isModelMarkedNonVision,
  markModelNonVision,
  isModelMarkedNoThinking,
  isModelMarkedNoReasoning,
  markModelFieldUnsupported
} from './state.js';
import { CONTEXT_TIERS } from './presets.js';
import { sleep, fetchWithTimeout } from './utils.js';
import {
  buildConversationHistory,
  detectPromptIntents,
  buildSystemPrompt,
  buildDynamicContextNote,
  getTemperatureValue
} from './prompt.js';

export function extractSseLines(lines, onChunk) {
  let acc = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.error) {
        const errMsg = parsed.error.message || (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
        throw new Error(`流式接口返回异常：${String(errMsg).slice(0, 140)}`);
      }
      const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
      if (typeof delta === 'string') {
        acc += delta;
        if (onChunk) onChunk(delta);
      }
    } catch (e) {
      if (e && String(e.message || '').startsWith('流式接口返回异常')) throw e;
    }
  }
  return acc;
}

export function isContextLimitError(err) {
  if (err?.status === 402 || err?.status === 429) return false;
  const msg = String(err?.message || '').toLowerCase();
  if (/(quota|insufficient|balance|credit|billing|rate[_ ]?limit|too many requests|payment required|\b402\b|\b429\b)/.test(msg)) {
    return false;
  }
  return /(context[_ ]?length|max[_ ]?tokens|too long|token[_ ]?limit|context[_ ]?window|maximum context|\b413\b)/.test(msg);
}

export function isVisionUnsupportedError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return /(vision|image_url|image|multimodal|does not support|not support.*media|content must be a string|expected a string|invalid type.*array|415|422)/.test(msg);
}

export async function callLiveLLM(promptOverride, onStreamProgress, isEvent = false, budgetChars = null, hasPendingImg = false) {
  const { baseUrl, apiKey, model, stream } = runtime.state.settings;
  if (!baseUrl.trim() || !model.trim()) {
    throw new Error('请先在设置中填写 API Base URL 和模型名称');
  }
  const url = baseUrl.trim().replace(/\/+$/, '') + '/chat/completions';
  const allowVision = hasPendingImg && !isModelMarkedNonVision(model, baseUrl);
  const built = buildConversationHistory(promptOverride, isEvent, budgetChars, allowVision);
  runtime.lastWindowStartIndex = built.windowStartIndex;

  const historyMsgs = built.msgs;
  const intents = detectPromptIntents(historyMsgs, promptOverride);
  const dynNote = buildDynamicContextNote(intents.needWidget, historyMsgs);

  // Put <context_memo> directly above the latest user text so ALL relays/proxies preserve it 100% cleanly without mid-array system rejection
  if (dynNote) {
    const clonedNote = `<context_memo>\n${dynNote}\n</context_memo>`;
    let attached = false;
    for (let i = historyMsgs.length - 1; i >= 0; i--) {
      const msg = historyMsgs[i];
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          msg.content = `${clonedNote}\n\n用户发言：${msg.content}`;
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find(p => p && p.type === 'text');
          if (textPart) textPart.text = `${clonedNote}\n\n用户发言：${textPart.text}`;
        }
        attached = true;
        break;
      }
    }
    if (!attached) {
      historyMsgs.push({ role: 'user', content: clonedNote });
    }
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(intents) },
    ...historyMsgs
  ];

  runtime.activeAbortController = new AbortController();
  const isCapacitorNative = Boolean(window.Capacitor?.isNativePlatform?.());
  const useStream = Boolean(stream) && !isCapacitorNative;
  const thinkingMode = runtime.state.settings.thinkingMode || 'auto';
  const allowThinkingField = !isModelMarkedNoThinking(model, baseUrl);
  const allowReasoningField = !isModelMarkedNoReasoning(model, baseUrl);

  const reqBody = {
    model: model.trim(),
    temperature: getTemperatureValue(),
    stream: useStream,
    messages
  };
  if (thinkingMode === 'off') {
    if (allowThinkingField) reqBody.thinking = { type: 'disabled' };
  } else if (thinkingMode === 'low' || thinkingMode === 'high') {
    if (allowThinkingField) reqBody.thinking = { type: 'enabled' };
    if (allowReasoningField) reqBody.reasoning_effort = thinkingMode;
  }

  const postOnce = bodyObj => fetchWithTimeout(url, {
    method: 'POST',
    signal: runtime.activeAbortController.signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`
    },
    body: JSON.stringify(bodyObj)
  }, 150000);

  let res = await postOnce(reqBody);
  const paramUnsupportedRe = /(thinking|reasoning_effort|reasoning|unknown[_ ]field|extra[_ ]inputs|unrecognized[_ ]request|unsupported[_ ]param|additional[_ ]properties|not[_ ]allowed)/i;

  if (!res.ok && (res.status === 400 || res.status === 422) && (reqBody.thinking || reqBody.reasoning_effort)) {
    const errText = await res.text().catch(() => '');
    if (paramUnsupportedRe.test(errText)) {
      const retryBody = { ...reqBody };
      const onlyReasoningRejected = /reasoning/i.test(errText) && !/thinking/i.test(errText);
      if (onlyReasoningRejected && retryBody.reasoning_effort) {
        delete retryBody.reasoning_effort;
        res = await postOnce(retryBody);
        if (res.ok) {
          markModelFieldUnsupported('noReasoningModels', model, baseUrl);
        } else if ((res.status === 400 || res.status === 422) && retryBody.thinking) {
          const errText2 = await res.text().catch(() => '');
          if (paramUnsupportedRe.test(errText2)) {
            delete retryBody.thinking;
            res = await postOnce(retryBody);
            if (res.ok) {
              markModelFieldUnsupported('noReasoningModels', model, baseUrl);
              markModelFieldUnsupported('nonThinkingModels', model, baseUrl);
            }
          } else {
            throw new Error(`HTTP ${res.status} ${errText2.slice(0, 160)}`);
          }
        }
      } else if (retryBody.thinking) {
        // Strip `thinking` first while keeping `reasoning_effort` intact so OpenAI/OpenRouter/Gemini high reasoning stays enabled!
        delete retryBody.thinking;
        res = await postOnce(retryBody);
        if (res.ok) {
          markModelFieldUnsupported('nonThinkingModels', model, baseUrl);
        } else if ((res.status === 400 || res.status === 422) && retryBody.reasoning_effort) {
          const errText2 = await res.text().catch(() => '');
          if (paramUnsupportedRe.test(errText2)) {
            delete retryBody.reasoning_effort;
            res = await postOnce(retryBody);
            if (res.ok) {
              markModelFieldUnsupported('nonThinkingModels', model, baseUrl);
              markModelFieldUnsupported('noReasoningModels', model, baseUrl);
            }
          } else {
            throw new Error(`HTTP ${res.status} ${errText2.slice(0, 160)}`);
          }
        }
      } else if (retryBody.reasoning_effort) {
        delete retryBody.reasoning_effort;
        res = await postOnce(retryBody);
        if (res.ok) markModelFieldUnsupported('noReasoningModels', model, baseUrl);
      }
    } else {
      throw new Error(`HTTP ${res.status} ${errText.slice(0, 160)}`);
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const httpErr = new Error(`HTTP ${res.status} ${errText.slice(0, 160)}`);
    httpErr.status = res.status;
    throw httpErr;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!useStream || !res.body || contentType.includes('application/json')) {
    const rawBody = await res.text();
    let reply = '';
    try {
      const json = JSON.parse(rawBody);
      reply = json.choices?.[0]?.message?.content || '刚才走神了，再跟我说一遍？';
    } catch {
      const sseText = extractSseLines(rawBody.split(/\r?\n/));
      reply = sseText || '刚才走神了，再跟我说一遍？';
    }
    if (typeof res.__cleanupAbort === 'function') res.__cleanupAbort();
    runtime.personaShiftPending = false;
    return reply;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  const STREAM_IDLE_MS = 75000;

  try {
    while (true) {
      let idleTimer = null;
      const readRes = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idleTimer = setTimeout(() => {
            try { reader.cancel(); } catch {}
            const tErr = new Error('流式响应长时间无新内容（已等待 75 秒），已自动断开，请点击重试');
            tErr.name = 'TimeoutError';
            tErr.isTimeout = true;
            reject(tErr);
          }, STREAM_IDLE_MS);
        })
      ]).finally(() => { if (idleTimer) clearTimeout(idleTimer); });
      const { value, done } = readRes;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      fullText += extractSseLines(lines, () => {});
      if (onStreamProgress && fullText) onStreamProgress(fullText);
    }
    if (buffer.trim()) {
      fullText += extractSseLines([buffer]);
    }
  } finally {
    if (typeof res.__cleanupAbort === 'function') res.__cleanupAbort();
  }

  runtime.personaShiftPending = false;
  return fullText || '刚才走神了，再跟我说一遍？';
}

export function isRetryableTransientError(err) {
  const s = err?.status;
  if (s === 429 || (s >= 500 && s <= 504)) return true;
  const msg = String(err?.message || '').toLowerCase();
  return /\b(429|500|502|503|504)\b|rate limit|overloaded|bad gateway|service unavailable/.test(msg);
}

export async function callLiveLLMWithRetry(promptOverride, onStreamProgress, isEvent = false, hasPendingImg = false) {
  if (hasPendingImg && isModelMarkedNonVision(runtime.state.settings.model, runtime.state.settings.baseUrl)) {
    const err = new Error(`当前模型「${runtime.state.settings.model}」不支持识图，请在设置中切换到支持视觉的模型（如 GPT-4o / Claude / Gemini / Qwen-VL）后重试。`);
    err.isVisionNotice = true;
    throw err;
  }
  const tier = CONTEXT_TIERS[runtime.state.settings.contextMode] || CONTEXT_TIERS.long;
  let budget = runtime.state.settings.maxContextChars || tier.chars;
  let transientRetries = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await callLiveLLM(promptOverride, onStreamProgress, isEvent, budget, hasPendingImg);
    } catch (err) {
      if (hasPendingImg && isVisionUnsupportedError(err)) {
        markModelNonVision(runtime.state.settings.model, runtime.state.settings.baseUrl);
        const vErr = new Error(`当前模型「${runtime.state.settings.model}」不支持图片输入，已为你记住该限制。以后直接发文字即可，或换一个支持视觉的模型再发图。`);
        vErr.isVisionNotice = true;
        throw vErr;
      }
      if (err.name === 'AbortError') throw err;
      if (runtime.replyAbortRequested || runtime.activeAbortController?.signal?.aborted) {
        const abErr = new Error('已取消请求');
        abErr.name = 'AbortError';
        throw abErr;
      }
      if (isRetryableTransientError(err) && transientRetries < 2) {
        transientRetries++;
        const waitEnd = Date.now() + transientRetries * 1400;
        while (Date.now() < waitEnd) {
          if (runtime.replyAbortRequested || runtime.activeAbortController?.signal?.aborted) {
            const abErr = new Error('已取消请求');
            abErr.name = 'AbortError';
            throw abErr;
          }
          await sleep(80);
        }
        continue;
      }
      if (!isContextLimitError(err) || attempt >= 4) {
        throw err;
      }
      budget = Math.max(8000, Math.floor(budget / 2));
    }
  }
}

export async function callDemoEngine(userText, isEvent, hasImage = false) {
  await sleep(500);
  if (hasImage) {
    return `收到你发的照片啦！|||不过现在是离线演示模式，我还看不到图片里面的内容；在右上角填上支持识图的模型 API Key，我就能真看懂了。<AFFECTION delta="+1" mood="好奇张望" />`;
  }
  if (isEvent) {
    if (userText.includes('早睡')) {
      return `不错嘛，今晚真挺听话的！|||奖励你一朵小红花，快去躺好盖被子。<AFFECTION delta="+2" mood="很满意" />`;
    }
    if (userText.includes('转盘') || userText.includes('抽中了')) {
      return `天意如此，不许反悔重转啊哈哈哈！|||赶紧去吃，记得拍给我看。<AFFECTION delta="+1" mood="嘴馋了" />`;
    }
    if (userText.includes('心情')) {
      return `我接住这颗小心情了。|||不管是开心还是累了，先丢进罐子里，剩下的有我陪你。<AFFECTION delta="+2" mood="温柔守护" />`;
    }
    if (userText.includes('喝了') || userText.includes('喝满')) {
      return `乖，多喝水才不会上火。|||继续保持呀。<AFFECTION delta="+1" mood="开心" />`;
    }
    if (userText.includes('贴贴')) {
      return `怎么突然这么黏人呀…|||好啦，抱紧一点，不松手。<AFFECTION delta="+2" mood="脸红中" />`;
    }
    return `收到你的动静啦，看来这个小组件挺顺手的嘛。<AFFECTION delta="+1" mood="开心" />`;
  }

  if (/早睡|打卡|熬夜|睡觉/.test(userText)) {
    return `行，怕你又刷手机到两点，给你做了张按日期记录的早睡打卡卡。|||以后每晚十二点前点一下，我盯着你呢。<AFFECTION delta="+2" mood="认真监督" />
<WIDGET title="🌙 十二点前早睡打卡" height="208">
<style>
body { padding: 14px; color: var(--w-text, #111827); background: var(--w-bg, #ffffff); }
.top { display: flex; justify-content: space-between; align-items: baseline; }
.streak { font-size: 26px; font-weight: 700; color: var(--w-accent, #4d6bfe); }
.label { font-size: 12px; color: var(--w-sub, #6b7280); margin-top: 2px; }
.week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin: 14px 0; }
.day { text-align: center; padding: 7px 0; border-radius: 9px; font-size: 11px; background: var(--w-muted, #f2f4f8); color: var(--w-sub, #6b7280); }
.day.today { border: 1px dashed var(--w-accent, #4d6bfe); color: var(--w-accent, #4d6bfe); font-weight: 600; }
.day.done { background: var(--w-soft, #eff4ff); color: var(--w-accent, #4d6bfe); border: 1px solid var(--w-border, rgba(77,107,254,0.35)); font-weight: 700; }
button { width: 100%; padding: 10px; border: none; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; background: var(--w-accent, #4d6bfe); color: #fff; }
button:disabled { background: var(--w-muted, #e6e9f0); color: var(--w-sub, #6b7280); cursor: default; }
</style>
<div class="top">
<div><div style="font-weight:600;font-size:14px;">今晚 24:00 前放下手机</div><div class="label" id="tip">准备好了就点下方打卡</div></div>
<div class="streak"><span id="stNum">0</span><span style="font-size:12px;font-weight:500;"> 天</span></div>
</div>
<div class="week" id="week"></div>
<button id="checkBtn">🌙 我准备睡啦 · 立即打卡</button>
<script>
const days = ['一','二','三','四','五','六','日'];
const now = new Date();
const today = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
const todayWeekIdx = (now.getDay() + 6) % 7;
const monday = new Date(now);
monday.setDate(now.getDate() - todayWeekIdx);
const weekKey = monday.getFullYear() + '-' + String(monday.getMonth()+1).padStart(2,'0') + '-' + String(monday.getDate()).padStart(2,'0');

const st = Object.assign({ streak: 0, weekKey, weekDone: [], lastDoneDate: '' }, CompanionBridge.getState());
if (st.weekKey !== weekKey) {
  st.weekKey = weekKey;
  st.weekDone = [];
  CompanionBridge.saveState(st);
}

function render() {
  const todayDone = st.lastDoneDate === today;
  document.getElementById('stNum').textContent = st.streak;
  document.getElementById('tip').textContent = todayDone ? '今天已经乖乖打过卡啦' : '今天还没打卡，早点闭眼哦';
  const w = document.getElementById('week');
  w.innerHTML = days.map((d, i) => {
    const cls = ['day'];
    if (i === todayWeekIdx) cls.push('today');
    if (st.weekDone.includes(i)) cls.push('done');
    return '<div class="' + cls.join(' ') + '">周' + d + '</div>';
  }).join('');
  const btn = document.getElementById('checkBtn');
  btn.disabled = todayDone;
  btn.textContent = todayDone ? '✨ 今日已乖乖打卡' : '🌙 我准备睡啦 · 立即打卡';
}

document.getElementById('checkBtn').onclick = () => {
  if (st.lastDoneDate === today) return;
  st.lastDoneDate = today;
  st.streak += 1;
  if (!st.weekDone.includes(todayWeekIdx)) st.weekDone.push(todayWeekIdx);
  CompanionBridge.saveState(st);
  render();
  CompanionBridge.emit('完成了今日早睡打卡！已经累计早睡 ' + st.streak + ' 天');
};
render();
<` + `/script>
</WIDGET>`;
  }

  if (/吃什么|转盘|美食|决定/.test(userText)) {
    return `我就知道你又选择困难症犯了。|||把菜名都给你印到扇区上了，转到什么就去吃什么，不许耍赖。<AFFECTION delta="+1" mood="看戏中" />
<WIDGET title="🍜 今晚吃什么转盘" height="274">
<style>
body { padding: 14px; text-align: center; color: var(--w-text, #111827); background: var(--w-bg, #ffffff); }
.wheel-wrap { position: relative; width: 172px; height: 172px; margin: 6px auto 12px; }
.pointer { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 15px solid var(--w-accent, #4d6bfe); z-index: 3; }
.wheel { position: relative; width: 100%; height: 100%; border-radius: 50%; border: 3px solid var(--w-border, #e6e9f0); transition: transform 2.4s cubic-bezier(0.16, 1, 0.3, 1); background: conic-gradient(#4d6bfe 0 60deg, #60a5fa 60deg 120deg, #818cf8 120deg 180deg, #38bdf8 180deg 240deg, #6366f1 240deg 300deg, #93c5fd 300deg 360deg); overflow: hidden; }
.slice-label { position: absolute; left: 50%; top: 50%; width: 52px; margin-left: -26px; margin-top: -10px; font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 1px 2px rgba(15,23,42,0.35); text-align: center; pointer-events: none; }
.hub { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 42px; height: 42px; border-radius: 50%; background: var(--w-bg, #ffffff); display: flex; align-items: center; justify-content: center; font-size: 16px; border: 2px solid var(--w-border, #e6e9f0); z-index: 2; }
.res { font-size: 13.5px; font-weight: 600; min-height: 22px; margin-bottom: 10px; color: var(--w-accent, #4d6bfe); }
button { width: 100%; padding: 10px; border: none; border-radius: 10px; background: var(--w-accent, #4d6bfe); color: #fff; font-weight: 600; font-size: 13px; cursor: pointer; }
button:disabled { opacity: 0.6; }
</style>
<div class="wheel-wrap">
<div class="pointer"></div>
<div class="wheel" id="wheel"></div>
<div class="hub">🍽️</div>
</div>
<div class="res" id="res">点下面让命运决定今晚吃啥</div>
<button id="spinBtn">🎲 开始转动</button>
<script>
const foods = [
  { short: '牛肉锅', full: '潮汕牛肉火锅' },
  { short: '拉面', full: '日式猪骨拉面' },
  { short: '烤肉', full: '炭火烤肉' },
  { short: '冬阴功', full: '泰式冬阴功' },
  { short: '香锅', full: '麻辣香锅' },
  { short: '轻食', full: '轻食煎鸡胸' }
];
const wheel = document.getElementById('wheel');
foods.forEach((f, idx) => {
  const lbl = document.createElement('div');
  lbl.className = 'slice-label';
  const angle = idx * 60 + 30;
  lbl.style.transform = 'rotate(' + angle + 'deg) translateY(-54px)';
  lbl.textContent = f.short;
  wheel.appendChild(lbl);
});

let deg = 0, spinning = false;
const res = document.getElementById('res');
const btn = document.getElementById('spinBtn');
const saved = CompanionBridge.getState();
if (saved.lastFood) res.textContent = '上次抽中：' + saved.lastFood;

btn.onclick = () => {
  if (spinning) return;
  spinning = true;
  btn.disabled = true;
  const pick = Math.floor(Math.random() * foods.length);
  const targetMod = (360 - (pick * 60 + 30)) % 360;
  const currentMod = ((deg % 360) + 360) % 360;
  const delta = (targetMod - currentMod + 360) % 360;
  deg += 1080 + delta;
  wheel.style.transform = 'rotate(' + deg + 'deg)';
  res.textContent = '正在转动…';
  setTimeout(() => {
    spinning = false;
    btn.disabled = false;
    const food = foods[pick].full;
    res.textContent = '✨ 就决定吃：' + food + '！';
    CompanionBridge.saveState({ lastFood: food });
    CompanionBridge.emit('转盘抽中了「' + food + '」');
  }, 2450);
};
<` + `/script>
</WIDGET>`;
  }

  if (/倒计时|纪念日|旅行/.test(userText)) {
    return `把我们的旅行倒计时挂上墙啦。|||每天看着数字变小，连上班摸鱼都有盼头了。<AFFECTION delta="+2" mood="满怀期待" />
<WIDGET title="⏳ 下一次一起出发" height="196">
<style>
body { padding: 14px; color: var(--w-text, #111827); background: var(--w-bg, #ffffff); }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
.box { background: var(--w-muted, #f7f8fa); border: 1px solid var(--w-border, #e6e9f0); border-radius: 12px; padding: 10px 4px; text-align: center; }
.n { font-size: 20px; font-weight: 700; color: var(--w-accent, #4d6bfe); }
.u { font-size: 10px; color: var(--w-sub, #6b7280); margin-top: 2px; }
.foot { display: flex; gap: 8px; align-items: center; }
input { flex: 1; background: var(--w-muted, #f7f8fa); border: 1px solid var(--w-border, #d5dbe6); color: var(--w-text, #111827); border-radius: 10px; padding: 7px 9px; font-size: 12px; }
button { padding: 8px 12px; border: none; border-radius: 10px; background: var(--w-accent, #4d6bfe); color: #ffffff; font-weight: 600; font-size: 12px; cursor: pointer; }
</style>
<div style="font-size:13px;font-weight:600;" id="heading">距离海边看日出还有</div>
<div class="grid">
<div class="box"><div class="n" id="d">00</div><div class="u">天</div></div>
<div class="box"><div class="n" id="h">00</div><div class="u">时</div></div>
<div class="box"><div class="n" id="m">00</div><div class="u">分</div></div>
<div class="box"><div class="n" id="s">00</div><div class="u">秒</div></div>
</div>
<div class="foot">
<input type="date" id="datePick" />
<button id="pingBtn">💌 催出发</button>
</div>
<script>
const defDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
const st = Object.assign({ target: defDate }, CompanionBridge.getState());
const pick = document.getElementById('datePick');
const heading = document.getElementById('heading');
pick.value = st.target || defDate;
pick.onchange = () => {
  st.target = pick.value || '';
  CompanionBridge.saveState(st);
  tick();
};
function tick() {
  if (!st.target || !/^\\d{4}-\\d{2}-\\d{2}$/.test(st.target)) {
    heading.textContent = '选个日期再开始倒数吧';
    ['d','h','m','s'].forEach(id => document.getElementById(id).textContent = '--');
    return;
  }
  const targetMs = new Date(st.target + 'T08:00:00').getTime();
  if (Number.isNaN(targetMs)) {
    ['d','h','m','s'].forEach(id => document.getElementById(id).textContent = '--');
    return;
  }
  const diff = targetMs - Date.now();
  if (diff <= 0) {
    heading.textContent = '🎉 出发日到啦！';
    ['d','h','m','s'].forEach(id => document.getElementById(id).textContent = '00');
    return;
  }
  heading.textContent = '距离海边看日出还有';
  document.getElementById('d').textContent = String(Math.floor(diff / 86400000)).padStart(2, '0');
  document.getElementById('h').textContent = String(Math.floor(diff / 3600000) % 24).padStart(2, '0');
  document.getElementById('m').textContent = String(Math.floor(diff / 60000) % 60).padStart(2, '0');
  document.getElementById('s').textContent = String(Math.floor(diff / 1000) % 60).padStart(2, '0');
}
document.getElementById('pingBtn').onclick = () => CompanionBridge.emit('看了一眼旅行倒计时，已经迫不及待想出发了');
tick(); setInterval(tick, 1000);
<` + `/script>
</WIDGET>`;
  }

  if (/心情|情绪|罐子/.test(userText)) {
    return `给你吹了一个透明心情玻璃罐。|||以后不管什么情绪，点一下就存进来，点彩球还能回看当时是什么时候丢进去的。<AFFECTION delta="+2" mood="温柔" />
<WIDGET title="🫧 我们的心情玻璃罐" height="238">
<style>
body { padding: 14px; color: var(--w-text, #111827); background: var(--w-bg, #ffffff); }
.jar { min-height: 92px; padding: 10px; border-radius: 14px; background: var(--w-muted, #f7f9fc); border: 1.5px solid var(--w-border, #dbe4f3); display: flex; flex-wrap: wrap; align-content: flex-end; gap: 7px; margin-bottom: 8px; }
.ball { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; box-shadow: inset -2px -2px 4px rgba(15,23,42,0.12), 0 2px 5px rgba(15,23,42,0.08); cursor: pointer; animation: drop .35s cubic-bezier(.34,1.56,.64,1); }
@keyframes drop { from { transform: translateY(-28px) scale(.5); opacity: 0; } to { transform: none; opacity: 1; } }
.note { font-size: 11px; color: var(--w-sub, #6b7280); min-height: 18px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
.clear-link { color: #9ca3af; cursor: pointer; text-decoration: underline; }
.moods { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
button { padding: 8px 4px; border: 1px solid var(--w-border, #e6e9f0); border-radius: 10px; background: var(--w-muted, #f7f8fa); color: var(--w-text, #111827); font-size: 11px; cursor: pointer; }
button:hover { border-color: var(--w-accent, #4d6bfe); background: var(--w-soft, #eff4ff); color: var(--w-accent, #4d6bfe); }
</style>
<div class="jar" id="jar"></div>
<div class="note"><span id="noteText">点击下方按钮丢一颗情绪进罐子</span><span class="clear-link" id="clearJar">清空</span></div>
<div class="moods">
<button data-e="☀️" data-c="#fef3c7" data-t="超开心">☀️ 开心</button>
<button data-e="🫧" data-c="#e0f2fe" data-t="平静摸鱼">🫧 摸鱼</button>
<button data-e="🌙" data-c="#e0e7ff" data-t="有点累了">🌙 好累</button>
<button data-e="🍓" data-c="#ffe4e6" data-t="想你了">🍓 想你</button>
</div>
<script>
const st = Object.assign({ balls: [
  { e: '☀️', c: '#fef3c7', t: '超开心', at: '初始化' },
  { e: '🍓', c: '#ffe4e6', t: '想你了', at: '初始化' }
]}, CompanionBridge.getState());
const jar = document.getElementById('jar');
const noteText = document.getElementById('noteText');
function render() {
  jar.innerHTML = '';
  st.balls.slice(-24).forEach(b => {
    const el = document.createElement('div');
    el.className = 'ball';
    el.style.background = b.c;
    el.textContent = b.e;
    el.onclick = () => {
      noteText.textContent = (b.at || '之前') + ' · ' + (b.t || '小心情');
    };
    jar.appendChild(el);
  });
}
document.querySelectorAll('.moods button').forEach(btn => {
  btn.onclick = () => {
    const d = new Date();
    const at = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    st.balls.push({ e: btn.dataset.e, c: btn.dataset.c, t: btn.dataset.t, at });
    if (st.balls.length > 60) st.balls = st.balls.slice(-40);
    CompanionBridge.saveState(st);
    noteText.textContent = '刚刚放进一颗「' + btn.dataset.t + '」';
    render();
    CompanionBridge.emit('往心情玻璃罐里丢了一颗「' + btn.dataset.t + '」');
  };
});
document.getElementById('clearJar').onclick = () => {
  st.balls = [];
  CompanionBridge.saveState(st);
  noteText.textContent = '罐子已经倒空啦';
  render();
};
render();
<` + `/script>
</WIDGET>`;
  }

  if (/拍照|照片|自拍|画一张|发一张图|生图|修图|换装/.test(userText || '')) {
    return `现在还是离线演示模式哦～|||点上方蓝色横条填上对话 Key 和魔搭生图 Token，我就能随时给你拍照片或按你说的改图啦。`;
  }

  return `我在听呢。|||现在是零配置演示模式——点上方「第一步」填好 API Key 就能解锁真 AI 伴侣，也可以先点下方快捷标签试试现做组件。`;
}
