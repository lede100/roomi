import { todayKey } from './utils.js';

export function sanitizeWidgetHtml(rawHtml) {
  return String(rawHtml || '')
    .replace(/<\/body\s*>/gi, '<!-- /body -->')
    .replace(/<\/html\s*>/gi, '<!-- /html -->');
}

export function buildWidgetSrcdoc(widget, widgetStates, themeKey = 'claude') {
  const initialStateJson = JSON.stringify((widgetStates && widgetStates[widget.id]) || {}).replace(/</g, '\\u003c');
  const safeId = JSON.stringify(widget.id).replace(/</g, '\\u003c');
  const safeTitle = JSON.stringify(widget.title).replace(/</g, '\\u003c');
  const bodyHtml = sanitizeWidgetHtml(widget.html);
  const isDarkGlass = themeKey === 'glass-dark';
  const isLightGlass = themeKey === 'glass-light';
  const isClaude = themeKey === 'claude';
  const wAccent = isDarkGlass ? '#7aa7ff' : (isLightGlass ? '#3b7df6' : (isClaude ? '#d97757' : '#5b8def'));
  const wSoft = isDarkGlass ? 'rgba(122,167,255,0.16)' : (isLightGlass ? 'rgba(59,125,246,0.13)' : (isClaude ? '#fdf2ee' : '#eef4fd'));
  const wMuted = isDarkGlass ? 'rgba(255,255,255,0.08)' : (isClaude ? '#f3f1ea' : '#f5f8fc');
  const wBorder = isDarkGlass ? 'rgba(255,255,255,0.14)' : (isClaude ? '#e5e0d4' : '#e4ebf5');
  const wBg = (isDarkGlass || isLightGlass) ? 'transparent' : '#ffffff';
  const wText = isDarkGlass ? '#eef2ff' : '#111827';
  const wSub = isDarkGlass ? '#94a3b8' : '#64748b';
  const wInputBg = isDarkGlass ? 'rgba(255,255,255,0.08)' : '#ffffff';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:;" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { --w-accent: ${wAccent}; --w-soft: ${wSoft}; --w-muted: ${wMuted}; --w-border: ${wBorder}; --w-sub: ${wSub}; --w-bg: ${wBg}; --w-text: ${wText}; }
  html, body { margin: 0; padding: 0; background: ${wBg}; color: ${wText}; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; overflow-x: hidden; }
  input, textarea, select { background: ${wInputBg}; color: ${wText}; }
  * { box-sizing: border-box; }
</style>
${isDarkGlass ? `<style>body { background: transparent !important; color: ${wText}; }</style>` : ''}
<script>
  window.__WIDGET_ID__ = ${safeId};
  window.__WIDGET_TITLE__ = ${safeTitle};
  window.__INITIAL_STATE__ = ${initialStateJson};
  function __clone(obj) {
    try { return JSON.parse(JSON.stringify(obj || {})); } catch { return {}; }
  }
  window.CompanionBridge = {
    getState() { return __clone(window.__INITIAL_STATE__); },
    saveState(nextState) {
      const copy = __clone(nextState);
      window.__INITIAL_STATE__ = copy;
      parent.postMessage({ type: 'loom:saveState', widgetId: window.__WIDGET_ID__, state: copy }, '*');
    },
    emit(message, extra) {
      parent.postMessage({ type: 'loom:emit', widgetId: window.__WIDGET_ID__, title: window.__WIDGET_TITLE__, message: String(message || ''), extra: extra || null }, '*');
    }
  };
  function __reportHeight() {
    const h = Math.max(document.body ? document.body.scrollHeight : 160, 110);
    parent.postMessage({ type: 'loom:resize', widgetId: window.__WIDGET_ID__, height: Math.min(h + 6, 520) }, '*');
  }
  window.addEventListener('error', ev => {
    parent.postMessage({ type: 'loom:error', widgetId: window.__WIDGET_ID__, message: String(ev.message || '脚本异常').slice(0, 120) }, '*');
  });
  window.addEventListener('unhandledrejection', ev => {
    parent.postMessage({ type: 'loom:error', widgetId: window.__WIDGET_ID__, message: String(ev.reason?.message || ev.reason || '异步错误').slice(0, 120) }, '*');
  });
  window.addEventListener('load', () => {
    __reportHeight();
    if (window.ResizeObserver && document.body) {
      new ResizeObserver(__reportHeight).observe(document.body);
    }
  });
<` + `/script>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/**
 * Summarizes live states from all active widgets on the companion board ("TA的家")
 * into a compact, token-efficient snapshot so the companion naturally knows ongoing
 * streaks, hydration, todos, savings, mood jar, period calendar, and custom widgets.
 */
export function summarizeWidgetBoardForContext(widgets, widgetStates, todayStr = todayKey()) {
  if (!Array.isArray(widgets) || !widgets.length) return '';
  const stMap = (widgetStates && typeof widgetStates === 'object') ? widgetStates : {};
  const lines = [];
  const now = Date.now();

  for (const w of widgets.slice(0, 8)) {
    if (!w || !w.id) continue;
    const title = String(w.title || '小组件').trim();
    const st = stMap[w.id];
    if (!st || typeof st !== 'object' || !Object.keys(st).length) continue;

    // 1. Starter check-in (hydration & hugs)
    if (typeof st.cups === 'number' || typeof st.hugs === 'number') {
      const isToday = !st.date || st.date === todayStr;
      const cups = isToday ? (Number(st.cups) || 0) : 0;
      const hugs = isToday ? (Number(st.hugs) || 0) : 0;
      if (cups > 0 || hugs > 0) {
        const parts = [];
        if (cups > 0) parts.push(`今日喝水 ${cups}/6 杯`);
        if (hugs > 0) parts.push(`今日贴贴 ${hugs} 次`);
        lines.push(`- ${title}：${parts.join('，')}`);
      }
      continue;
    }

    // 2. Early sleep streak widget
    if (typeof st.streak === 'number' && ('lastDoneDate' in st || 'weekDone' in st)) {
      const doneToday = st.lastDoneDate === todayStr;
      lines.push(`- ${title}：累计早睡 ${st.streak} 天，今日${doneToday ? '已打卡' : '尚未打卡'}`);
      continue;
    }

    // 3. Period / body calendar widget
    if (st.lastStart || Array.isArray(st.logs)) {
      const parts = [];
      if (st.lastStart) {
        const diffDays = Math.max(1, Math.floor((now - Number(st.lastStart)) / 86400000) + 1);
        if (diffDays <= 45) parts.push(`距上次记录开始第 ${diffDays} 天`);
      }
      if (Array.isArray(st.logs) && st.logs.length) {
        const recentPain = [...st.logs].reverse().find(l => l && l.type === 'pain' && (now - Number(l.at || 0) <= 36 * 3600 * 1000));
        if (recentPain) parts.push('近36小时内记录过身体不舒服');
      }
      if (parts.length) lines.push(`- ${title}：${parts.join('，')}`);
      continue;
    }

    // 4. Shared todo list
    if (Array.isArray(st.items)) {
      const pending = st.items.filter(it => it && !it.d && it.t).map(it => String(it.t).slice(0, 18));
      const doneCount = st.items.filter(it => it && it.d).length;
      if (pending.length || doneCount) {
        const preview = pending.length ? `待做(${pending.length})：${pending.slice(0, 3).join('、')}` : '全部已完成';
        lines.push(`- ${title}：${preview}${doneCount ? `（已完成 ${doneCount} 项）` : ''}`);
      }
      continue;
    }

    // 5. Savings goal
    if (typeof st.saved === 'number') {
      const goal = Number(st.goal) || 5200;
      const pct = Math.min(100, Math.round((st.saved / goal) * 100));
      lines.push(`- ${title}：已存 ¥${st.saved} / ¥${goal}（${pct}%）`);
      continue;
    }

    // 6. Mood glass jar
    if (Array.isArray(st.balls) && st.balls.length) {
      const recent = st.balls.slice(-2).map(b => `${b.t || b.e || '心情'}${b.at ? `(${b.at})` : ''}`).join('、');
      lines.push(`- ${title}：共 ${st.balls.length} 颗，最近：${recent}`);
      continue;
    }

    // 7. Travel countdown
    if (typeof st.target === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(st.target)) {
      const diff = new Date(st.target + 'T08:00:00').getTime() - now;
      const daysLeft = Math.ceil(diff / 86400000);
      lines.push(`- ${title}：目标 ${st.target}（${daysLeft > 0 ? `还剩 ${daysLeft} 天` : '已到出发日'}）`);
      continue;
    }

    // 8. Food wheel
    if (typeof st.lastFood === 'string' && st.lastFood.trim()) {
      lines.push(`- ${title}：上次抽中「${st.lastFood.trim().slice(0, 20)}」`);
      continue;
    }

    // 9. Generic fallback for any custom AI-generated widget
    const kvParts = [];
    for (const [k, v] of Object.entries(st)) {
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number' || typeof v === 'boolean') {
        kvParts.push(`${k}=${v}`);
      } else if (typeof v === 'string') {
        kvParts.push(`${k}=${v.slice(0, 20)}`);
      } else if (Array.isArray(v)) {
        kvParts.push(`${k}=${v.length}项`);
      }
      if (kvParts.length >= 3) break;
    }
    if (kvParts.length) {
      lines.push(`- ${title}：${kvParts.join('，').slice(0, 64)}`);
    }
  }

  const joined = lines.join('\n');
  return joined.length > 380 ? joined.slice(0, 377) + '…' : joined;
}
