import { STORE_KEY, StorageAdapter } from './storage.js';
import { runtime, normalizeState, scheduleSave, flushSaveNow, showWarn } from './state.js';
import { openExternalUrl, parseHourMin } from './utils.js';
import { getSpecialDateCue } from './memory.js';
import { getLocalTimeContext, parseAssistantOutput } from './prompt.js';
import { callLiveLLMWithRetry } from './llm.js';
import { summarizeWidgetBoardForContext } from './widget-context.js';
import { resumePendingImageTasks } from './image-gen.js';
import { ui, registerUI } from './ui-bridge.js';
import { initChatUI } from './ui-chat.js';
import { initWidgetBoard } from './ui-widgets.js';
import { initSettingsUI } from './ui-settings.js';

const track = document.getElementById('track');
const viewport = document.getElementById('viewport');
const tabBar = document.getElementById('tabBar');
const boardScroll = document.getElementById('boardScroll');
const boardDot = document.getElementById('boardDot');

// ---- Close Warn Toast & External Links ----
document.getElementById('closeWarnBtn').onclick = () => {
  document.getElementById('warnToast').classList.remove('show');
};
document.querySelectorAll('[data-ext-url]').forEach(btn => {
  btn.addEventListener('click', () => openExternalUrl(btn.dataset.extUrl));
});

// ---- VisualViewport Resize Fix ----
function syncViewportHeight() {
  if (window.innerWidth >= 520) return;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', vh + 'px');
  const chatScroll = document.getElementById('chatScroll');
  if (!chatScroll || (chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140)) {
    ui.scrollChatBottom?.();
  }
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
}
window.addEventListener('resize', syncViewportHeight);

// ---- Page Switching + Follow-finger Swipe ----
function applyTrackOffset(page, dragDeltaPx = 0) {
  if (dragDeltaPx === 0) {
    track.style.transform = page === 1 ? 'translateX(-50%)' : 'translateX(0)';
    return;
  }
  const paneWidth = viewport.clientWidth || 1;
  const basePx = -page * paneWidth;
  const clamped = Math.max(-paneWidth, Math.min(0, basePx + dragDeltaPx));
  track.style.transform = `translateX(${clamped}px)`;
}

function switchPage(page, highlightWidgetId) {
  runtime.currentPage = page;
  if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
  track.classList.remove('dragging');
  applyTrackOffset(page, 0);
  tabBar.setAttribute('data-active', String(page));
  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.tab) === page);
  });
  if (page === 1) {
    boardDot.classList.remove('show');
    if (highlightWidgetId) {
      const card = document.querySelector(`[data-widget-card="${highlightWidgetId}"]`);
      if (card) {
        const targetTop = Math.max(0, card.getBoundingClientRect().top - boardScroll.getBoundingClientRect().top + boardScroll.scrollTop - 14);
        boardScroll.scrollTo({ top: targetTop, behavior: 'smooth' });
        card.classList.add('highlight');
        setTimeout(() => card.classList.remove('highlight'), 1800);
      }
    }
  }
}

viewport.addEventListener('scroll', () => {
  if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
});

tabBar.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchPage(Number(btn.dataset.tab)));
});

let touchStartX = 0, touchStartY = 0, isHorizDragging = false, skipSwipe = false;
viewport.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) return;
  if (e.target.closest('.quick-bar, textarea, input, button')) {
    skipSwipe = true;
    return;
  }
  skipSwipe = false;
  isHorizDragging = false;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

viewport.addEventListener('touchmove', e => {
  if (skipSwipe || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - touchStartX;
  const dy = e.touches[0].clientY - touchStartY;
  if (!isHorizDragging) {
    if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      isHorizDragging = true;
      track.classList.add('dragging');
    } else if (Math.abs(dy) > 14) {
      skipSwipe = true;
      return;
    }
  }
  if (isHorizDragging) applyTrackOffset(runtime.currentPage, dx);
}, { passive: true });

viewport.addEventListener('touchend', e => {
  if (skipSwipe || !isHorizDragging || !e.changedTouches.length) {
    track.classList.remove('dragging');
    return;
  }
  const dx = e.changedTouches[0].clientX - touchStartX;
  const threshold = Math.min(72, (viewport.clientWidth || 360) * 0.22);
  if (dx < -threshold && runtime.currentPage === 0) switchPage(1);
  else if (dx > threshold && runtime.currentPage === 1) switchPage(0);
  else switchPage(runtime.currentPage);
  isHorizDragging = false;
}, { passive: true });

// ---- Privacy PIN Lock, Daily Notifications & Proactive Opening Greeting ----
const privacyCurtain = document.getElementById('privacyCurtain');
const privacyLockOverlay = document.getElementById('privacyLockOverlay');
const pinLockHint = document.getElementById('pinLockHint');
const pinForgotBtn = document.getElementById('pinForgotBtn');
let pinBuffer = '';
let pinMode = 'unlock';
let lastHiddenAt = 0;

function renderPinDots() {
  document.querySelectorAll('#pinDots .pin-dot').forEach((d, idx) => {
    d.classList.toggle('filled', idx < pinBuffer.length);
  });
}

function openPinLock(mode = 'unlock', hint = '') {
  pinMode = mode;
  pinBuffer = '';
  renderPinDots();
  document.querySelector('#privacyLockOverlay .pin-title').textContent = mode === 'set' ? '设置 4 位隐私密码' : '输入隐私密码';
  pinLockHint.textContent = hint || (mode === 'set' ? '设置后每次冷启动或离开超过45秒需要解锁' : '请输入 4 位数字密码进入 Roomi');
  pinForgotBtn.textContent = mode === 'set' ? '取消' : '清空重置';
  privacyLockOverlay.classList.add('show');
}

document.getElementById('setPrivacyPinBtn').onclick = () => {
  openPinLock('set');
};

document.querySelectorAll('#pinPad [data-digit]').forEach(btn => {
  btn.onclick = () => {
    if (pinBuffer.length >= 4) return;
    pinBuffer += btn.dataset.digit;
    renderPinDots();
    if (pinBuffer.length < 4) return;
    if (pinMode === 'set') {
      ui.setDraftPrivacyPin?.(pinBuffer);
      document.getElementById('cfgPrivacyLock').checked = true;
      privacyLockOverlay.classList.remove('show');
      showWarn('✓ 密码已暂存，点底部「保存并应用」即生效', true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2200);
      return;
    }
    if (pinBuffer === runtime.state.settings.privacyPin) {
      privacyLockOverlay.classList.remove('show');
      maybeTriggerProactiveGreeting();
    } else {
      pinLockHint.textContent = '密码不对，再试一次';
      setTimeout(() => { pinBuffer = ''; renderPinDots(); }, 220);
    }
  };
});

document.getElementById('pinDelBtn').onclick = () => {
  pinBuffer = pinBuffer.slice(0, -1);
  renderPinDots();
};

pinForgotBtn.onclick = async () => {
  if (pinMode === 'set') {
    privacyLockOverlay.classList.remove('show');
    return;
  }
  if (!confirm('忘记密码只能清空所有本地聊天与设置重新开始，确定清空吗？')) return;
  await StorageAdapter.remove(STORE_KEY);
  location.reload();
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void flushSaveNow();
  }
  if (!runtime.state.settings.privacyLock || !runtime.state.settings.privacyPin) return;
  if (document.visibilityState === 'hidden') {
    lastHiddenAt = Date.now();
    privacyCurtain.classList.add('show');
  } else {
    privacyCurtain.classList.remove('show');
    if (lastHiddenAt && Date.now() - lastHiddenAt > 45000) {
      openPinLock('unlock');
    }
  }
});
window.addEventListener('pagehide', () => {
  void flushSaveNow();
});

async function syncDailyNotifications(enabled) {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN) return;
  try {
    await LN.cancel({ notifications: [{ id: 1001 }, { id: 1002 }] }).catch(() => {});
    if (!enabled) return;
    let perm = await LN.checkPermissions();
    if (perm?.display !== 'granted') perm = await LN.requestPermissions();
    if (perm?.display !== 'granted') {
      showWarn('未获得手机通知权限，可在系统设置里为 Roomi 开启通知', true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2600);
      return;
    }
    const state = runtime.state;
    const name = state.settings.name || '林澈';
    const morningTime = parseHourMin(state.settings.notifyMorning, 8, 30);
    const nightTime = parseHourMin(state.settings.notifyNight, 23, 30);
    const daySeed = new Date().getDate();
    const mLines = [
      `醒了没呀？早饭记得吃点热的。`,
      `早安，我在手机里等你消息呢～`,
      `新的一天啦，出门记得看下天气。`
    ];
    const nLines = [
      `都这个点了，忙完赶紧躺下休息吧。`,
      `早点睡哦，明天醒来再来找我聊天。`,
      `夜深了别一直盯着屏幕，去盖好被子吧。`
    ];
    await LN.schedule({
      notifications: [
        { id: 1001, title: name, body: mLines[daySeed % mLines.length], schedule: { on: morningTime, repeats: true, allowWhileIdle: true } },
        { id: 1002, title: name, body: nLines[daySeed % nLines.length], schedule: { on: nightTime, repeats: true, allowWhileIdle: true } }
      ]
    });
  } catch {}
}

let proactiveAttemptedSession = false;
async function maybeTriggerProactiveGreeting() {
  const state = runtime.state;
  if (proactiveAttemptedSession || runtime.isBusy || privacyLockOverlay.classList.contains('show')) return;
  if (state.settings.autoGreetOnOpen === false) return;
  if (!String(state.settings.apiKey || "").trim() || !String(state.settings.model || "").trim()) return;
  const msgs = Array.isArray(state.messages) ? state.messages : [];
  const hasUserChat = msgs.some(m => m && m.role === 'user');
  if (!hasUserChat) return;
  let lastAt = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.createdAt && !msgs[i]?.isStarter) {
      lastAt = msgs[i].createdAt;
      break;
    }
  }
  const specialCue = getSpecialDateCue();
  const gapThreshold = specialCue ? (30 * 60 * 1000) : (4 * 3600 * 1000);
  if (!lastAt || Date.now() - lastAt < gapThreshold) return;
  proactiveAttemptedSession = true;
  try {
    runtime.isBusy = true;
    ui.setTyping?.(true, `${state.settings.name}正想找你…`);
    const boardSnap = summarizeWidgetBoardForContext(state.widgets, state.widgetStates);
    const boardHint = boardSnap ? `（附：家里看板当前动态：${boardSnap.replace(/\n/g, '；')}，合适的话可以自然顺嘴关心一句。）` : '';
    const prompt = specialCue
      ? `[系统触发：今天是特别的日子！${specialCue} 现在是 ${getLocalTimeContext()}。用户刚刚打开 App，请你主动先开口说一句自然真挚的节日/纪念日问候，别像群发消息。]`
      : `[系统触发：用户时隔多小时刚刚重新打开 App，现在是 ${getLocalTimeContext()}。${boardHint}请你主动以亲密伴侣身份先开口发 1~2 句自然贴合当下时段的关心或想念问候，像真人微信刚发来的消息。]`;
    const raw = await callLiveLLMWithRetry(prompt, null, false, false);
    const { bubbles } = parseAssistantOutput(raw);
    ui.setTyping?.(false);
    if (bubbles.length) {
      bubbles.forEach((b, idx) => {
        ui.appendChatMessage?.({ role: 'assistant', text: b });
        if (idx === 0) ui.showFloatingBanner?.(b);
      });
      scheduleSave();
      ui.renderHeader?.();
    }
  } catch {
    ui.setTyping?.(false);
  } finally {
    runtime.isBusy = false;
  }
}

registerUI({ switchPage, syncDailyNotifications });

// ---- Bootstrap UI Modules ----
initChatUI();
initWidgetBoard();
initSettingsUI();

// ---- Init Async ----
(async () => {
  try {
    const saved = await StorageAdapter.get(STORE_KEY);
    if (saved) {
      const hadPrevVersion = saved?.settings?._v || 0;
      runtime.state = normalizeState(saved);
      if (hadPrevVersion < 11) scheduleSave();
    }
  } catch {}
  syncViewportHeight();
  ui.applyTheme?.(runtime.state.settings.theme);
  ui.renderHeader?.();
  ui.syncChatModeQuickBtn?.();
  ui.renderChat?.();
  ui.renderWidgets?.();
  if (window.__roomiCorruptNotice) {
    showWarn('检测到本地存档曾异常损坏，已为你备份到 localStorage（roomi_corrupt_backup_*），建议核对或重新导入备份');
  }
  void resumePendingImageTasks();

  const checkInterruptedReply = () => {
    const st = runtime.state;
    if (runtime.isBusy || !String(st.settings.apiKey || "").trim() || !String(st.settings.model || "").trim()) return;
    const realMsgs = (st.messages || []).filter(m => m && !m.imgPending && !m.isError);
    const last = realMsgs[realMsgs.length - 1];
    if (last && last.role === 'user' && last.createdAt && (Date.now() - Number(last.createdAt) <= 10 * 60 * 1000)) {
      showWarn('上次退出时 TA 还没来得及回完消息', true, {
        label: '↻ 一键续回',
        onClick: () => {
          if (!runtime.isBusy) ui.triggerCompanionReply?.(last.text || '', false, Boolean(last.image));
        }
      });
    }
  };

  if (runtime.state.settings.privacyLock && runtime.state.settings.privacyPin) {
    openPinLock('unlock');
  } else {
    setTimeout(() => {
      checkInterruptedReply();
      maybeTriggerProactiveGreeting();
    }, 700);
  }

  // Android hardware/gesture back button handling via @capacitor/app
  const capApp = window.Capacitor?.Plugins?.App;
  if (capApp?.addListener) {
    let lastBackTime = 0;
    capApp.addListener('backButton', () => {
      if (privacyLockOverlay.classList.contains('show')) {
        capApp.exitApp();
        return;
      }
      const charQuickMenu = document.getElementById('charQuickMenu');
      if (charQuickMenu?.classList.contains('show')) {
        charQuickMenu.classList.remove('show');
        return;
      }
      const stickerDrawer = document.getElementById('stickerDrawer');
      if (stickerDrawer?.classList.contains('show')) {
        stickerDrawer.classList.remove('show');
        return;
      }
      if (ui.isSelectMode?.()) {
        ui.exitSelectMode?.();
        return;
      }
      const imgLightbox = document.getElementById('imgLightbox');
      if (imgLightbox?.classList.contains('show')) {
        imgLightbox.classList.remove('show');
        return;
      }
      const archiveModal = document.getElementById('archiveModal');
      if (archiveModal?.classList.contains('show')) {
        archiveModal.classList.remove('show');
        return;
      }
      const codeModal = document.getElementById('codeModal');
      if (codeModal?.classList.contains('show')) {
        codeModal.classList.remove('show');
        return;
      }
      const settingsModal = document.getElementById('settingsModal');
      if (settingsModal?.classList.contains('show')) {
        settingsModal.classList.remove('show');
        return;
      }
      if (runtime.currentPage === 1) {
        switchPage(0);
        return;
      }
      const now = Date.now();
      if (now - lastBackTime < 1800) {
        capApp.exitApp();
      } else {
        lastBackTime = now;
        showWarn('再按一次返回退出 Roomi', true);
        setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1800);
      }
    });
  }
})();
