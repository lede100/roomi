import { runtime, flushActiveCharToList, scheduleSave, showWarn, isModelMarkedNoThinking, markModelFieldUnsupported } from './state.js';
import { todayKey, escapeHtml, fetchWithTimeout } from './utils.js';
import { BOARD_PRESET_WIDGETS, buildDailyMoodNotePool } from './presets.js';
import { buildWidgetSrcdoc, summarizeWidgetBoardForContext } from './widget-context.js';
import { getLocalTimeContext, stripThinkingTags } from './prompt.js';
import { ui, registerUI } from './ui-bridge.js';

const widgetEmitTimestamps = new Map();

export function syncDailyNoteCard() {
  const state = runtime.state;
  const titleEl = document.getElementById('dailyNoteTitle');
  const bodyEl = document.getElementById('dailyNoteBody');
  if (!titleEl || !bodyEl) return;
  const name = state.settings.name || '伴侣';
  const today = todayKey();
  titleEl.textContent = `📌 ${name} 的今日便利贴`;
  if (!state.dailyNote || state.dailyNote.date !== today || !state.dailyNote.text) {
    const pool = buildDailyMoodNotePool(name);
    state.dailyNote = {
      date: today,
      text: pool[new Date().getDate() % pool.length]
    };
    flushActiveCharToList();
    scheduleSave();
  }
  bodyEl.textContent = state.dailyNote.text;
}

export function renderWidgets(forceReloadIds = null) {
  const state = runtime.state;
  const widgetList = document.getElementById('widgetList');
  const widgetCount = document.getElementById('widgetCount');
  syncDailyNoteCard();
  widgetCount.textContent = String(state.widgets.length);
  const subCountEl = document.getElementById('boardWidgetSubCount');
  if (subCountEl) subCountEl.textContent = state.widgets.length ? String(state.widgets.length) : '';

  if (!state.widgets.length) {
    runtime.iframeRegistry.clear();
    const homeName = `${state.settings.name || '伴侣'}的家`;
    widgetList.innerHTML = `
      <div class="empty-board">
        <div style="font-size:26px;margin-bottom:8px;">🏠</div>
        <div style="font-size:14px;color:var(--text);font-weight:600;margin-bottom:4px;">${escapeHtml(homeName)}里还是空的</div>
        <div style="font-size:12px;">点上方快捷模板一键布置，或去聊天里说一句「帮我做个早睡打卡卡」</div>
      </div>`;
    return;
  }

  const themeKey = state.settings.theme || 'claude';
  const existingCards = new Map();
  widgetList.querySelectorAll('.widget-card[data-widget-card]').forEach(el => {
    existingCards.set(el.dataset.widgetCard, el);
  });
  const emptyEl = widgetList.querySelector('.empty-board');
  if (emptyEl) emptyEl.remove();

  const activeIds = new Set(state.widgets.map(w => w.id));
  for (const [oldId, el] of existingCards.entries()) {
    if (!activeIds.has(oldId)) {
      el.remove();
      runtime.iframeRegistry.delete(oldId);
      existingCards.delete(oldId);
    }
  }

  const forceSet = forceReloadIds instanceof Set ? forceReloadIds : new Set();

  state.widgets.forEach((w, idx) => {
    const sig = `${runtime.state.activeCharId || ''}::${runtime.widgetRenderEpoch || 0}::${themeKey}::${w.title}::${String(w.html || '').length}::${String(w.html || '').slice(0, 64)}::${String(w.html || '').slice(-64)}`;
    let card = existingCards.get(w.id);
    const needRebuild = !card || card.dataset.widgetSig !== sig || forceSet.has(w.id);

    if (needRebuild) {
      if (card) card.remove();
      card = document.createElement('div');
      card.className = 'widget-card';
      card.dataset.widgetCard = w.id;
      card.dataset.widgetSig = sig;
      card.innerHTML = `
        <div class="widget-head">
          <div class="widget-title-wrap">
            <span class="widget-dot"></span>
            <span class="widget-title">${escapeHtml(w.title)}</span>
          </div>
          <div class="widget-actions">
            <button class="mini-btn" data-act="up" title="上移" style="display:${idx > 0 ? 'inline-block' : 'none'}">↑</button>
            <button class="mini-btn" data-act="code" title="查看源码">&lt;/&gt;</button>
            <button class="mini-btn" data-act="reload" title="刷新">↻</button>
            <button class="mini-btn danger" data-act="del" title="移除">✕</button>
          </div>
        </div>`;

      const iframe = document.createElement('iframe');
      iframe.className = 'widget-frame';
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.style.height = (w.height || 200) + 'px';
      iframe.srcdoc = buildWidgetSrcdoc(w, state.widgetStates, themeKey);
      card.appendChild(iframe);
      runtime.iframeRegistry.set(w.id, iframe);

      card.querySelector('[data-act="up"]').onclick = () => {
        const st = runtime.state;
        const curIdx = st.widgets.findIndex(item => item.id === w.id);
        if (curIdx > 0) {
          const [item] = st.widgets.splice(curIdx, 1);
          st.widgets.splice(curIdx - 1, 0, item);
          scheduleSave();
          renderWidgets();
        }
      };
      card.querySelector('[data-act="code"]').onclick = () => ui.openCodeModal?.(w);
      card.querySelector('[data-act="reload"]').onclick = () => {
        const st = runtime.state;
        card.querySelector('.widget-err-bar')?.remove();
        iframe.srcdoc = buildWidgetSrcdoc(w, st.widgetStates, st.settings.theme || 'claude');
      };
      card.querySelector('[data-act="del"]').onclick = () => {
        const st = runtime.state;
        st.widgets = st.widgets.filter(item => item.id !== w.id);
        delete st.widgetStates[w.id];
        scheduleSave();
        renderWidgets();
      };
    } else {
      const upBtn = card.querySelector('[data-act="up"]');
      if (upBtn) upBtn.style.display = idx > 0 ? 'inline-block' : 'none';
    }

    const currentAtPos = widgetList.children[idx];
    if (currentAtPos !== card) {
      widgetList.insertBefore(card, currentAtPos || null);
    }
  });
}

export function enqueueWidgetEvent(eventText) {
  runtime.pendingEventQueue.push(eventText);
  clearTimeout(runtime.eventFlushTimer);
  runtime.eventFlushTimer = setTimeout(flushWidgetEvents, 550);
}

export function flushWidgetEvents() {
  if (runtime.isBusy || !runtime.pendingEventQueue.length) return;
  const batch = runtime.pendingEventQueue.splice(0, runtime.pendingEventQueue.length);
  const summary = batch.length === 1
    ? batch[0]
    : batch.map((t, i) => `${i + 1}. ${t}`).join('；');
  ui.triggerCompanionReply?.(
    `[系统通知：用户刚刚在你们的看板组件里互动了——${summary}。请用自然亲密的伴侣口吻简短回应，不要重复创建组件。]`,
    true
  );
}


export function applyBoardOperations(boardOps) {
  if (!Array.isArray(boardOps) || !boardOps.length) return false;
  const state = runtime.state;
  let changed = false;
  const modifiedWidgetIds = new Set();

  const findTodoWidget = () => state.widgets.find(item => {
    if (!item) return false;
    if (item.title === BOARD_PRESET_WIDGETS.todo.title) return true;
    return /清单|todo/i.test(item.title || '') && Array.isArray(state.widgetStates[item.id]?.items);
  });

  const ensureTodoWidget = () => {
    let w = findTodoWidget();
    if (!w) {
      const tpl = BOARD_PRESET_WIDGETS.todo;
      w = {
        id: 'w_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        title: tpl.title,
        height: tpl.height,
        createdAt: Date.now(),
        html: tpl.html
      };
      state.widgets.unshift(w);
    }
    if (!state.widgetStates[w.id] || !Array.isArray(state.widgetStates[w.id].items)) {
      state.widgetStates[w.id] = {
        items: [
          { t: '一起看场电影', d: false },
          { t: '今晚按时睡觉', d: false }
        ]
      };
    }
    return { w, items: state.widgetStates[w.id].items };
  };

  for (const opObj of boardOps) {
    if (!opObj || !opObj.op || !opObj.text) continue;
    if (opObj.op === 'todo_add') {
      const { w, items } = ensureTodoWidget();
      const clean = opObj.text.trim().slice(0, 48);
      if (clean && !items.some(it => it && String(it.t || '').trim() === clean)) {
        items.unshift({ t: clean, d: false });
        if (items.length > 40) items.length = 40;
        modifiedWidgetIds.add(w.id);
        changed = true;
      }
    } else if (opObj.op === 'todo_done') {
      const w = findTodoWidget();
      const items = w ? state.widgetStates[w.id]?.items : null;
      if (Array.isArray(items)) {
        const kw = opObj.text.trim().toLowerCase();
        const hit = items.find(it => it && !it.d && String(it.t || '').toLowerCase().includes(kw));
        if (hit) {
          hit.d = true;
          modifiedWidgetIds.add(w.id);
          changed = true;
        }
      }
    } else if (opObj.op === 'note') {
      const cleanNote = opObj.text.trim().slice(0, 80);
      if (cleanNote) {
        state.dailyNote = { date: todayKey(), text: cleanNote };
        changed = true;
      }
    }
  }

  if (changed) {
    flushActiveCharToList();
    renderWidgets(modifiedWidgetIds);
    scheduleSave();
  }
  return changed;
}

export function initWidgetBoard() {
  registerUI({ syncDailyNoteCard, renderWidgets, enqueueWidgetEvent, flushWidgetEvents, applyBoardOperations });

  window.addEventListener('message', e => {
    const data = e.data;
    if (!data || typeof data !== 'object' || !data.widgetId) return;
    const registeredIframe = runtime.iframeRegistry.get(data.widgetId);
    if (!registeredIframe || e.source !== registeredIframe.contentWindow) return;
    const state = runtime.state;

    if (data.type === 'loom:resize' && typeof data.height === 'number') {
      registeredIframe.style.height = Math.max(110, Math.min(680, data.height)) + 'px';
    } else if (data.type === 'loom:saveState') {
      try {
        const serialized = JSON.stringify(data.state ?? {});
        if (serialized.length > 65536) {
          showWarn('小组件保存的数据太大，已跳过保存');
          return;
        }
        state.widgetStates[data.widgetId] = JSON.parse(serialized);
        scheduleSave();
      } catch {}
    } else if (data.type === 'loom:emit' && data.message) {
      const now = Date.now();
      const stamps = (widgetEmitTimestamps.get(data.widgetId) || []).filter(ts => now - ts < 10000);
      if (stamps.length >= 5) return;
      stamps.push(now);
      widgetEmitTimestamps.set(data.widgetId, stamps);
      const eventText = `在「${data.title}」中：${String(data.message).slice(0, 200)}`;
      ui.appendChatMessage?.({ role: 'event', text: eventText });
      scheduleSave();

      if (state.settings.autoReact) {
        enqueueWidgetEvent(eventText);
      }
    } else if (data.type === 'loom:error' && data.message) {
      const card = document.querySelector(`[data-widget-card="${data.widgetId}"]`);
      const targetWidget = state.widgets.find(w => w.id === data.widgetId);
      if (card && targetWidget && !card.querySelector('.widget-err-bar')) {
        const bar = document.createElement('div');
        bar.className = 'widget-err-bar';
        bar.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">⚠ 运行出错：${escapeHtml(data.message)}</span><button type="button" class="widget-err-fix">让 TA 修好</button>`;
        bar.querySelector('.widget-err-fix').onclick = () => {
          if (runtime.isBusy) return;
          ui.switchPage?.(0);
          ui.handleSend?.(`小组件「${targetWidget.title}」运行报错了（${data.message}），请直接输出修复后的完整 <WIDGET title="${targetWidget.title}" replace="${targetWidget.title}"> 代码帮我修好。`);
        };
        card.appendChild(bar);
      }
    }
  });

  document.getElementById('boardTplBar')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-board-tpl]');
    if (!btn) return;
    const tpl = BOARD_PRESET_WIDGETS[btn.dataset.boardTpl];
    if (!tpl) return;
    const state = runtime.state;
    const existing = state.widgets.find(w => w.title === tpl.title);
    if (existing) {
      showWarn(`${state.settings.name || '家里'}已经有「${tpl.title}」啦`, true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1800);
      return;
    }
    state.widgets.unshift({
      id: 'w_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      title: tpl.title,
      height: tpl.height,
      createdAt: Date.now(),
      html: tpl.html
    });
    renderWidgets();
    scheduleSave();
    showWarn(`✓ 已挂载「${tpl.title}」`, true);
    setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1800);
  });

  const askNewWidgetBtn = document.getElementById('askNewWidgetBtn');
  if (askNewWidgetBtn) {
    askNewWidgetBtn.onclick = () => {
      ui.switchPage?.(0);
      const chatInput = document.getElementById('chatInput');
      if (chatInput) {
        chatInput.value = '帮我现做一个';
        chatInput.focus();
      }
    };
  }

  // Enhanced AI Daily Mood Note: now aware of live widget board states!
  const refreshDailyNoteBtn = document.getElementById('refreshDailyNoteBtn');
  if (refreshDailyNoteBtn) {
    refreshDailyNoteBtn.onclick = async () => {
      const targetCharId = runtime.state.activeCharId;
      const snapshotState = runtime.state;
      const name = snapshotState.settings.name || '伴侣';
      const key = (snapshotState.settings.apiKey || '').trim();
      const base = (snapshotState.settings.baseUrl || '').trim().replace(/\/+$/, '');
      const model = (snapshotState.settings.model || '').trim();
      const applyDailyNoteToTarget = (txt) => {
        const noteObj = { date: todayKey(), text: txt };
        const destChar = runtime.state.characters.find(c => c.id === targetCharId);
        if (destChar) destChar.dailyNote = noteObj;
        if (runtime.state.activeCharId === targetCharId) {
          runtime.state.dailyNote = noteObj;
          flushActiveCharToList();
          syncDailyNoteCard();
        }
        scheduleSave();
      };
      if (key && base && model) {
        refreshDailyNoteBtn.disabled = true;
        refreshDailyNoteBtn.textContent = '写着呢…';
        try {
          const boardSnap = summarizeWidgetBoardForContext(snapshotState.widgets, snapshotState.widgetStates);
          const boardCue = boardSnap ? `\n你们家看板当前状态：\n${boardSnap}\n（若刚好有值得顺口关心或夸夸的点，可自然带一笔，没有就随便写日常想念。）` : '';
          const ask = `你是用户的伴侣「${name}」，设定：${(snapshotState.settings.persona || '').slice(0, 140)}。现在是 ${getLocalTimeContext()}。${boardCue}请写一句贴在家中看板上的今日心情便利贴（15~34字，真实口语感，不要标签不要动作描写）。`;
          const bodyObj = { model, temperature: 0.9, stream: false, messages: [{ role: 'user', content: ask }] };
          if (!isModelMarkedNoThinking(model, base)) bodyObj.thinking = { type: 'disabled' };
          const postNote = (b) => fetchWithTimeout(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify(b)
          }, 25000);
          let res = await postNote(bodyObj);
          if (!res.ok && (res.status === 400 || res.status === 422) && bodyObj.thinking) {
            const errTxt = await res.text().catch(() => '');
            if (/(thinking|unknown[_ ]field|extra[_ ]inputs|unrecognized[_ ]request|unsupported[_ ]param|additional[_ ]properties|not[_ ]allowed)/i.test(errTxt)) {
              delete bodyObj.thinking;
              res = await postNote(bodyObj);
              if (res.ok) markModelFieldUnsupported('nonThinkingModels', model, base);
            }
          }
          if (res.ok) {
            const json = await res.json();
            const txt = stripThinkingTags(json.choices?.[0]?.message?.content || '').trim().replace(/^["「]|["」]$/g, '').slice(0, 80);
            if (txt) {
              applyDailyNoteToTarget(txt);
              return;
            }
          }
        } catch {} finally {
          refreshDailyNoteBtn.disabled = false;
          refreshDailyNoteBtn.textContent = '↻ 换一句';
        }
      }
      const destChar = runtime.state.characters.find(c => c.id === targetCharId);
      const pool = buildDailyMoodNotePool(name);
      const cur = (destChar?.dailyNote?.text) || (runtime.state.activeCharId === targetCharId ? runtime.state.dailyNote?.text : '') || '';
      const next = pool.find(p => p !== cur) || pool[0];
      applyDailyNoteToTarget(next);
    };
  }

  const chatDailyNoteBtn = document.getElementById('chatDailyNoteBtn');
  if (chatDailyNoteBtn) {
    chatDailyNoteBtn.onclick = () => {
      const note = runtime.state.dailyNote?.text || '';
      ui.switchPage?.(0);
      const chatInput = document.getElementById('chatInput');
      if (note && chatInput) {
        chatInput.value = `看到你便利贴写的「${note.slice(0, 28)}」，`;
        chatInput.focus();
      }
    };
  }
}
