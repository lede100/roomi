import {
  runtime,
  getActiveCharacter,
  flushActiveCharToList,
  scheduleSave,
  showWarn,
  isModelMarkedNonVision
} from './state.js';
import {
  SEND_SVG,
  STOP_SVG,
  BUILTIN_STICKERS,
  buildStickerSvg
} from './presets.js';
import {
  sleep,
  escapeHtml,
  copyText,
  formatShortDateTime,
  formatChatDividerTime,
  shouldShowTimeDivider,
  compressImageFile,
  compressImageSrcToJpeg
} from './utils.js';
import { parseAssistantOutput, stripThinkingTags, stripStageDirections } from './prompt.js';
import { maybeCompressHistory } from './memory.js';
import { callLiveLLMWithRetry, callDemoEngine } from './llm.js';
import {
  isImageGenReady,
  aspectRatioFromSize,
  findLastChatImage,
  enqueueImageTask,
  bindImageGenHooks
} from './image-gen.js';
import { ui, registerUI } from './ui-bridge.js';

export function initChatUI() {
  const chatScroll = document.getElementById('chatScroll');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const widgetCount = document.getElementById('widgetCount');
  const boardDot = document.getElementById('boardDot');
  const floatingBanner = document.getElementById('floatingBanner');
  const floatingBannerText = document.getElementById('floatingBannerText');
  const modeBadge = document.getElementById('modeBadge');
  const companionNameDisplay = document.getElementById('companionNameDisplay');
  const avatarText = document.getElementById('avatarText');
  const affectionDisplay = document.getElementById('affectionDisplay');
  const moodDisplay = document.getElementById('moodDisplay');

  const typingRow = document.createElement('div');
  typingRow.className = 'typing-row';
  typingRow.innerHTML = `<span id="typingLabel">对方正在输入</span><span class="dots"><span></span><span></span><span></span></span>`;

  const charQuickMenu = document.getElementById('charQuickMenu');
  const companionSwitcherBtn = document.getElementById('companionSwitcherBtn');

  function applyAvatarToEl(el, name, avatarImage, avatarColor = '') {
    if (!el) return;
    el.innerHTML = '';
    if (avatarImage) {
      el.classList.add('has-img');
      el.style.background = '';
      const img = document.createElement('img');
      img.src = avatarImage;
      img.alt = name || '头像';
      el.appendChild(img);
    } else {
      el.classList.remove('has-img');
      el.style.background = avatarColor || '';
      el.textContent = (name || '林').slice(-1);
    }
  }

  function renderQuickCharMenu() {
    if (!charQuickMenu) return;
    const chars = Array.isArray(runtime.state.characters) ? runtime.state.characters : [];
    charQuickMenu.innerHTML = '';
    chars.forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'char-quick-item' + (c.id === runtime.state.activeCharId ? ' active' : '');
      const left = document.createElement('span');
      left.className = 'char-quick-left';
      const dot = document.createElement('span');
      dot.className = 'char-pill-dot';
      applyAvatarToEl(dot, c.name, c.avatarImage, c.avatarColor);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = c.name || '未命名';
      left.appendChild(dot);
      left.appendChild(nameSpan);
      const mark = document.createElement('span');
      mark.textContent = c.id === runtime.state.activeCharId ? '✓' : '';
      mark.style.fontSize = '12px';
      btn.appendChild(left);
      btn.appendChild(mark);
      btn.onclick = () => {
        charQuickMenu.classList.remove('show');
        ui.switchCharacter?.(c.id);
      };
      charQuickMenu.appendChild(btn);
    });
    const div = document.createElement('div');
    div.className = 'char-quick-divider';
    charQuickMenu.appendChild(div);
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'char-quick-item';
    manageBtn.innerHTML = `<span style="color:var(--blue);font-weight:500;">+ 新建 / 管理伴侣角色</span>`;
    manageBtn.onclick = () => {
      charQuickMenu.classList.remove('show');
      ui.openSettingsTo?.('companion', false);
      ui.setCompanionSubView?.('create');
    };
    charQuickMenu.appendChild(manageBtn);
  }

  let lastAvatarTapTime = 0;
  let lastPatSentAt = 0;
  avatarText.addEventListener('click', e => {
    const now = Date.now();
    if (now - lastAvatarTapTime < 340) {
      e.stopPropagation();
      e.preventDefault();
      lastAvatarTapTime = 0;
      charQuickMenu.classList.remove('show');
      avatarText.classList.remove('nudged');
      void avatarText.offsetWidth;
      avatarText.classList.add('nudged');
      if (runtime.isBusy || now - lastPatSentAt < 2500) return;
      lastPatSentAt = now;
      const name = runtime.state.settings.name || '伴侣';
      appendChatMessage({ role: 'event', text: `你拍了拍「${name}」的小脑袋` });
      scheduleSave();
      triggerCompanionReply(`[系统互动：用户刚刚双击头像拍了拍你的小脑袋，用你当下最自然的口吻轻轻回应一下，别当客服。]`, true);
      return;
    }
    lastAvatarTapTime = now;
  });

  companionSwitcherBtn.onclick = e => {
    e.stopPropagation();
    const willOpen = !charQuickMenu.classList.contains('show');
    if (willOpen) renderQuickCharMenu();
    charQuickMenu.classList.toggle('show', willOpen);
  };
  document.addEventListener('click', e => {
    if (charQuickMenu.classList.contains('show') && !charQuickMenu.contains(e.target) && !companionSwitcherBtn.contains(e.target)) {
      charQuickMenu.classList.remove('show');
    }
    if (!e.target.closest('.msg-row')) {
      chatScroll.querySelectorAll('.msg-row.show-actions').forEach(r => r.classList.remove('show-actions'));
    }
  });

  function renderHeader() {
    const activeChar = getActiveCharacter();
    const name = runtime.state.settings.name || activeChar?.name || '林澈';
    companionNameDisplay.textContent = name;
    applyAvatarToEl(avatarText, name, runtime.state.settings.avatarImage || activeChar?.avatarImage, activeChar?.avatarColor);
    chatInput.placeholder = `给${name}发消息…`;
    const bTabEl = document.getElementById('boardTabLabel');
    const bHeroEl = document.getElementById('boardHeroTitle');
    if (bTabEl) bTabEl.textContent = `${name}的家`;
    if (bHeroEl) bHeroEl.textContent = `${name}的家`;
    const sBtn = document.getElementById('storyToggleBtn');
    if (sBtn) sBtn.classList.toggle('active', runtime.state.settings.chatMode === 'story');
    applyChatWallpaper(runtime.state.settings.wallpaper || activeChar?.wallpaper || '');
    affectionDisplay.textContent = `♥ ${runtime.state.affection}`;
    const sendingImg = (runtime.pendingImgCountByChar.get(runtime.state.activeCharId) || 0) > 0;
    moodDisplay.textContent = sendingImg ? '正在传照片…' : (runtime.state.mood === '正在传照片…' ? '在线等你' : runtime.state.mood);
    const isLive = Boolean(runtime.state.settings.apiKey.trim());
    if (isLive) {
      modeBadge.textContent = runtime.state.settings.model || '已连线 · 未选模型';
      modeBadge.classList.add('live');
      modeBadge.classList.remove('guide');
      modeBadge.title = '点击切换或配置模型';
    } else {
      modeBadge.textContent = '去填 Key · 演示中';
      modeBadge.classList.remove('live');
      modeBadge.classList.add('guide');
      modeBadge.title = '第一步：填入 API Key 解锁真 AI';
    }
    const guideBanner = document.getElementById('keyGuideBanner');
    if (guideBanner) {
      guideBanner.classList.toggle('show', !isLive && !runtime.keyGuideDismissedSession);
    }
    widgetCount.textContent = String(runtime.state.widgets.length);
    updateVisionBtnState();
  }

  const CHAT_PAGE_SIZE = 60;
  function applyChatWallpaper(wpUrl) {
    const layer = document.getElementById('chatBgLayer');
    const veil = document.getElementById('chatBgVeil');
    if (!layer || !veil) return;
    if (wpUrl) {
      layer.style.backgroundImage = `url(${wpUrl})`;
      layer.classList.add('show');
      veil.classList.add('show');
    } else {
      layer.style.backgroundImage = '';
      layer.classList.remove('show');
      veil.classList.remove('show');
    }
  }

  let currentLightboxSrc = '';
  let currentLightboxMsgId = '';

  function fillImageBubble(bubble, imageUrl, text, msgId = '') {
    bubble.className = 'bubble' + (text ? '' : ' img-only');
    const img = document.createElement('img');
    img.className = 'bubble-img';
    img.src = imageUrl;
    img.alt = '图片';
    img.onclick = e => {
      e.stopPropagation();
      openLightboxWithImage(imageUrl, msgId);
    };
    bubble.appendChild(img);
    if (text) {
      const span = document.createElement('div');
      span.className = 'bubble-text';
      span.textContent = text;
      bubble.appendChild(span);
    }
  }

  function openLightboxWithImage(imageUrl, msgId = '') {
    currentLightboxSrc = imageUrl;
    currentLightboxMsgId = msgId || '';
    document.getElementById('imgLightboxSrc').src = imageUrl;
    const jBtn = document.getElementById('lightboxJumpBtn');
    if (jBtn) jBtn.style.display = currentLightboxMsgId ? 'inline-flex' : 'none';
    document.getElementById('imgLightbox').classList.add('show');
  }

  function jumpToMessage(msgId, fallbackIdx = -1) {
    let idx = msgId ? runtime.state.messages.findIndex(item => item && item.id === msgId) : -1;
    if (idx < 0) idx = fallbackIdx;
    if (idx < 0 || idx >= runtime.state.messages.length) return;
    ui.switchPage?.(0);
    if (idx < runtime.visibleChatStart) {
      runtime.visibleChatStart = Math.max(0, idx - 12);
      renderChat(true);
    }
    requestAnimationFrame(() => {
      const targetMsg = runtime.state.messages[idx];
      const row = targetMsg?.id ? chatScroll.querySelector(`[data-msg-id="${targetMsg.id}"]`) : null;
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('jump-flash');
        setTimeout(() => row.classList.remove('jump-flash'), 1600);
      }
    });
  }

  async function regenerateFromMessage(msgObj) {
    if (runtime.isBusy) return;
    const idx = runtime.state.messages.indexOf(msgObj);
    if (idx < 0) return;
    // Find latest user/event trigger before idx
    let triggerIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (runtime.state.messages[i]?.role === 'user' || runtime.state.messages[i]?.role === 'event') {
        triggerIdx = i;
        break;
      }
    }
    if (triggerIdx < 0) {
      showWarn('开场白前面没有你的提问，直接发一句话试试吧', true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2400);
      return;
    }
    const triggerMsg = runtime.state.messages[triggerIdx];
    runtime.state.messages.splice(triggerIdx + 1);
    if (runtime.state.summarizedCount > runtime.state.messages.length) runtime.state.summarizedCount = runtime.state.messages.length;
    scheduleSave();
    renderChat(true);
    await triggerCompanionReply(triggerMsg.text || '', triggerMsg.role === 'event', Boolean(triggerMsg.image));
  }

  let selectMode = false;
  const selectedMsgIds = new Set();
  const multiSelectBar = document.getElementById('multiSelectBar');
  const multiSelectCountEl = document.getElementById('multiSelectCount');
  const composerBar = document.getElementById('composerBar');

  function updateMultiSelectBarUI() {
    if (multiSelectCountEl) multiSelectCountEl.textContent = `已选 ${selectedMsgIds.size} 条`;
    if (multiSelectBar) multiSelectBar.classList.toggle('show', selectMode);
    if (composerBar) composerBar.style.display = selectMode ? 'none' : 'flex';
    chatScroll.classList.toggle('select-mode', selectMode);
  }

  function enterSelectMode(initialId = '') {
    selectMode = true;
    selectedMsgIds.clear();
    if (initialId) selectedMsgIds.add(initialId);
    chatScroll.querySelectorAll('.msg-row.show-actions').forEach(r => r.classList.remove('show-actions'));
    chatScroll.querySelectorAll('.msg-row[data-msg-id]').forEach(r => {
      const hit = selectedMsgIds.has(r.dataset.msgId);
      r.classList.toggle('is-selected', hit);
      const chk = r.querySelector('.msg-select-chk');
      if (chk) chk.textContent = hit ? '✓' : '';
    });
    updateMultiSelectBarUI();
  }

  function exitSelectMode() {
    selectMode = false;
    selectedMsgIds.clear();
    chatScroll.querySelectorAll('.msg-row.is-selected').forEach(r => {
      r.classList.remove('is-selected');
      const chk = r.querySelector('.msg-select-chk');
      if (chk) chk.textContent = '';
    });
    updateMultiSelectBarUI();
  }

  const cancelMultiSelectBtn = document.getElementById('cancelMultiSelectBtn');
  if (cancelMultiSelectBtn) cancelMultiSelectBtn.onclick = exitSelectMode;
  const deleteMultiSelectBtn = document.getElementById('deleteMultiSelectBtn');
  if (deleteMultiSelectBtn) {
    deleteMultiSelectBtn.onclick = () => {
      if (!selectedMsgIds.size) return;
      if (!confirm(`确定删除选中的 ${selectedMsgIds.size} 条消息吗？`)) return;
      let removedBeforeSum = 0;
      const nextMsgs = [];
      runtime.state.messages.forEach((msg, idx) => {
        if (msg && selectedMsgIds.has(msg.id)) {
          if (idx < runtime.state.summarizedCount) removedBeforeSum++;
        } else {
          nextMsgs.push(msg);
        }
      });
      runtime.state.messages = nextMsgs;
      runtime.state.summarizedCount = Math.max(0, Math.min(runtime.state.messages.length, runtime.state.summarizedCount - removedBeforeSum));
      exitSelectMode();
      scheduleSave();
      renderChat(true);
    };
  }

  function isMessageFavorited(m) {
    if (!m || !Array.isArray(runtime.state.favorites)) return false;
    return runtime.state.favorites.some(f => (m.id && f.msgId === m.id) || (f.text && f.text === m.text && f.savedAt && Math.abs((f.msgCreatedAt || 0) - (m.createdAt || 0)) < 1000));
  }

  function toggleFavoriteMessage(m) {
    if (!m) return false;
    if (!Array.isArray(runtime.state.favorites)) runtime.state.favorites = [];
    const text = m.stickerLabel ? `[表情：${m.stickerLabel}]` : String(m.text || (m.image ? '[照片]' : '')).trim();
    if (!text) return false;
    const existIdx = runtime.state.favorites.findIndex(f => (m.id && f.msgId === m.id) || (f.text === text && Math.abs((f.msgCreatedAt || 0) - (m.createdAt || 0)) < 1000));
    if (existIdx >= 0) {
      runtime.state.favorites.splice(existIdx, 1);
      scheduleSave();
      return false;
    }
    runtime.state.favorites.unshift({
      id: 'fav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      msgId: m.id || '',
      who: m.role === 'user' ? '我' : (runtime.state.settings.name || 'TA'),
      text,
      msgCreatedAt: m.createdAt || Date.now(),
      savedAt: Date.now()
    });
    scheduleSave();
    return true;
  }

  function attachMsgActions(row, bubble, m) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    if (m.createdAt) {
      const tm = document.createElement('span');
      tm.className = 'msg-act-time';
      tm.textContent = formatShortDateTime(m.createdAt);
      actions.appendChild(tm);
    }

    if (m.text) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'msg-act-btn';
      copyBtn.textContent = '复制';
      copyBtn.onclick = async e => {
        e.stopPropagation();
        if (await copyText(m.text)) {
          showWarn('已复制文字', true);
          setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1500);
        }
        row.classList.remove('show-actions');
      };
      actions.appendChild(copyBtn);
    }

    if (m.role === 'assistant') {
      const regenBtn = document.createElement('button');
      regenBtn.type = 'button';
      regenBtn.className = 'msg-act-btn';
      regenBtn.textContent = '↻ 重说';
      regenBtn.onclick = e => {
        e.stopPropagation();
        row.classList.remove('show-actions');
        regenerateFromMessage(m);
      };
      actions.appendChild(regenBtn);
    }

    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'msg-act-btn';
    quoteBtn.textContent = '引用';
    quoteBtn.onclick = e => {
      e.stopPropagation();
      row.classList.remove('show-actions');
      setPendingQuote(m);
    };
    actions.appendChild(quoteBtn);

    if (m.text || m.stickerLabel) {
      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'msg-act-btn';
      const refreshFavBtn = () => { favBtn.textContent = isMessageFavorited(m) ? '💛 已藏' : '☆ 收藏'; };
      refreshFavBtn();
      favBtn.onclick = e => {
        e.stopPropagation();
        const added = toggleFavoriteMessage(m);
        refreshFavBtn();
        row.classList.remove('show-actions');
        showWarn(added ? '💛 已收入心动收藏夹' : '已取消收藏', true);
        setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1500);
      };
      actions.appendChild(favBtn);
    }

    if (!m.stickerId && !m.stickerImg) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'msg-act-btn';
      editBtn.textContent = '编辑';
      editBtn.onclick = e => {
        e.stopPropagation();
        if (runtime.isBusy || bubble.dataset.editing === '1') return;
        row.classList.remove('show-actions');
        bubble.dataset.editing = '1';
        const origText = m.text || '';
        const wrap = document.createElement('div');
        wrap.className = 'bubble-edit-wrap';
        wrap.onclick = ev => ev.stopPropagation();
        const ta = document.createElement('textarea');
        ta.className = 'bubble-edit-ta';
        ta.value = origText;
        const btns = document.createElement('div');
        btns.className = 'bubble-edit-btns';
        const cancelB = document.createElement('button');
        cancelB.type = 'button';
        cancelB.className = 'msg-act-btn';
        cancelB.textContent = '取消';
        const saveB = document.createElement('button');
        saveB.type = 'button';
        saveB.className = 'msg-act-btn';
        saveB.style.color = 'var(--blue)';
        saveB.style.borderColor = 'var(--blue-border)';
        saveB.textContent = '保存';
        const restoreView = () => {
          delete bubble.dataset.editing;
          bubble.innerHTML = '';
          if (m.replyTo) {
            const q = document.createElement('div');
            q.className = 'bubble-quote';
            q.textContent = `↩ ${m.replyTo.who}：${m.replyTo.preview}`;
            q.onclick = ev => { ev.stopPropagation(); if (m.replyTo.id) jumpToMessage(m.replyTo.id); };
            bubble.appendChild(q);
          }
          if (m.image) {
            fillImageBubble(bubble, m.image, m.text, m.id);
          } else {
            bubble.className = 'bubble';
            if (m.role === 'user') {
              const sp = document.createElement('div');
              sp.className = 'bubble-text';
              sp.textContent = m.text || '';
              bubble.appendChild(sp);
            } else {
              bubble.textContent = m.text || '';
            }
          }
        };
        cancelB.onclick = restoreView;
        saveB.onclick = () => {
          const nextVal = ta.value.trim();
          if (!nextVal && !m.image) {
            showWarn('纯文字消息不能改成空的，想去掉可以直接点删除哦', true);
            setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2200);
            return;
          }
          m.text = nextVal;
          scheduleSave();
          restoreView();
        };
        btns.appendChild(cancelB);
        btns.appendChild(saveB);
        wrap.appendChild(ta);
        wrap.appendChild(btns);
        bubble.className = 'bubble';
        bubble.innerHTML = '';
        bubble.appendChild(wrap);
        ta.focus();
      };
      actions.appendChild(editBtn);
    }

    const multiBtn = document.createElement('button');
    multiBtn.type = 'button';
    multiBtn.className = 'msg-act-btn';
    multiBtn.textContent = '多选';
    multiBtn.onclick = e => {
      e.stopPropagation();
      enterSelectMode(m.id || '');
    };
    actions.appendChild(multiBtn);

    const idxNow = runtime.state.messages.indexOf(m);
    if (idxNow >= 0 && idxNow < runtime.state.messages.length - 1) {
      const cutBtn = document.createElement('button');
      cutBtn.type = 'button';
      cutBtn.className = 'msg-act-btn danger';
      cutBtn.textContent = '删到底';
      cutBtn.onclick = e => {
        e.stopPropagation();
        if (runtime.isBusy) return;
        const pos = runtime.state.messages.indexOf(m);
        if (pos < 0) return;
        const count = runtime.state.messages.length - pos;
        if (!confirm(`确定把这一条和后面的共 ${count} 条消息全部删掉吗？`)) return;
        runtime.state.messages.splice(pos);
        if (runtime.state.summarizedCount > runtime.state.messages.length) runtime.state.summarizedCount = runtime.state.messages.length;
        scheduleSave();
        renderChat(true);
      };
      actions.appendChild(cutBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'msg-act-btn danger';
    delBtn.textContent = '删除';
    delBtn.onclick = e => {
      e.stopPropagation();
      if (runtime.isBusy) return;
      const idx = runtime.state.messages.indexOf(m);
      if (idx >= 0) {
        runtime.state.messages.splice(idx, 1);
        if (idx < runtime.state.summarizedCount) runtime.state.summarizedCount = Math.max(0, runtime.state.summarizedCount - 1);
        scheduleSave();
      }
      row.remove();
    };
    actions.appendChild(delBtn);

    row.appendChild(actions);
    bubble.addEventListener('click', e => {
      e.stopPropagation();
      if (selectMode) {
        row.querySelector('.msg-select-chk')?.click();
        return;
      }
      const willShow = !row.classList.contains('show-actions');
      chatScroll.querySelectorAll('.msg-row.show-actions').forEach(r => r.classList.remove('show-actions'));
      if (willShow) row.classList.add('show-actions');
    });
  }

  function createMsgRowElement(m, miniChar) {
    if (m.role === 'event') {
      const row = document.createElement('div');
      row.className = 'msg-row event';
      row.innerHTML = `<div class="event-pill">⚡ ${escapeHtml(m.text)}</div>`;
      return row;
    }
    if (m.role === 'spawn') {
      const row = document.createElement('div');
      row.className = 'msg-row ai';
      const homeLabel = `${runtime.state.settings.name || '伴侣'}的家`;
      const tagLabel = m.updated ? `✨ ${homeLabel}已更新` : `✨ ${homeLabel}已上新`;
      row.innerHTML = `
        <div class="spawn-card" data-jump="${escapeHtml(m.widgetId)}">
          <div class="spawn-meta">
            <div class="spawn-tag">${tagLabel}</div>
            <div class="spawn-title">${escapeHtml(m.title)}</div>
          </div>
          <div class="spawn-go">去互动 →</div>
        </div>`;
      row.querySelector('.spawn-card').onclick = () => ui.switchPage?.(1, m.widgetId);
      return row;
    }

    const makeSelectCheck = () => {
      const chk = document.createElement('button');
      chk.type = 'button';
      chk.className = 'msg-select-chk';
      const hit = m.id && selectedMsgIds.has(m.id);
      chk.textContent = hit ? '✓' : '';
      chk.onclick = ev => {
        ev.stopPropagation();
        if (!m.id) return;
        const rowEl = chk.closest('.msg-row');
        if (selectedMsgIds.has(m.id)) {
          selectedMsgIds.delete(m.id);
          rowEl?.classList.remove('is-selected');
          chk.textContent = '';
        } else {
          selectedMsgIds.add(m.id);
          rowEl?.classList.add('is-selected');
          chk.textContent = '✓';
        }
        updateMultiSelectBarUI();
      };
      return chk;
    };

    const fillStickerBubble = bubble => {
      bubble.className = 'bubble sticker-only';
      if (m.stickerImg) {
        const img = document.createElement('img');
        img.src = m.stickerImg;
        img.alt = m.stickerLabel || '表情';
        img.style.cssText = 'width:108px;height:108px;object-fit:contain;border-radius:14px;display:block;';
        bubble.appendChild(img);
      } else {
        const st = BUILTIN_STICKERS.find(s => s.id === m.stickerId) || BUILTIN_STICKERS[0];
        const card = document.createElement('div');
        card.className = 'sticker-bubble-card';
        card.innerHTML = `${buildStickerSvg(st)}<span>${escapeHtml(m.stickerLabel || st.label)}</span>`;
        bubble.appendChild(card);
      }
    };

    if (m.role === 'user') {
      const row = document.createElement('div');
      row.className = 'msg-row user' + (m.id && selectedMsgIds.has(m.id) ? ' is-selected' : '');
      if (m.id) row.dataset.msgId = m.id;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (m.replyTo) {
        const q = document.createElement('div');
        q.className = 'bubble-quote';
        q.textContent = `↩ ${m.replyTo.who}：${m.replyTo.preview}`;
        q.onclick = ev => { ev.stopPropagation(); if (m.replyTo.id) jumpToMessage(m.replyTo.id); };
        bubble.appendChild(q);
      }
      if (m.stickerId || m.stickerImg) {
        fillStickerBubble(bubble);
      } else if (m.image) {
        fillImageBubble(bubble, m.image, m.text, m.id);
      } else if (m.text) {
        const span = document.createElement('div');
        span.className = 'bubble-text';
        span.textContent = m.text;
        bubble.appendChild(span);
      }
      row.appendChild(makeSelectCheck());
      row.appendChild(bubble);
      attachMsgActions(row, bubble, m);
      return row;
    }
    if (m.imgPending) {
      const row = document.createElement('div');
      row.className = 'msg-row ai';
      row.dataset.pendingId = m.id;
      const ratio = m.aspectRatio || '3 / 4';
      const wrap = document.createElement('div');
      wrap.className = 'ai-row-wrap';
      const av = document.createElement('div');
      av.className = 'ai-mini-avatar';
      const ac = getActiveCharacter();
      applyAvatarToEl(av, runtime.state.settings.name || '林澈', runtime.state.settings.avatarImage || ac?.avatarImage);
      const skel = document.createElement('div');
      skel.className = 'img-skeleton';
      skel.style.aspectRatio = ratio;
      wrap.appendChild(av);
      wrap.appendChild(skel);
      row.appendChild(wrap);
      return row;
    }
    const row = document.createElement('div');
    row.className = 'msg-row ai' + (m.id && selectedMsgIds.has(m.id) ? ' is-selected' : '');
    if (m.id) row.dataset.msgId = m.id;
    const wrap = document.createElement('div');
    wrap.className = 'ai-row-wrap';
    const av = document.createElement('div');
    av.className = 'ai-mini-avatar';
    const ac = getActiveCharacter();
    applyAvatarToEl(av, runtime.state.settings.name || '林澈', runtime.state.settings.avatarImage || ac?.avatarImage);
    const bubble = document.createElement('div');
    if (m.image) {
      fillImageBubble(bubble, m.image, m.text, m.id);
    } else {
      bubble.className = 'bubble';
      bubble.textContent = m.text || '';
    }
    wrap.appendChild(av);
    wrap.appendChild(bubble);
    row.appendChild(makeSelectCheck());
    row.appendChild(wrap);
    attachMsgActions(row, bubble, m);
    return row;
  }

  function createTimeDividerEl(ts) {
    const div = document.createElement('div');
    div.className = 'msg-time-divider';
    div.innerHTML = `<span>${escapeHtml(formatChatDividerTime(ts))}</span>`;
    return div;
  }

  function appendChatMessage(m) {
    if (!m.createdAt) m.createdAt = Date.now();
    if (!m.id) m.id = `msg_${m.createdAt}_${Math.random().toString(36).slice(2, 6)}`;
    let prevTs = 0;
    for (let i = runtime.state.messages.length - 1; i >= 0; i--) {
      if (runtime.state.messages[i]?.createdAt && !runtime.state.messages[i]?.imgPending) {
        prevTs = runtime.state.messages[i].createdAt;
        break;
      }
    }
    runtime.state.messages.push(m);
    const activeChar = getActiveCharacter();
    if (activeChar) activeChar.lastActiveAt = m.createdAt;
    if (!m.imgPending && shouldShowTimeDivider(prevTs, m.createdAt)) {
      chatScroll.insertBefore(createTimeDividerEl(m.createdAt), typingRow);
    }
    const miniChar = escapeHtml((runtime.state.settings.name || '林澈').slice(-1));
    const row = createMsgRowElement(m, miniChar);
    chatScroll.insertBefore(row, typingRow);
    scrollChatBottom();
  }

  function renderChat(keepWindow = false) {
    const miniChar = escapeHtml((runtime.state.settings.name || '林澈').slice(-1));
    const total = runtime.state.messages.length;
    if (!keepWindow || runtime.visibleChatStart < 0 || runtime.visibleChatStart > total) {
      runtime.visibleChatStart = Math.max(0, total - CHAT_PAGE_SIZE);
    }
    chatScroll.innerHTML = '';

    if (runtime.visibleChatStart > 0) {
      const loadRow = document.createElement('div');
      loadRow.className = 'msg-row event';
      loadRow.innerHTML = `<button type="button" class="event-pill" style="cursor:pointer;">↑ 查看更早消息（还有 ${runtime.visibleChatStart} 条）</button>`;
      loadRow.querySelector('button').onclick = () => {
        const prevH = chatScroll.scrollHeight;
        runtime.visibleChatStart = Math.max(0, runtime.visibleChatStart - CHAT_PAGE_SIZE);
        renderChat(true);
        requestAnimationFrame(() => {
          chatScroll.scrollTop = Math.max(0, chatScroll.scrollHeight - prevH);
        });
      };
      chatScroll.appendChild(loadRow);
    }

    let prevDividerTs = runtime.visibleChatStart > 0 ? (runtime.state.messages[runtime.visibleChatStart - 1]?.createdAt || 0) : 0;
    runtime.state.messages.slice(runtime.visibleChatStart).forEach(m => {
      if (m && !m.imgPending && m.createdAt && shouldShowTimeDivider(prevDividerTs, m.createdAt)) {
        chatScroll.appendChild(createTimeDividerEl(m.createdAt));
        prevDividerTs = m.createdAt;
      } else if (m && m.createdAt) {
        prevDividerTs = m.createdAt;
      }
      chatScroll.appendChild(createMsgRowElement(m, miniChar));
    });
    chatScroll.appendChild(typingRow);
    if (!keepWindow) scrollChatBottom();
  }

  function scrollChatBottom() {
    requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
  }

  function setTyping(show, label) {
    document.getElementById('typingLabel').textContent = label || `${runtime.state.settings.name}正在输入`;
    typingRow.classList.toggle('show', show);
    if (show) scrollChatBottom();
  }

  function showFloatingBanner(text) {
    if (runtime.currentPage === 0) return;
    floatingBannerText.textContent = `${runtime.state.settings.name}：${text}`;
    floatingBanner.classList.add('show');
    clearTimeout(runtime.bannerTimer);
    runtime.bannerTimer = setTimeout(() => floatingBanner.classList.remove('show'), 4500);
  }
  floatingBanner.onclick = () => {
    floatingBanner.classList.remove('show');
    ui.switchPage?.(0);
  };

  async function triggerCompanionReply(userText, isEvent = false, hasImage = false) {
    const targetCharId = runtime.state.activeCharId;
    runtime.isBusy = true;
    runtime.replyAbortRequested = false;
    sendBtn.innerHTML = STOP_SVG;
    sendBtn.classList.add('stop');
    sendBtn.setAttribute('aria-label', '停止');
    setTyping(true, isEvent ? `${runtime.state.settings.name}看到了你的动态` : `${runtime.state.settings.name}正在输入`);

    const miniChar = escapeHtml((runtime.state.settings.name || '林澈').slice(-1));
    let streamPreviewRow = null;
    const ensureStreamRow = () => {
      if (streamPreviewRow) return streamPreviewRow;
      streamPreviewRow = document.createElement('div');
      streamPreviewRow.className = 'msg-row ai streaming';
      const wrap = document.createElement('div');
      wrap.className = 'ai-row-wrap';
      const av = document.createElement('div');
      av.className = 'ai-mini-avatar';
      const ac = getActiveCharacter();
      applyAvatarToEl(av, runtime.state.settings.name || '林澈', runtime.state.settings.avatarImage || ac?.avatarImage);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      wrap.appendChild(av);
      wrap.appendChild(bubble);
      streamPreviewRow.appendChild(wrap);
      chatScroll.insertBefore(streamPreviewRow, typingRow);
      return streamPreviewRow;
    };

    const wantsWidgetHint = !isEvent && /(组件|家里|小窝|工具|转盘|打卡|倒计时|罐子|做个)/i.test(userText || '');
    const slowHintTimer = setTimeout(() => {
      if (!runtime.isBusy) return;
      if (wantsWidgetHint) {
        setTyping(true, `${runtime.state.settings.name}正在为你做小组件…`);
      } else if (runtime.state.settings.thinkingMode === 'high' || runtime.state.settings.thinkingMode === 'low') {
        setTyping(true, `${runtime.state.settings.name}正在细想怎么回你…`);
      } else {
        setTyping(true, `${runtime.state.settings.name}正在打字…`);
      }
    }, 3600);

    try {
      const hasKey = Boolean(runtime.state.settings.apiKey.trim());
      let raw = '';

      if (hasKey) {
        raw = await callLiveLLMWithRetry(isEvent ? userText : null, partial => {
          const widgetPos = partial.search(/<widget/i);
          let visible = widgetPos >= 0 ? partial.slice(0, widgetPos) : partial;
          visible = stripThinkingTags(visible)
            .replace(/<affection[\s\S]*$/i, '')
            .replace(/<memory[\s\S]*$/i, '')
            .replace(/<runtime.state[\s\S]*$/i, '')
            .replace(/<image[\s\S]*$/i, '')
            .replace(/<board[\s\S]*$/i, '')
            .replace(/<affection\b[^>]*?\/?>(?:<\/affection>)?/gi, '')
            .replace(/<memory\b[^>]*?\/?>(?:<\/memory>)?/gi, '')
            .replace(/<state\b[^>]*?\/?>(?:<\/state>)?/gi, '')
            .replace(/<image\b[^>]*?\/?>(?:<\/image>)?/gi, '')
            .replace(/<board\b[^>]*?\/?>(?:<\/board>)?/gi, '')
            .replace(/\|\|\|/g, '\n');

          if (widgetPos >= 0) {
            setTyping(true, `${runtime.state.settings.name}正在为你现做小组件`);
          }
          if (runtime.state.settings.chatMode !== 'story') {
            visible = stripStageDirections(visible, true);
          }
          if (visible.trim()) {
            const row = ensureStreamRow();
            row.querySelector('.bubble').textContent = visible.trim();
            scrollChatBottom();
          }
        }, isEvent, hasImage);
      } else {
        raw = await callDemoEngine(userText, isEvent, hasImage);
      }

      if (streamPreviewRow) {
        streamPreviewRow.remove();
        streamPreviewRow = null;
      }

      const { bubbles, newWidgets, newImages, boardOps } = parseAssistantOutput(raw);
      if (boardOps?.length && ui.applyBoardOperations?.(boardOps)) {
        if (runtime.currentPage === 0) boardDot.classList.add('show');
      }
      const mountedWidgets = [];

      if (newWidgets.length) {
        newWidgets.forEach(w => {
          const targetName = (w.replace || '').trim().replace(/[「」]/g, '');
          let existingIdx = -1;
          if (targetName) {
            existingIdx = runtime.state.widgets.findIndex(item => item.title.trim() === targetName);
            if (existingIdx < 0) {
              existingIdx = runtime.state.widgets.findIndex(item => {
                const t = item.title.trim();
                return t.includes(targetName) || targetName.includes(t);
              });
            }
          } else {
            existingIdx = runtime.state.widgets.findIndex(item => item.title.trim() === w.title.trim());
          }
          if (existingIdx >= 0) {
            const existing = runtime.state.widgets[existingIdx];
            existing.title = w.title || existing.title;
            existing.html = w.html;
            existing.height = w.height;
            mountedWidgets.push({ id: existing.id, title: existing.title, updated: true });
          } else {
            runtime.state.widgets.unshift({
              id: w.id,
              title: w.title,
              height: w.height,
              createdAt: w.createdAt,
              html: w.html
            });
            mountedWidgets.push({ id: w.id, title: w.title, updated: false });
          }
        });
        ui.renderWidgets?.();
        if (runtime.currentPage === 0) boardDot.classList.add('show');
      }

      const finalBubbles = bubbles.length
        ? bubbles
        : (mountedWidgets.length ? [`好啦，已经帮你摆在「${runtime.state.settings.name || '我'}的家」里咯～`] : (newImages.length ? [] : ['嗯？刚刚走神了，再跟我说一遍？']));

      for (let i = 0; i < finalBubbles.length; i++) {
        if (runtime.replyAbortRequested) break;
        if (i > 0) {
          setTyping(true, `${runtime.state.settings.name}正在输入`);
          await sleep(380 + Math.min(460, finalBubbles[i].length * 14));
          if (runtime.replyAbortRequested) break;
        }
        setTyping(false);
        appendChatMessage({ role: 'assistant', text: finalBubbles[i] });
        scheduleSave();
        if (i === 0) showFloatingBanner(finalBubbles[i]);
      }

      if (runtime.replyAbortRequested) {
        appendChatMessage({ role: 'event', text: '已停止本次生成' });
      } else if (newImages.length && isImageGenReady()) {
        setTyping(false);
        const lastImg = findLastChatImage(targetCharId);
        for (const imgReq of newImages) {
          const placeholderId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          appendChatMessage({
            id: placeholderId,
            role: 'assistant',
            imgPending: true,
            aspectRatio: aspectRatioFromSize(imgReq.size),
            createdAt: Date.now()
          });
          enqueueImageTask({
            charId: targetCharId,
            placeholderId,
            prompt: imgReq.prompt,
            size: imgReq.size,
            refImg: imgReq.ref === 'last' ? lastImg : ''
          });
        }
      }

      mountedWidgets.forEach(w => {
        appendChatMessage({ role: 'spawn', widgetId: w.id, title: w.title, updated: w.updated });
      });

      scheduleSave();
      renderHeader();
      if (hasKey) maybeCompressHistory(false, () => ui.updateMemStats?.());
    } catch (err) {
      if (streamPreviewRow) {
        streamPreviewRow.remove();
        streamPreviewRow = null;
      }
      setTyping(false);
      if (err.name === 'AbortError') {
        appendChatMessage({ role: 'event', text: '已停止本次生成' });
      } else if (err.isVisionNotice) {
        appendChatMessage({ role: 'assistant', text: err.message });
      } else {
        appendChatMessage({
          role: 'assistant',
          text: `哎呀，接口连不上（${err.message}）。请检查右上角设置里的 Base URL、Model 或 API Key。`
        });
      }
      scheduleSave();
    } finally {
      clearTimeout(slowHintTimer);
      runtime.activeAbortController = null;
      setTyping(false);
      runtime.isBusy = false;
      sendBtn.innerHTML = SEND_SVG;
      sendBtn.classList.remove('stop');
      sendBtn.setAttribute('aria-label', '发送');
      if (runtime.pendingEventQueue.length && runtime.state.settings.autoReact) {
        clearTimeout(runtime.eventFlushTimer);
        runtime.eventFlushTimer = setTimeout(ui.flushWidgetEvents, 300);
      }
    }
  }

  const pickImgBtn = document.getElementById('pickImgBtn');
  const imgFileInput = document.getElementById('imgFileInput');
  const imgPreviewBar = document.getElementById('imgPreviewBar');
  const imgPreviewThumb = document.getElementById('imgPreviewThumb');
  const imgPreviewMeta = document.getElementById('imgPreviewMeta');
  const imgLightbox = document.getElementById('imgLightbox');
  let pendingImageUrl = '';

  function updateVisionBtnState() {
    const blocked = Boolean(runtime.state.settings.apiKey.trim()) && isModelMarkedNonVision(runtime.state.settings.model);
    pickImgBtn.classList.toggle('unsupported', blocked);
    pickImgBtn.title = blocked ? `当前模型「${runtime.state.settings.model}」不支持识图` : '发送图片';
  }

  function clearPendingImage() {
    pendingImageUrl = '';
    imgFileInput.value = '';
    imgPreviewBar.classList.remove('show');
    imgPreviewThumb.removeAttribute('src');
  }

  pickImgBtn.onclick = () => {
    if (runtime.isBusy) return;
    if (runtime.state.settings.apiKey.trim() && isModelMarkedNonVision(runtime.state.settings.model)) {
      showWarn(`当前模型「${runtime.state.settings.model}」暂不支持识图，请在右上角设置更换支持视觉的模型`, true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2800);
      return;
    }
    imgFileInput.click();
  };

  imgFileInput.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await compressImageFile(file);
      pendingImageUrl = res.dataUrl;
      imgPreviewThumb.src = res.dataUrl;
      imgPreviewMeta.textContent = `已压缩至 ${res.width}×${res.height}（约 ${res.kb} KB）`;
      imgPreviewBar.classList.add('show');
      chatInput.focus();
    } catch (err) {
      showWarn(err.message);
      clearPendingImage();
    }
  };
  document.getElementById('clearImgBtn').onclick = clearPendingImage;
  imgLightbox.onclick = () => imgLightbox.classList.remove('show');
  document.getElementById('lightboxActions').onclick = e => e.stopPropagation();

  document.getElementById('lightboxSaveBtn').onclick = async e => {
    e.stopPropagation();
    const src = currentLightboxSrc || document.getElementById('imgLightboxSrc').src;
    if (!src) return;
    const isPng = src.startsWith('data:image/png');
    const isWebp = src.startsWith('data:image/webp');
    const ext = isPng ? 'png' : (isWebp ? 'webp' : 'jpg');
    const fileName = `roomi-${Date.now()}.${ext}`;
    const fs = window.Capacitor?.Plugins?.Filesystem;
    if (fs?.writeFile && src.startsWith('data:')) {
      const base64Data = src.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      try {
        await fs.writeFile({ path: `Pictures/Roomi/${fileName}`, data: base64Data, directory: 'EXTERNAL_STORAGE', recursive: true });
        showWarn(`✓ 原图已保存到相册 Pictures/Roomi/${fileName}`, true);
        setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2500);
        return;
      } catch {
        try {
          await fs.writeFile({ path: `Roomi/${fileName}`, data: base64Data, directory: 'DOCUMENTS', recursive: true });
          showWarn(`✓ 原图已保存到文档 Roomi/${fileName}`, true);
          setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2500);
          return;
        } catch {}
      }
    }
    const a = document.createElement('a');
    a.href = src;
    a.download = fileName;
    a.click();
    showWarn('✓ 已触发原图保存', true);
    setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2000);
  };

  document.getElementById('lightboxAvatarBtn').onclick = async e => {
    e.stopPropagation();
    const src = currentLightboxSrc || document.getElementById('imgLightboxSrc').src;
    if (!src) return;
    try {
      const avUrl = await compressImageSrcToJpeg(src, 256, 0.88);
      runtime.state.settings.avatarImage = avUrl;
      ui.setDraftAvatarImage?.(avUrl);
      flushActiveCharToList();
      scheduleSave();
      renderHeader();
      renderChat();
      ui.renderCharacterBar?.();
      imgLightbox.classList.remove('show');
      showWarn(`✓ 已设为「${runtime.state.settings.name || '伴侣'}」的新头像`, true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 2200);
    } catch (err) {
      showWarn(`设为头像失败：${err.message || '图片跨域受限'}`);
    }
  };

  const lightboxJumpBtn = document.getElementById('lightboxJumpBtn');
  if (lightboxJumpBtn) {
    lightboxJumpBtn.onclick = e => {
      e.stopPropagation();
      const targetId = currentLightboxMsgId;
      imgLightbox.classList.remove('show');
      if (targetId) jumpToMessage(targetId);
    };
  }

  let pendingQuote = null;
  let sendMergeTimer = null;
  let pendingBurstTexts = [];
  let pendingBurstHasImg = false;
  const quotePreviewBar = document.getElementById('quotePreviewBar');
  const quotePreviewText = document.getElementById('quotePreviewText');

  function clearPendingQuote() {
    pendingQuote = null;
    if (quotePreviewBar) quotePreviewBar.classList.remove('show');
  }

  function setPendingQuote(m) {
    if (!m) return;
    const who = m.role === 'user' ? '我' : (runtime.state.settings.name || 'TA');
    const raw = m.image && !m.text ? '[图片]' : String(m.text || '').replace(/\s+/g, ' ').trim();
    const preview = raw.slice(0, 60) + (raw.length > 60 ? '…' : '');
    pendingQuote = { id: m.id || '', who, preview: preview || '[消息]' };
    if (quotePreviewText) quotePreviewText.textContent = `回复 ${who}：${pendingQuote.preview}`;
    if (quotePreviewBar) quotePreviewBar.classList.add('show');
    chatInput.focus();
  }

  function cancelPendingSendBurst() {
    clearTimeout(sendMergeTimer);
    sendMergeTimer = null;
    pendingBurstTexts = [];
    pendingBurstHasImg = false;
  }

  const clearQuoteBtn = document.getElementById('clearQuoteBtn');
  if (clearQuoteBtn) clearQuoteBtn.onclick = clearPendingQuote;

  function flushSendBurst() {
    sendMergeTimer = null;
    if (!pendingBurstTexts.length) return;
    if (runtime.isBusy) {
      // Wait for current turn to finish instead of dropping queued messages
      sendMergeTimer = setTimeout(flushSendBurst, 320);
      return;
    }
    const merged = pendingBurstTexts.join('\n').trim();
    const hasImg = pendingBurstHasImg;
    pendingBurstTexts = [];
    pendingBurstHasImg = false;
    triggerCompanionReply(merged, false, hasImg);
  }

  function handleSend(overrideText) {
    if (runtime.isBusy) {
      runtime.replyAbortRequested = true;
      if (runtime.activeAbortController) runtime.activeAbortController.abort();
      cancelPendingSendBurst();
      return;
    }
    const text = (overrideText ?? chatInput.value).trim();
    const image = overrideText ? '' : pendingImageUrl;
    if (!text && !image) return;
    const quote = overrideText ? null : pendingQuote;

    chatInput.value = '';
    chatInput.style.height = '34px';
    if (image) clearPendingImage();
    if (quote) clearPendingQuote();

    appendChatMessage({ role: 'user', text, image: image || undefined, replyTo: quote || undefined });
    scheduleSave();

    if (!overrideText && runtime.state.settings.debounceSend) {
      pendingBurstTexts.push(text || (image ? '[发来一张图片]' : ''));
      pendingBurstHasImg = pendingBurstHasImg || Boolean(image);
      clearTimeout(sendMergeTimer);
      sendMergeTimer = setTimeout(flushSendBurst, 1800);
      return;
    }

    if (pendingBurstTexts.length) {
      pendingBurstTexts.push(text || (image ? '[发来一张图片]' : ''));
      const merged = pendingBurstTexts.join('\n').trim();
      const hasImg = pendingBurstHasImg || Boolean(image);
      cancelPendingSendBurst();
      triggerCompanionReply(merged, false, hasImg);
      return;
    }

    cancelPendingSendBurst();
    triggerCompanionReply(text, false, Boolean(image));
  }

  const stickerDrawer = document.getElementById('stickerDrawer');
  const stickerGrid = document.getElementById('stickerGrid');
  const pickStickerBtn = document.getElementById('pickStickerBtn');
  const stickerFileInput = document.getElementById('stickerFileInput');

  function sendUserSticker({ stickerId = '', stickerImg = '', stickerLabel = '贴纸' }) {
    if (runtime.isBusy) return;
    if (stickerDrawer) stickerDrawer.classList.remove('show');
    const quote = pendingQuote;
    if (quote) clearPendingQuote();
    appendChatMessage({
      role: 'user',
      text: '',
      stickerId: stickerId || undefined,
      stickerImg: stickerImg || undefined,
      stickerLabel,
      replyTo: quote || undefined
    });
    scheduleSave();
    if (runtime.state.settings.debounceSend) {
      pendingBurstTexts.push(`[发送了表情包：${stickerLabel}]`);
      clearTimeout(sendMergeTimer);
      sendMergeTimer = setTimeout(flushSendBurst, 1800);
      return;
    }
    triggerCompanionReply(`[用户发送了表情包：${stickerLabel}]`, false, false);
  }

  function renderStickerDrawer() {
    if (!stickerGrid) return;
    stickerGrid.innerHTML = '';
    BUILTIN_STICKERS.forEach(st => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'sticker-cell';
      cell.innerHTML = `${buildStickerSvg(st)}<span>${escapeHtml(st.label)}</span>`;
      cell.onclick = () => sendUserSticker({ stickerId: st.id, stickerLabel: st.label });
      stickerGrid.appendChild(cell);
    });
    const customs = Array.isArray(runtime.state.stickers) ? runtime.state.stickers : [];
    customs.forEach((st, idx) => {
      const cell = document.createElement('div');
      cell.className = 'sticker-cell';
      const img = document.createElement('img');
      img.src = st.dataUrl;
      img.alt = st.label || '表情';
      const lbl = document.createElement('span');
      lbl.textContent = st.label || '自定义';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sticker-del-badge';
      del.textContent = '✕';
      del.onclick = ev => {
        ev.stopPropagation();
        runtime.state.stickers.splice(idx, 1);
        scheduleSave();
        renderStickerDrawer();
      };
      cell.appendChild(img);
      cell.appendChild(lbl);
      cell.appendChild(del);
      cell.onclick = () => sendUserSticker({ stickerImg: st.dataUrl, stickerLabel: st.label || '自定义表情' });
      stickerGrid.appendChild(cell);
    });
  }

  if (pickStickerBtn && stickerDrawer) {
    pickStickerBtn.onclick = e => {
      e.stopPropagation();
      if (selectMode) return;
      renderStickerDrawer();
      stickerDrawer.classList.toggle('show');
    };
  }
  const closeStickerDrawerBtn = document.getElementById('closeStickerDrawerBtn');
  if (closeStickerDrawerBtn && stickerDrawer) {
    closeStickerDrawerBtn.onclick = () => stickerDrawer.classList.remove('show');
  }
  const addCustomStickerBtn = document.getElementById('addCustomStickerBtn');
  if (addCustomStickerBtn && stickerFileInput) {
    addCustomStickerBtn.onclick = () => stickerFileInput.click();
    stickerFileInput.onchange = async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const res = await compressImageFile(file, 220, 0.85);
        if (!Array.isArray(runtime.state.stickers)) runtime.state.stickers = [];
        const label = (file.name || '').replace(/\.[^.]+$/, '').slice(0, 8) || '表情';
        runtime.state.stickers.unshift({ id: 'stk_' + Date.now(), label, dataUrl: res.dataUrl });
        if (runtime.state.stickers.length > 24) runtime.state.stickers.length = 24;
        scheduleSave();
        renderStickerDrawer();
      } catch (err) {
        showWarn(err.message);
      } finally {
        stickerFileInput.value = '';
      }
    };
  }

  sendBtn.addEventListener('click', () => handleSend());
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = '34px';
    chatInput.style.height = Math.max(34, Math.min(chatInput.scrollHeight, 112)) + 'px';
  });

  const storyToggleBtn = document.getElementById('storyToggleBtn');
  function syncChatModeQuickBtn() {
    if (storyToggleBtn) {
      storyToggleBtn.classList.toggle('active', runtime.state.settings.chatMode === 'story');
    }
  }

  storyToggleBtn.onclick = e => {
    e.stopPropagation();
    if (runtime.isBusy) return;
    const nextStory = runtime.state.settings.chatMode !== 'story';
    runtime.state.settings.chatMode = nextStory ? 'story' : 'wechat';
    ui.setDraftChatMode?.(runtime.state.settings.chatMode);
    runtime.personaShiftPending = true;
    flushActiveCharToList();
    scheduleSave();
    syncChatModeQuickBtn();
    ui.syncChatModePickerUI?.();
    showWarn(nextStory ? '🎭 已开启小剧场模式（带神态动作描写）' : '已切回默认自然聊天', true);
    setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1800);
  };

  const archiveModal = document.getElementById('archiveModal');
  const archiveModalTitle = document.getElementById('archiveModalTitle');
  const archiveSearchInput = document.getElementById('archiveSearchInput');
  const archiveSearchClearBtn = document.getElementById('archiveSearchClearBtn');
  const archiveSearchList = document.getElementById('archiveSearchList');
  const favListEl = document.getElementById('favList');
  const favCountEl = document.getElementById('favCount');
  const galleryGrid = document.getElementById('galleryGrid');
  const galleryCountEl = document.getElementById('galleryCount');

  function formatShortDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderArchiveSearch() {
    if (!archiveSearchList) return;
    const q = (archiveSearchInput?.value || '').trim().toLowerCase();
    if (archiveSearchClearBtn) archiveSearchClearBtn.classList.toggle('show', Boolean(q));
    const name = runtime.state.settings.name || '伴侣';
    const matches = [];
    for (let i = runtime.state.messages.length - 1; i >= 0; i--) {
      const m = runtime.state.messages[i];
      if (!m || m.imgPending || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const txt = String(m.text || '').trim();
      if (!txt) continue;
      if (!q || txt.toLowerCase().includes(q)) {
        matches.push({ m, idx: i, txt });
        if (matches.length >= (q ? 60 : 25)) break;
      }
    }
    archiveSearchList.innerHTML = '';
    if (!matches.length) {
      archiveSearchList.innerHTML = `<div class="empty-note">${q ? `没有找到包含「${escapeHtml(q)}」的记录` : '还没有可检索的聊天文字记录'}</div>`;
      return;
    }
    matches.forEach(({ m, idx, txt }) => {
      const item = document.createElement('div');
      item.className = 'archive-hit';
      const who = m.role === 'user' ? '我' : name;
      let htmlSnippet = '';
      if (q) {
        const pos = txt.toLowerCase().indexOf(q);
        const start = Math.max(0, pos - 18);
        const end = Math.min(txt.length, pos + q.length + 34);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < txt.length ? '…' : '';
        const before = escapeHtml(txt.slice(start, pos));
        const hit = escapeHtml(txt.slice(pos, pos + q.length));
        const after = escapeHtml(txt.slice(pos + q.length, end));
        htmlSnippet = `${prefix}${before}<mark>${hit}</mark>${after}${suffix}`;
      } else {
        htmlSnippet = escapeHtml(txt.slice(0, 72) + (txt.length > 72 ? '…' : ''));
      }
      item.innerHTML = `
        <div class="archive-hit-meta">
          <span class="archive-hit-who"><span class="archive-hit-dot ${m.role === 'user' ? 'me' : ''}"></span>${escapeHtml(who)}</span>
          <span>${formatShortDateTime(m.createdAt)}</span>
        </div>
        <div class="archive-hit-body">${htmlSnippet}</div>`;
      item.onclick = () => {
        archiveModal.classList.remove('show');
        ui.switchPage?.(0);
        jumpToMessage(m.id || '', idx);
      };
      archiveSearchList.appendChild(item);
    });
  }

  function renderFavoritesTab() {
    if (!favListEl) return;
    const list = Array.isArray(runtime.state.favorites) ? runtime.state.favorites : [];
    if (favCountEl) favCountEl.textContent = list.length ? `(${list.length})` : '';
    favListEl.innerHTML = '';
    if (!list.length) {
      favListEl.innerHTML = '<div class="empty-note">还没有心动收藏哦～<br/>在聊天里点任一气泡上的「☆ 收藏」，就能收进这里。</div>';
      return;
    }
    list.forEach((f, idx) => {
      const card = document.createElement('div');
      card.className = 'fav-card';
      card.innerHTML = `
        <div class="fav-card-quote">${escapeHtml(f.text)}</div>
        <div class="fav-card-foot">
          <span>${escapeHtml(f.who || 'TA')} · ${formatShortDateTime(f.msgCreatedAt || f.savedAt)}</span>
          <div class="fav-card-ops">
            <button type="button" class="mini-btn" data-fav="copy">复制</button>
            ${f.msgId ? '<button type="button" class="mini-btn" data-fav="jump">定位</button>' : ''}
            <button type="button" class="mini-btn danger" data-fav="del">移出</button>
          </div>
        </div>`;
      card.querySelector('[data-fav="copy"]').onclick = async () => {
        if (await copyText(f.text)) {
          showWarn('已复制收藏内容', true);
          setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 1400);
        }
      };
      const jumpBtn = card.querySelector('[data-fav="jump"]');
      if (jumpBtn) {
        jumpBtn.onclick = () => {
          archiveModal.classList.remove('show');
          ui.switchPage?.(0);
          jumpToMessage(f.msgId);
        };
      }
      card.querySelector('[data-fav="del"]').onclick = () => {
        runtime.state.favorites.splice(idx, 1);
        scheduleSave();
        renderFavoritesTab();
      };
      favListEl.appendChild(card);
    });
  }

  function renderGalleryTab() {
    if (!galleryGrid) return;
    const imgs = [];
    for (let i = runtime.state.messages.length - 1; i >= 0; i--) {
      const m = runtime.state.messages[i];
      if (m && m.image && !m.imgPending) imgs.push(m);
    }
    if (galleryCountEl) galleryCountEl.textContent = imgs.length ? `(${imgs.length})` : '';
    galleryGrid.innerHTML = '';
    if (!imgs.length) {
      galleryGrid.innerHTML = '<div class="empty-note" style="grid-column:1 / -1;">还没有收发过照片哦，可以让 TA 拍照或用左下角相册发图～</div>';
      return;
    }
    imgs.forEach(m => {
      const tile = document.createElement('div');
      tile.className = 'gallery-tile';
      const img = document.createElement('img');
      img.src = m.image;
      img.alt = m.text || '照片';
      img.loading = 'lazy';
      const tag = document.createElement('div');
      tag.className = 'gallery-tag';
      tag.textContent = `${m.role === 'user' ? '我' : (runtime.state.settings.name || 'TA')} · ${formatShortDateTime(m.createdAt) || '照片'}`;
      tile.appendChild(img);
      tile.appendChild(tag);
      tile.onclick = () => {
        archiveModal.classList.remove('show');
        openLightboxWithImage(m.image, m.id || '');
      };
      galleryGrid.appendChild(tile);
    });
  }

  function switchArchiveTab(tabName) {
    document.querySelectorAll('#archiveTabBar [data-arch-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.archTab === tabName);
    });
    document.querySelectorAll('#archiveModal [data-arch-pane]').forEach(pane => {
      pane.classList.toggle('active', pane.dataset.archPane === tabName);
    });
    if (tabName === 'gallery') {
      renderGalleryTab();
    } else if (tabName === 'favorites') {
      renderFavoritesTab();
    } else {
      renderArchiveSearch();
      setTimeout(() => archiveSearchInput && archiveSearchInput.focus(), 80);
    }
  }

  function openArchiveModal(tabName = 'search') {
    if (!archiveModal) return;
    const name = runtime.state.settings.name || '伴侣';
    if (archiveModalTitle) archiveModalTitle.textContent = `${name} · 记录与收藏`;
    if (archiveSearchInput) archiveSearchInput.value = '';
    const totalImgs = runtime.state.messages.filter(m => m && m.image && !m.imgPending).length;
    if (galleryCountEl) galleryCountEl.textContent = totalImgs ? `(${totalImgs})` : '';
    const totalFavs = Array.isArray(runtime.state.favorites) ? runtime.state.favorites.length : 0;
    if (favCountEl) favCountEl.textContent = totalFavs ? `(${totalFavs})` : '';
    archiveModal.classList.add('show');
    switchArchiveTab(tabName);
  }

  const searchChatBtn = document.getElementById('searchChatBtn');
  if (searchChatBtn) searchChatBtn.onclick = () => openArchiveModal('search');
  const openGalleryBtn = document.getElementById('openGalleryBtn');
  if (openGalleryBtn) openGalleryBtn.onclick = () => openArchiveModal('gallery');
  const closeArchiveBtn = document.getElementById('closeArchiveBtn');
  if (closeArchiveBtn) closeArchiveBtn.onclick = () => archiveModal.classList.remove('show');
  if (archiveModal) {
    archiveModal.addEventListener('click', e => {
      if (e.target === archiveModal) archiveModal.classList.remove('show');
    });
  }
  document.querySelectorAll('#archiveTabBar [data-arch-tab]').forEach(btn => {
    btn.onclick = () => switchArchiveTab(btn.dataset.archTab || 'search');
  });
  if (archiveSearchInput) archiveSearchInput.oninput = renderArchiveSearch;
  if (archiveSearchClearBtn) {
    archiveSearchClearBtn.onclick = () => {
      if (archiveSearchInput) {
        archiveSearchInput.value = '';
        archiveSearchInput.focus();
      }
      renderArchiveSearch();
    };
  }

  const scrollBottomBtn = document.getElementById('scrollBottomBtn');
  chatScroll.addEventListener('scroll', () => {
    const dist = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight;
    scrollBottomBtn.classList.toggle('show', dist > 240);
  }, { passive: true });
  scrollBottomBtn.onclick = () => {
    chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: 'smooth' });
  };

  document.getElementById('quickBar').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip && chip.dataset.prompt && !runtime.isBusy) handleSend(chip.dataset.prompt);
  });

  runtime.onVisionCompatChange = updateVisionBtnState;
  bindImageGenHooks({
    createMsgRowElement,
    renderHeader,
    showFloatingBanner
  });

  registerUI({
    applyAvatarToEl,
    renderHeader,
    renderChat,
    appendChatMessage,
    scrollChatBottom,
    setTyping,
    showFloatingBanner,
    triggerCompanionReply,
    handleSend,
    syncChatModeQuickBtn,
    updateVisionBtnState,
    exitSelectMode,
    cancelPendingSendBurst,
    clearPendingQuote,
    closeStickerDrawer: () => stickerDrawer && stickerDrawer.classList.remove('show'),
    isSelectMode: () => selectMode
  });
}
