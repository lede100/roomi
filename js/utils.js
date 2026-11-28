export function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

export async function openExternalUrl(url) {
  const browser = window.Capacitor?.Plugins?.Browser;
  if (browser?.open) {
    try {
      await browser.open({ url });
      return;
    } catch {}
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function copyText(str) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(str);
      return true;
    } catch {}
  }
  const ta = document.createElement('textarea');
  ta.value = str;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

export function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const externalSignal = options.signal || null;
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      fn(val);
    };
    const onExternalAbort = () => {
      try { controller.abort(); } catch {}
      const err = new Error('已取消请求');
      err.name = 'AbortError';
      finish(reject, err);
    };
    if (externalSignal?.aborted) {
      onExternalAbort();
      return;
    }
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      try { controller.abort(); } catch {}
      const err = new Error(`请求超时（已等待 ${Math.round(timeoutMs / 1000)} 秒），请重试`);
      err.name = 'TimeoutError';
      err.isTimeout = true;
      finish(reject, err);
    }, timeoutMs);
    fetch(url, { ...options, signal: controller.signal }).then(
      res => finish(resolve, res),
      err => finish(reject, err)
    );
  });
}

export function formatShortDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatChatDividerTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const dayStart = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diffDays === 0) return hhmm;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

export function shouldShowTimeDivider(prevTs, nextTs) {
  if (!nextTs) return false;
  if (!prevTs) return true;
  if (nextTs - prevTs > 5 * 60 * 1000) return true;
  const a = new Date(prevTs), b = new Date(nextTs);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

export function formatCompactTimeAnchor(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const dayStart = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const dayDiff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  const dayLabel = dayDiff === 0 ? '今天' : (dayDiff === 1 ? '昨天' : (dayDiff === 2 ? '前天' : `${d.getMonth() + 1}-${d.getDate()}`));
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const period = h < 5 ? '深夜' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  return `${dayLabel} ${String(h).padStart(2, '0')}:${min} ${period}`;
}

export function cnNumToInt(str) {
  const map = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '廿': 20, '卅': 30 };
  const s = String(str || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1 && map[s] !== undefined) return map[s];
  if (s.startsWith('十') && s.length === 2 && map[s[1]] !== undefined) return 10 + map[s[1]];
  if (s.startsWith('廿') && s.length === 2 && map[s[1]] !== undefined) return 20 + map[s[1]];
  if (s.startsWith('卅') && s.length === 2 && map[s[1]] !== undefined) return 30 + map[s[1]];
  if (s.length >= 2 && map[s[0]] !== undefined && s[1] === '十') {
    return map[s[0]] * 10 + (s[2] && map[s[2]] !== undefined ? map[s[2]] : 0);
  }
  return 0;
}

export function parseHourMin(hhmm, defH, defM) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return { hour: defH, minute: defM };
  return {
    hour: Math.max(0, Math.min(23, Number(m[1]))),
    minute: Math.max(0, Math.min(59, Number(m[2])))
  };
}

export function compressImageFile(file, maxSide = 1024, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片格式暂不支持解析'));
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w >= h) {
            h = Math.round((h * maxSide) / w);
            w = maxSide;
          } else {
            w = Math.round((w * maxSide) / h);
            h = maxSide;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ dataUrl, width: w, height: h, kb: Math.round((dataUrl.length * 3) / 4 / 1024) });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function compressImageSrcToJpeg(srcUrl, maxSide = 2560, quality = 0.94) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!srcUrl.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error('图片解码失败'));
    img.onload = () => {
      try {
        let w = img.width || 1024;
        let h = img.height || 1024;
        if (w > maxSide || h > maxSide) {
          if (w >= h) {
            h = Math.round((h * maxSide) / w);
            w = maxSide;
          } else {
            w = Math.round((w * maxSide) / h);
            h = maxSide;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      }
    };
    img.src = srcUrl;
  });
}

export async function extractCharaFromPng(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (bytes.length < 16 || !sig.every((b, i) => bytes[i] === b)) {
    throw new Error('不是有效的 PNG 图片');
  }
  const dv = new DataView(buf);
  const dec = new TextDecoder('utf-8');
  let offset = 8;
  let rawPayload = '';
  while (offset + 12 <= bytes.length) {
    const len = dv.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > bytes.length) break;
    if (type === 'tEXt' || type === 'iTXt') {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul > 0) {
        const kw = dec.decode(chunk.subarray(0, nul)).toLowerCase();
        if (kw === 'chara' || kw === 'ccv3') {
          if (type === 'tEXt') {
            rawPayload = dec.decode(chunk.subarray(nul + 1));
          } else {
            // iTXt layout: kw \0 compFlag \0 compMethod \0 lang \0 transKw \0 text
            const compFlag = chunk[nul + 1];
            let p = nul + 3;
            const z1 = chunk.indexOf(0, p);
            if (z1 !== -1) {
              const z2 = chunk.indexOf(0, z1 + 1);
              if (z2 !== -1) {
                const payloadBytes = chunk.subarray(z2 + 1);
                if (compFlag === 0) {
                  rawPayload = dec.decode(payloadBytes);
                } else if (compFlag === 1 && typeof DecompressionStream !== 'undefined') {
                  const ds = new DecompressionStream('deflate');
                  const decompressed = await new Response(new Blob([payloadBytes]).stream().pipeThrough(ds)).arrayBuffer();
                  rawPayload = dec.decode(new Uint8Array(decompressed));
                }
              }
            }
          }
          if (rawPayload) break;
        }
      }
    }
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (!rawPayload) {
    throw new Error('这张 PNG 里没有发现 SillyTavern 角色卡信息（chara）');
  }
  const cleanB64 = rawPayload.replace(/\s+/g, '');
  const binStr = atob(cleanB64);
  const utfBytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) utfBytes[i] = binStr.charCodeAt(i);
  return JSON.parse(dec.decode(utfBytes));
}

export function normalizeImportedCardData(parsed, fallbackAvatar = '') {
  const root = parsed?._type === 'roomi_character_card' ? parsed : (parsed?.data || parsed?.character || parsed);
  if (!root || !root.name) throw new Error('角色卡缺少角色名称（name）');
  const personaParts = [];
  if (root.persona) {
    personaParts.push(root.persona);
  } else {
    if (root.description) personaParts.push(root.description);
    if (root.personality) personaParts.push(`性格特征：${root.personality}`);
    if (root.scenario) personaParts.push(`互动背景：${root.scenario}`);
    if (root.mes_example) personaParts.push(`说话参考：\n${String(root.mes_example).slice(0, 360)}`);
  }
  const persona = personaParts.filter(Boolean).join('\n\n').trim();
  if (!persona) throw new Error('角色卡缺少人设描述（persona/description）');
  const greetingsRaw = [];
  if (Array.isArray(root.greeting)) greetingsRaw.push(...root.greeting);
  else if (typeof root.greeting === 'string' && root.greeting) greetingsRaw.push(root.greeting);
  if (typeof root.first_mes === 'string' && root.first_mes) greetingsRaw.push(root.first_mes);
  if (Array.isArray(root.alternate_greetings)) greetingsRaw.push(...root.alternate_greetings);
  const greetings = [...new Set(greetingsRaw.map(g => String(g || '').trim()).filter(Boolean))];
  return {
    name: root.name,
    age: root.age || '',
    gender: root.gender || '',
    chatMode: root.chatMode || 'wechat',
    persona,
    anchors: root.anchors || '',
    sampleDialogue: root.sampleDialogue || (root.mes_example ? String(root.mes_example).slice(0, 320) : ''),
    appearance: root.appearance || '',
    avatarImage: root.avatarImage || fallbackAvatar || '',
    wallpaper: root.wallpaper || '',
    avatarColor: root.avatarColor || '',
    greeting: greetings
  };
}
