import { runtime } from './state.js';
import { CONTEXT_TIERS } from './presets.js';
import { formatCompactTimeAnchor } from './utils.js';
import {
  upsertMemory,
  removeMemoryByKey,
  pruneSceneStates,
  upsertSceneState,
  removeSceneStateByKey,
  formatSceneAge,
  selectRelevantMemories,
  getSpecialDateCue
} from './memory.js';
import { isImageGenReady, getImagePromptSection } from './image-gen.js';
import { summarizeWidgetBoardForContext } from './widget-context.js';

export function parseTagAttrs(attrStr) {
  const normalized = String(attrStr || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const attrs = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

export function stripThinkingTags(rawText) {
  return String(rawText || '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/gi, '');
}

export function stripStageDirections(rawText, stripDanglingStar = false) {
  // 仅清理明确的单星号舞台格式（*动作*），保留 Markdown **加粗** 与所有中文/英文括号，避免关键词误伤日常表达
  let txt = String(rawText || '')
    .replace(/(?<!\*)\*(?!\*)[^*\n]{1,120}(?<!\*)\*(?!\*)/g, ' ');
  if (stripDanglingStar) {
    txt = txt.replace(/(?<!\*)\*[^*\n]*$/g, '');
  }
  return txt
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseAssistantOutput(rawText) {
  const state = runtime.state;
  let cleanText = stripThinkingTags(rawText);
  const newWidgets = [];
  const newImages = [];
  const boardOps = [];
  let hasUnclosedWidget = false;

  cleanText = cleanText.replace(/<AFFECTION\b([^>]*?)\/?>(?:<\/AFFECTION>)?/gi, (_, attrStr) => {
    const attrs = parseTagAttrs(attrStr);
    if (attrs.delta !== undefined) {
      const d = Number(attrs.delta);
      if (!Number.isNaN(d)) {
        state.affection = Math.max(0, Math.min(100, state.affection + d));
      }
    }
    if (attrs.mood) state.mood = attrs.mood;
    return '';
  });

  cleanText = cleanText.replace(/<MEMORY\b([^>]*?)\/?>(?:<\/MEMORY>)?/gi, (_, attrStr) => {
    const attrs = parseTagAttrs(attrStr);
    if (attrs.op === 'del' || attrs.op === 'delete') {
      if (attrs.key) removeMemoryByKey(attrs.key);
    } else if (attrs.key && attrs.value) {
      upsertMemory(attrs.key, attrs.value);
    }
    return '';
  });

  cleanText = cleanText.replace(/<STATE\b([^>]*?)\/?>(?:<\/STATE>)?/gi, (_, attrStr) => {
    const attrs = parseTagAttrs(attrStr);
    if (attrs.op === 'del' || attrs.op === 'delete' || attrs.value === '') {
      if (attrs.key) removeSceneStateByKey(attrs.key);
    } else if (attrs.key && attrs.value) {
      upsertSceneState(attrs.key, attrs.value);
    }
    return '';
  });

  cleanText = cleanText.replace(/<BOARD\b([^>]*?)\/?>(?:<\/BOARD>)?/gi, (_, attrStr) => {
    const attrs = parseTagAttrs(attrStr);
    const op = String(attrs.op || '').trim().toLowerCase();
    const text = String(attrs.text || attrs.item || attrs.value || '').trim();
    if (['todo_add', 'todo_done', 'note'].includes(op) && text && boardOps.length < 4) {
      boardOps.push({ op, text: text.slice(0, 80) });
    }
    return '';
  });

  cleanText = cleanText.replace(/<IMAGE\b([^>]*?)\/?>(?:<\/IMAGE>)?/gi, (_, attrStr) => {
    const attrs = parseTagAttrs(attrStr);
    const prompt = String(attrs.prompt || '').trim();
    if (prompt && newImages.length < 2) {
      newImages.push({
        prompt,
        size: String(attrs.size || '1152x1536').trim(),
        ref: String(attrs.ref || '').trim().toLowerCase()
      });
    }
    return '';
  });

  let resultText = '';
  let cursor = 0;
  const lower = () => cleanText.toLowerCase();

  while (cursor < cleanText.length) {
    const openIdx = lower().indexOf('<widget', cursor);
    if (openIdx === -1) {
      resultText += cleanText.slice(cursor);
      break;
    }
    const nextCh = cleanText[openIdx + 7];
    if (nextCh && !/[\s>]/.test(nextCh)) {
      resultText += cleanText.slice(cursor, openIdx + 7);
      cursor = openIdx + 7;
      continue;
    }
    const openEnd = cleanText.indexOf('>', openIdx);
    if (openEnd === -1) {
      resultText += cleanText.slice(cursor, openIdx);
      hasUnclosedWidget = true;
      break;
    }

    resultText += cleanText.slice(cursor, openIdx);
    const attrStr = cleanText.slice(openIdx + 7, openEnd);
    const closeIdx = lower().indexOf('</widget>', openEnd + 1);

    if (closeIdx === -1) {
      hasUnclosedWidget = true;
      break;
    }

    let body = cleanText.slice(openEnd + 1, closeIdx).trim();
    body = body.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '').trim();

    if (body) {
      const attrs = parseTagAttrs(attrStr);
      const parsedH = Number(attrs.height);
      newWidgets.push({
        id: 'w_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        title: attrs.title || '专属小组件',
        replace: attrs.replace || '',
        height: !Number.isNaN(parsedH) && parsedH > 0 ? Math.max(140, Math.min(460, parsedH)) : 220,
        createdAt: Date.now(),
        html: body
      });
    }
    cursor = closeIdx + 9;
  }

  resultText = resultText
    .replace(/```(?:html)?\s*```/gi, '')
    .replace(/^\s*```(?:html)?\s*$/gim, '');

  let bubbles = resultText
    .split('|||')
    .map(s => s.trim())
    .filter(Boolean);

  if (state.settings.chatMode !== 'story') {
    bubbles = bubbles
      .map(b => stripStageDirections(b, false))
      .filter(Boolean);
  }

  if (hasUnclosedWidget) {
    bubbles.push('哎呀，组件代码写到一半被模型长度截断了，你让我再试一次吧。');
  }

  return { bubbles, newWidgets, newImages, boardOps };
}

export function formatMessageForModel(m) {
  const state = runtime.state;
  if (!m || m.imgPending || m.isError) return null;
  const replyPrefix = m.replyTo
    ? `[引用回复 ${m.replyTo.who || '之前'} 的“${String(m.replyTo.preview || '').slice(0, 48)}”] `
    : '';
  if (m.role === 'user') {
    if (m.stickerId || m.stickerImg) {
      return { role: 'user', content: replyPrefix + `[发送了表情贴纸：${m.stickerLabel || '贴纸'}]` };
    }
    const txt = (m.text || '').trim();
    return { role: 'user', content: replyPrefix + (m.image ? (txt ? `[图片] ${txt}` : '[用户发送了一张图片]') : txt) };
  }
  if (m.role === 'assistant') {
    let txt = (m.text || '')
      .replace(/\[已发送一张(?:照片|图片)(?:\/图片)?\]/g, '')
      .replace(/\[曾发过一张照片[：:][\s\S]*?\]/g, '')
      .trim();
    if (state.settings.chatMode !== 'story' && txt) {
      txt = stripStageDirections(txt, false)
        .replace(/^\s*\d+[.、]\s+/gm, '')
        .trim();
    }
    if (m.image) {
      const safePrompt = String(m.imgPrompt || '刚才发给用户的照片').replace(/"/g, "'");
      const imgTag = `<IMAGE prompt="${safePrompt}" />`;
      return { role: 'assistant', content: txt ? `${txt}\n${imgTag}` : imgTag };
    }
    return txt ? { role: 'assistant', content: txt } : null;
  }
  if (m.role === 'event') {
    if (String(m.text || '').includes('已停止本次生成')) return null;
    return { role: 'user', content: `（对方在桌面小组件点了互动：${m.text}）` };
  }
  if (m.role === 'spawn') return { role: 'assistant', content: `[已在「${state.settings.name || '伴侣'}的家」挂载小组件：${m.title}]` };
  return null;
}

export function buildConversationHistory(promptOverride, isEvent = false, budgetChars = null, allowVisionForLast = true) {
  const state = runtime.state;
  const tier = CONTEXT_TIERS[state.settings.contextMode] || CONTEXT_TIERS.long;
  const limit = budgetChars || state.settings.maxContextChars || tier.chars;
  const maxMsgs = state.settings.maxContextMsgs || tier.msgs;
  const total = state.messages.length;
  const selected = [];
  let usedChars = 0;

  let lastUserImgIdx = -1;
  for (let i = total - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (!m || m.imgPending) continue;
    if (m.role === 'assistant') break;
    if (m.role === 'user' && m.image) {
      lastUserImgIdx = i;
      break;
    }
  }

  let windowStartIndex = total;
  for (let i = total - 1; i >= 0; i--) {
    const rawMsg = state.messages[i];
    const entry = formatMessageForModel(rawMsg);
    if (!entry || !entry.content) continue;
    const len = entry.content.length;
    if (selected.length >= 4 && (usedChars + len > limit || selected.length >= maxMsgs)) {
      break;
    }
    const attachImage = allowVisionForLast && i === lastUserImgIdx && rawMsg.role === 'user' && rawMsg.image;
    selected.unshift({ index: i, createdAt: rawMsg.createdAt || 0, ...entry, image: attachImage ? rawMsg.image : null, rawText: rawMsg.text || '' });
    usedChars += len;
    windowStartIndex = i;
  }

  const msgs = [];
  let prevAnchorTs = 0;
  let prevDaySlot = '';
  for (const item of selected) {
    let stampedContent = item.content;
    if (item.createdAt) {
      const dt = new Date(item.createdAt);
      const h = dt.getHours();
      const periodTag = h < 5 ? 'night' : h < 9 ? 'dawn' : h < 12 ? 'am' : h < 14 ? 'noon' : h < 18 ? 'pm' : h < 23 ? 'eve' : 'night';
      const daySlot = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}-${periodTag}`;
      if (!prevAnchorTs || (item.createdAt - prevAnchorTs > 15 * 60 * 1000) || daySlot !== prevDaySlot) {
        stampedContent = `[${formatCompactTimeAnchor(item.createdAt)}]\n${stampedContent}`;
        prevAnchorTs = item.createdAt;
        prevDaySlot = daySlot;
      }
    }
    const prev = msgs[msgs.length - 1];
    if (item.image) {
      const textPart = stampedContent || item.rawText || '请看看这张图片';
      const mergedText = (prev && prev.role === 'user' && typeof prev.content === 'string')
        ? `${prev.content}\n${textPart}`
        : textPart;
      const multiContent = [
        { type: 'text', text: mergedText },
        { type: 'image_url', image_url: { url: item.image } }
      ];
      if (prev && prev.role === 'user') {
        prev.content = multiContent;
      } else {
        msgs.push({ role: 'user', content: multiContent });
      }
    } else if (prev && prev.role === item.role && typeof prev.content === 'string') {
      prev.content += '\n' + stampedContent;
    } else {
      msgs.push({ role: item.role, content: stampedContent });
    }
  }

  if (promptOverride) {
    const prev = msgs[msgs.length - 1];
    if (isEvent && prev && prev.role === 'user' && typeof prev.content === 'string' && prev.content.includes('在桌面小组件点了互动：')) {
      prev.content += '\n（用自然亲昵的口吻随口接一句即可，别刻意报次数或重复做组件。）';
    } else if (prev && prev.role === 'user' && typeof prev.content === 'string') {
      prev.content += '\n' + promptOverride;
    } else {
      msgs.push({ role: 'user', content: promptOverride });
    }
  }
  return { msgs, windowStartIndex };
}

export function getLocalTimeContext() {
  const d = new Date();
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const h = d.getHours();
  const period = h < 5 ? '深夜' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${dateStr} ${days[d.getDay()]} ${timeStr}（${period}）`;
}

export function getTimeGapContext() {
  const msgs = Array.isArray(runtime.state.messages) ? runtime.state.messages : [];
  let prevAt = 0;
  for (let i = msgs.length - 2; i >= 0; i--) {
    if (msgs[i]?.createdAt && !msgs[i]?.isStarter) {
      prevAt = msgs[i].createdAt;
      break;
    }
  }
  if (!prevAt) return '';
  const diffMs = Date.now() - prevAt;
  const hours = diffMs / 3600000;
  if (hours < 6) return '';
  if (hours < 24) return `距离上一轮对话约 ${Math.round(hours)} 小时`;
  const days = Math.round(hours / 24);
  return `距离上一轮对话约 ${days} 天，可自然带出一点久违感`;
}

export function getTemperatureValue() {
  const mode = runtime.state.settings.temperatureMode || 'balanced';
  return mode === 'calm' ? 0.65 : (mode === 'vivid' ? 1.0 : 0.85);
}

export function detectPromptIntents(historyMsgs, promptOverride = '') {
  const state = runtime.state;
  const recentSlice = historyMsgs.slice(-3).map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(p => p?.text || '').join(' ');
    return '';
  }).join('\n') + '\n' + String(promptOverride || '');
  const needWidget = /(组件|小窝|家里|工具|打卡|转盘|倒计时|罐子|清单|卡片|日历|面板|做个|做一|改一下|修好|widget)/i.test(recentSlice);
  const needImage = isImageGenReady() && (
    state.settings.imgTrigger === 'auto' ||
    /(拍照|自拍|照片|图片|画|看你|发张|重拍|换装|换背景|修图|p一下|穿搭|长什么样|image)/i.test(recentSlice)
  );
  return { needWidget, needImage };
}

export function buildSystemPrompt({ needWidget = false, needImage = false } = {}) {
  const state = runtime.state;
  const charName = state.settings.name || '林澈';
  const age = (state.settings.age || '').trim();
  const gender = (state.settings.gender || '').trim();
  const appearance = (state.settings.appearance || '').trim();
  const anchors = (state.settings.anchors || '').trim();
  const sampleDialogue = (state.settings.sampleDialogue || '').trim();
  const isStory = state.settings.chatMode === 'story';
  const themeHint = state.settings.theme === 'glass-dark'
    ? '暖炭夜深底 #252320，字 #efeae1，次级 #938b7f，主色 #e08a69'
    : (state.settings.theme === 'glass-light'
      ? '奶油玫瑰白底 #ffffff，字 #261d1e，次级 #806e70，主色 #c26d7a'
      : (state.settings.theme === 'claude'
        ? '暖纸白底 #ffffff，字 #1f1e1b，主色 #d97757'
        : '清茶绿白底 #ffffff，字 #1c241f，主色 #587d68'));

  const ageLine = age ? `\n年龄：${age}` : '';
  const genderLine = gender ? `\n性别：${gender}` : '';
  const appearanceBlock = (needImage && appearance)
    ? `\n身材与外貌（拍照出镜保持一致）：${appearance}`
    : '';
  const anchorBlock = anchors
    ? `\n\n【核心防飘铁规（称呼 / 口癖 / 禁忌，最高优先级）】\n${anchors}`
    : '';
  const promptPersona = isStory
    ? state.settings.persona
    : stripStageDirections(state.settings.persona, false);
  const promptSample = (!isStory && sampleDialogue)
    ? stripStageDirections(sampleDialogue, false)
    : sampleDialogue;
  const sampleBlock = promptSample
    ? `\n\n【TA 真实说话示范（${isStory ? '沿用短句、节奏与语气' : '仅沿用口癖、短句节奏与语气；忽略任何旁白或动作格式'}）】\n${promptSample}`
    : '';

  const modeRule = isStory
    ? '1. 「小剧场」模式开启：入戏扮演用户私密恋人，自然带有 *神态、动作、眼神* 描写推进互动；严禁说教与 1.2.3. 列表腔。\n2. 长短完全随场景流动，可一句话直出，需要换气停顿时再用 ||| 拆成 1~3 条。\n3. 严格保持前后事实、物理场景与刚答应的约定连贯一致，绝不自相矛盾。'
    : '1. 当前为「日常微信纯文字聊天」模式：完整保留上方人物性格、称呼与口癖语气，只剥离非对话排版——只输出手机聊天软件里真人会直接发出的纯说话口语！哪怕人设档案、示范或前文带有舞台动作、神态描述或小说旁白，此处也一律只讲纯对话，绝不模仿任何动作/心理/旁白格式。\n2. 严禁使用星号动作标记、括号神态旁白或 1.2.3. 列表腔；所有情绪与态度只通过纯说话用词与节奏自然流露。\n3. 长短完全随当下气氛走，不硬凑两句！对方只发简短词句时，可只回几个字或一句短话；话多或要逗一下才用 ||| 拆 1~3 条短气泡。\n4. 严格遵守后台【当前实时场景状态】，若有临时状态（如灯光开关、位置、刚答应的事）发生变化，必须附 <STATE> 更新。';

  const widgetRule = needWidget
    ? `\n- 做/改家中小组件（仅明确要求时附）：<WIDGET title="名称" replace="改旧填原名" height="240">断网HTML/JS，配色(${themeHint})。规范：①禁止写 height:100vh 或 min-height:100vh（按内容自然撑高）；②禁止用 localStorage，读写状态用 CompanionBridge.getState()/saveState(obj)；③每次关键按钮点击或状态变化时，必须同时调 CompanionBridge.saveState(st) 与 CompanionBridge.emit('简短说明用户刚做了什么') 以便伴侣实时看到并回应</WIDGET>`
    : '';
  const imgRule = getImagePromptSection();

  return `【私密伴侣身份档案（静态锚点，绝不跳脱或反问自己是谁）】
名字：${charName}${genderLine}${ageLine}${appearanceBlock}
性格与相处方式：
${promptPersona}${anchorBlock}${sampleBlock}

【当前聊天形式与输出格式（强制覆盖一切旁白/小说排版惯性）】
${modeRule}

【极简后台暗标（用户不可见，别说破）】
- 情绪波动时附：<AFFECTION delta="+1" mood="二到四字心情" />
- 当房间灯光、彼此位置、刚答应的临时约定或正在做的事变化时附：<STATE key="对象名" value="当前状态" />（同 key 新状态自动覆盖旧状态，作废用 op="del"）
- 遇值得记一月以上的事实时附：<MEMORY key="标签" value="事实" />（删旧用 op="del"）
- 对方明确让你记待办、勾掉待办或换家里便利贴时可附：<BOARD op="todo_add" text="待办内容" />、<BOARD op="todo_done" text="关键词" /> 或 <BOARD op="note" text="便利贴内容" />${widgetRule}${imgRule}`;
}

const TRIVIAL_PHRASES = new Set(['不是的', '怎么了', '有没有', '什么事', '为什么', '不知道', '差不多', '没关系', '的时候', '都可以', '真的吗', '好不好']);

export function detectRepetitivePhrases(recentAssistantTexts) {
  if (!Array.isArray(recentAssistantTexts) || recentAssistantTexts.length < 3) return [];
  const texts = recentAssistantTexts.slice(-5).map(t => String(t || '').trim()).filter(Boolean);
  if (texts.length < 3) return [];

  const hits = [];
  // 1. Repeated leading opener (2-5 Chinese chars at start of >=3 replies)
  const openerCounts = new Map();
  for (const t of texts) {
    const m = t.match(/^[\u4e00-\u9fa5]{2,5}/);
    if (!m) continue;
    const op = m[0];
    for (let len = Math.min(4, op.length); len >= 2; len--) {
      const sub = op.slice(0, len);
      openerCounts.set(sub, (openerCounts.get(sub) || 0) + 1);
    }
  }
  const repOpeners = [...openerCounts.entries()]
    .filter(([k, cnt]) => cnt >= 3 && !TRIVIAL_PHRASES.has(k))
    .sort((a, b) => b[0].length - a[0].length || b[1] - a[1]);
  if (repOpeners.length) hits.push(repOpeners[0][0]);

  // 2. Repeated 3-6 char Chinese phrase appearing in >=3 distinct recent replies
  const phraseDocCount = new Map();
  for (const t of texts) {
    const segs = t.match(/[\u4e00-\u9fa5]{3,}/g) || [];
    const seenInDoc = new Set();
    for (const seg of segs) {
      const maxLen = Math.min(6, seg.length);
      for (let len = 3; len <= maxLen; len++) {
        for (let i = 0; i <= seg.length - len; i++) {
          const p = seg.slice(i, i + len);
          if (!TRIVIAL_PHRASES.has(p)) seenInDoc.add(p);
        }
      }
    }
    for (const p of seenInDoc) {
      phraseDocCount.set(p, (phraseDocCount.get(p) || 0) + 1);
    }
  }
  const repPhrases = [...phraseDocCount.entries()]
    .filter(([p, cnt]) => cnt >= 3)
    .sort((a, b) => b[0].length - a[0].length || b[1] - a[1]);
  for (const [p] of repPhrases) {
    if (hits.some(h => h.includes(p) || p.includes(h))) continue;
    hits.push(p);
    if (hits.length >= 2) break;
  }
  return hits;
}

export function buildDynamicContextNote(needWidget = false, windowMsgs = null) {
  const state = runtime.state;
  const charName = state.settings.name || '林澈';
  const isStory = state.settings.chatMode === 'story';
  const anchors = (state.settings.anchors || '').trim();
  const gapHint = getTimeGapContext();
  const timeNote = gapHint
    ? `${getLocalTimeContext()}（${gapHint}，自然感知即可）`
    : `${getLocalTimeContext()}（自然感知时段，别刻意报时）`;
  const activeSceneStates = pruneSceneStates(state.sceneStates);
  const sceneStateLines = activeSceneStates.length
    ? activeSceneStates.map(s => `- ${s.key}：${s.value}（${formatSceneAge(s.updatedAt)}）`).join('\n')
    : '';
  const boardSnapshot = summarizeWidgetBoardForContext(state.widgets, state.widgetStates);
  const memList = selectRelevantMemories();
  const memLines = memList.length
    ? memList.map(m => `- ${m.pinned ? '[核心]' : ''}${m.key}：${m.value}`).join('\n')
    : '';
  const widgetSummary = needWidget ? state.widgets.map(w => `「${w.title}」`).join('、') : '';
  const specialCue = getSpecialDateCue();
  const curMood = (state.mood && state.mood !== '正在传照片…') ? state.mood : '';
  const affLine = `当前情绪与亲密度：${curMood ? `心情「${curMood}」，` : ''}亲密度 ${typeof state.affection === 'number' ? state.affection : 68}/100`;
  const lines = [
    `[后台实时情景与一致性校准]`,
    `当前时间：${timeNote}`,
    affLine
  ];
  if (specialCue) lines.push(specialCue);
  if (sceneStateLines) {
    lines.push(`【当前实时场景状态（绝对为准，直接覆盖更早历史里任何相反的旧状态）】\n${sceneStateLines}`);
  }
  if (boardSnapshot) {
    lines.push(`【「${charName}的家」实时生活看板（自然知晓即可，聊到相关话题或关心对方时可顺口提起，别生硬播报）】\n${boardSnapshot}`);
  }
  if (widgetSummary) lines.push(`「${charName}的家」已有组件：${widgetSummary}`);
  if (memLines) lines.push(`命中长期记忆：\n${memLines}`);
  if (state.memorySummary) lines.push(`前情印象：\n${state.memorySummary.slice(0, 500)}`);
  if (runtime.personaShiftPending) {
    lines.push(isStory
      ? '即时提醒：刚刚开启了小剧场或更新了人设，从本条起立刻按最新设定入戏。'
      : '即时提醒：小剧场已关闭或设定刚更新，从本条起严禁任何星号或括号神态旁白，只发纯口语短句！');
  } else if (!isStory) {
    const scanPool = Array.isArray(windowMsgs) && windowMsgs.length
      ? windowMsgs.filter(m => m && m.role === 'assistant' && typeof m.content === 'string').map(m => m.content)
      : state.messages.filter(m => m && m.role === 'assistant' && m.text).map(m => m.text);
    const hasLegacyStageHistory = scanPool.some(txt =>
      /(?<!\*)\*(?!\*)[^*\n]{1,120}(?<!\*)\*(?!\*)/.test(txt) ||
      /^\s*[（(][^（）()\n]{1,80}[)）]\s*$/m.test(txt)
    );
    if (hasLegacyStageHistory) {
      lines.push('格式纠偏：上方发送历史里存在旧的旁白/动作习惯，当前是日常纯文字聊天模式，从本条回复起请彻底切回纯说话口语，绝不延续历史里的括号或星号旁白。');
    }
  }
  const recentAsstAll = state.messages
    .filter(m => m && m.role === 'assistant' && m.text && !m.isStarter && !m.isError)
    .slice(-5)
    .map(m => String(m.text).trim());
  const recentAsstMsgs = recentAsstAll.slice(-2);
  if (recentAsstMsgs.length === 2 && recentAsstMsgs.every(t => /[?？]\s*$/.test(t))) {
    lines.push('节奏提醒：你已连续两轮以问句结尾，本轮直接自然接话即可，不要再抛反问句收尾。');
  }
  const repHits = detectRepetitivePhrases(recentAsstAll);
  if (repHits.length) {
    lines.push(`避重提醒：最近几轮回复已多次出现「${repHits.join('、')}」，本轮请换个自然表达，不要重复这些用词或开头。`);
  }
  // Dynamic length pacing following user's latest message length (strictly persona-neutral)
  let lastUserTxt = '';
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (!m || m.imgPending || m.isError) continue;
    if (m.role === 'assistant') break;
    if (m.role === 'user' && m.text && !m.image) {
      lastUserTxt = String(m.text).trim();
      break;
    }
  }
  if (lastUserTxt && !needWidget) {
    if (lastUserTxt.length <= 5 && !/[?？]/.test(lastUserTxt)) {
      lines.push('篇幅节奏：对方刚只发了极短的话，本轮随口回一句短话即可，不必硬展开长篇。');
    } else if (lastUserTxt.length >= 80) {
      lines.push('篇幅节奏：对方刚发了一大段话，可以顺着对方的细节多回应两句，别太敷衍。');
    }
  }
  const rawSampleFirst = (state.settings.sampleDialogue || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .find(Boolean) || '';
  const sampleAnchor = rawSampleFirst
    ? (isStory ? rawSampleFirst : stripStageDirections(rawSampleFirst, false)).slice(0, 80)
    : '';
  const anchorSuffix = [
    anchors ? `铁规：${anchors.slice(0, 110)}` : '',
    sampleAnchor ? `口吻示范：${sampleAnchor}` : ''
  ].filter(Boolean).join('；');
  lines.push(
    `一致性与口吻校准：先严格核对上方【当前实时场景状态】及当前心情/亲密度（新状态覆盖旧说法），若发生改变请附 <STATE> 更新；再以「${charName}」本人语气接下方这句${anchorSuffix ? `（${anchorSuffix}）` : ''}；${isStory ? '保持小剧场入戏感' : '只发纯文字口语短句，严禁星号与括号旁白、严禁客服说教'}。`
  );
  return lines.join('\n');
}
