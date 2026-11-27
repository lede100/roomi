import { runtime, scheduleSave, showWarn } from './state.js';
import { sleep, escapeHtml, fetchWithTimeout, compressImageSrcToJpeg } from './utils.js';

const _hooks = {};
export function bindImageGenHooks(hooks) {
  Object.assign(_hooks, hooks);
}

export function isImageGenReady() {
  const p = runtime.state.settings.imgProvider || 'off';
  if (p === 'modelscope') {
    return Boolean((runtime.state.settings.imgApiKey || '').trim());
  }
  if (p === 'openai') {
    const key = (runtime.state.settings.imgApiKey || runtime.state.settings.apiKey || '').trim();
    const base = (runtime.state.settings.imgBaseUrl || runtime.state.settings.baseUrl || '').trim();
    const model = (runtime.state.settings.openaiImgModel || runtime.state.settings.imgModel || '').trim();
    return Boolean(key && base && model);
  }
  return false;
}

export function getImagePromptSection() {
  if (!runtime.state.settings.apiKey.trim() || !isImageGenReady()) return '';
  const isAuto = runtime.state.settings.imgTrigger === 'auto';
  const isModelScope = runtime.state.settings.imgProvider === 'modelscope';
  const canEdit = isModelScope || runtime.state.settings.imgProvider === 'openai';
  const defSize = normalizeImageSize(runtime.state.settings.imgDefaultSize || '1152x1536');
  const promptPolicy = isModelScope
    ? 'prompt 避开露骨敏感词。'
    : '当前接入用户自配 OpenAI 兼容生图接口，客户端不做任何尺度或题材限制，请严格按用户要求的画面构图、服饰、姿态与细节如实完整写入 prompt，勿自行回避或删改。';
  return `

【拍照 / 发照片能力】
${isAuto ? '你可以在聊到日常画面、分享穿搭风景、自拍或气氛刚好时自然配图，也可按用户要求拍照或画图。' : '平时不要主动发图；仅在用户明确让你拍照、发照片、画图或修图/改图时才生图。'}
需要发图时，先用 1~2 句自然口语接话，然后在回复末尾附带隐藏标签（只有输出该标签系统才会真正生成并发送图片）：
拍照意图判定：用户说“拍照、拍一张、拍吧、看看你照片、发照片”都是立即输出 <IMAGE> 标签发图，不是光在正文里演拍照；用户说“拍吧、好、拍”这种短确认，就是确认上一句要图，必须输出 <IMAGE> 标签，别继续光说不发。
<IMAGE prompt="详细的中文或英文画面描述；若出现东亚人物请明确写出东亚/中国年轻女性或男性、真实摄影质感、光线和构图" size="${defSize}" />
${canEdit ? '改图/新图判定规则：当用户明确说基于上一张图“改一下、换装、换背景、P一下”时，必须附带 ref="last"，并在 prompt 里写明保持原图人物五官/主体不变、只修改指定部分；当用户说“拍一张、画一张、重拍、再来一张”时，严禁附带 ref="last"，直接全新画新画面。' : ''}
prompt 写法铁律（非常重要）：
- 写 prompt 必须只写正面视觉描述，把一切否定词直接改写成对应的正面词汇（例如：“不穿衣服”写成“裸体”，“不高兴”写成“生气”，“没戴眼镜”写成“双眼素颜清晰”），整段 prompt 里绝对不要留“不”字或任何否定表达；
- 不要添加 negative 属性（后端固定 cfg 1.0，负向词无效）；
- 严禁在正文里自己写“[已发送一张照片]”或“正在画图中/正在为你生成图片”假装发图，每次要发图必须真实输出 <IMAGE .../> 标签；${promptPolicy}`;
}

export function normalizeImageSize(rawSize) {
  const fallback = String(runtime.state?.settings?.imgDefaultSize || '1152x1536').toLowerCase().replace(/\*/g, 'x').trim();
  const clean = String(rawSize || fallback || '1152x1536').toLowerCase().replace(/\*/g, 'x').trim();
  const m = clean.match(/^(\d{2,4})x(\d{2,4})$/);
  if (!m) return /^\d{2,4}x\d{2,4}$/.test(fallback) ? fallback : '1152x1536';
  const clamp = n => Math.max(512, Math.min(2048, Math.round(n / 32) * 32));
  return `${clamp(Number(m[1]))}x${clamp(Number(m[2]))}`;
}

export function aspectRatioFromSize(sizeStr) {
  const [w, h] = normalizeImageSize(sizeStr).split('x').map(Number);
  return (w && h) ? `${w} / ${h}` : '3 / 4';
}

export function findLastChatImage(charId) {
  const msgs = charId === runtime.state.activeCharId
    ? runtime.state.messages
    : (runtime.state.characters.find(c => c.id === charId)?.messages || []);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.image) return msgs[i].image;
  }
  return '';
}

export async function downloadAndCompressImage(url) {
  if (String(url).startsWith('data:')) {
    return url;
  }
  try {
    const res = await fetchWithTimeout(url, {}, 40000);
    if (res.ok) {
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片流失败'));
        reader.readAsDataURL(blob);
      });
    }
  } catch {}
  try {
    return await compressImageSrcToJpeg(url, 2560, 0.94);
  } catch {
    return url;
  }
}

export async function fetchWith429Backoff(url, options, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchWithTimeout(url, options, 45000);
    if (res.status === 429 && attempt < maxRetries) {
      await sleep(45000);
      continue;
    }
    return res;
  }
}

export async function generateImageViaModelScope({ prompt, size, refImg }) {
  const token = (runtime.state.settings.imgApiKey || '').trim();
  if (!token) throw new Error('未填写魔搭 Access Token');
  const cleanSize = normalizeImageSize(size);
  const customModel = (runtime.state.settings.msImgCustomModel || '').trim();
  const presetModel = (runtime.state.settings.msImgPreset || runtime.state.settings.imgModel || '').trim() || 'Tongyi-MAI/Z-Image-Turbo';
  const chosenModel = customModel
    ? customModel
    : (refImg ? 'Qwen/Qwen-Image-2.1' : presetModel);

  const body = {
    model: chosenModel,
    prompt,
    size: cleanSize
  };
  if (refImg) {
    let safeRef = refImg;
    if (safeRef.startsWith('data:') && safeRef.length > 2500000) {
      try { safeRef = await compressImageSrcToJpeg(safeRef, 1536, 0.9); } catch {}
    }
    body.image_url = [safeRef];
  }

  const submitRes = await fetchWith429Backoff('https://api-inference.modelscope.cn/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-ModelScope-Async-Mode': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!submitRes.ok) {
    const txt = await submitRes.text().catch(() => '');
    throw new Error(`生图提交失败 (${submitRes.status}) ${txt.slice(0, 80)}`);
  }
  const submitJson = await submitRes.json();
  const taskId = submitJson.task_id;
  if (!taskId) throw new Error('魔搭未返回 task_id');

  const maxPolls = chosenModel.includes('Qwen-Image-2.1') ? 45 : 24;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(6000);
    const pollRes = await fetchWith429Backoff(`https://api-inference.modelscope.cn/v1/tasks/${taskId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-ModelScope-Task-Type': 'image_generation'
      }
    });
    if (!pollRes.ok) {
      const txt = await pollRes.text().catch(() => '');
      if (pollRes.status === 404 || /task not found/i.test(txt)) {
        throw new Error('图片未通过审核或任务已过期');
      }
      throw new Error(`轮询生图失败 (${pollRes.status})`);
    }
    const pollJson = await pollRes.json();
    const status = String(pollJson.task_status || '').toUpperCase();
    if (status === 'SUCCEED') {
      const imgUrl = pollJson.output_images?.[0];
      if (!imgUrl) throw new Error('生图完成但未返回图片地址');
      return await downloadAndCompressImage(imgUrl);
    }
    if (status === 'FAILED') {
      throw new Error('画面未通过审核或生成失败，换个自然点的描述试试');
    }
  }
  throw new Error('生图等待超时，请稍后再试');
}

export function normalizeOpenAISize(rawSize, modelName = '') {
  const clean = normalizeImageSize(rawSize);
  const [w, h] = clean.split('x').map(Number);
  if (w === h) return '1024x1024';
  const isGptImage = /gpt-image/i.test(modelName);
  if (w > h) return isGptImage ? '1536x1024' : '1792x1024';
  return isGptImage ? '1024x1536' : '1024x1792';
}

export const OPENAI_IMG_TIMEOUT_MS = 200000;

export async function extractOpenAIImageResult(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const firstData = Array.isArray(payload.data) ? payload.data[0] : null;
  const rawB64 = firstData?.b64_json || payload.b64_json || payload.result?.b64_json;
  if (rawB64) {
    const clean = String(rawB64).trim();
    if (clean.startsWith('data:')) return clean;
    const mime = clean.startsWith('/9j/') ? 'image/jpeg' : (clean.startsWith('UklGR') ? 'image/webp' : 'image/png');
    return `data:${mime};base64,${clean}`;
  }
  const candidates = [
    firstData?.url,
    payload.url,
    payload.image_url,
    Array.isArray(payload.output_images) ? payload.output_images[0] : null,
    Array.isArray(payload.images) ? (payload.images[0]?.url || payload.images[0]) : null,
    Array.isArray(payload.result?.images) ? (payload.result.images[0]?.url || payload.result.images[0]) : null,
    Array.isArray(payload.output) ? (payload.output[0]?.url || payload.output[0]) : null,
    payload.data?.url,
    payload.data?.image_url
  ];
  const hitUrl = candidates.find(u => typeof u === 'string' && /^(https?:|data:image\/)/i.test(u.trim()));
  if (hitUrl) {
    return await downloadAndCompressImage(hitUrl.trim());
  }
  return '';
}

export function resolvePollUrl(rawUrl, base) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  try {
    const baseWithSlash = String(base || '').replace(/\/+$/, '') + '/';
    return new URL(s, baseWithSlash).href;
  } catch {
    return '';
  }
}

export async function imageSrcToBlob(srcUrl) {
  let safeSrc = String(srcUrl || '').trim();
  if (safeSrc.startsWith('data:') && safeSrc.length > 2500000) {
    try { safeSrc = await compressImageSrcToJpeg(safeSrc, 1536, 0.9); } catch {}
  }
  const res = await fetch(safeSrc);
  if (!res.ok) throw new Error('参考图片读取失败');
  return { blob: await res.blob(), dataOrUrl: safeSrc };
}

export async function generateImageViaOpenAI({ prompt, size, refImg }) {
  const key = (runtime.state.settings.imgApiKey || runtime.state.settings.apiKey || '').trim();
  const base = (runtime.state.settings.imgBaseUrl || runtime.state.settings.baseUrl || '').trim().replace(/\/+$/, '');
  const model = (runtime.state.settings.openaiImgModel || runtime.state.settings.imgModel || '').trim();
  if (!key || !base || !model) throw new Error('生图接口 Base URL、Key 或模型未填完整');

  const deadline = Date.now() + OPENAI_IMG_TIMEOUT_MS;
  const cleanSize = normalizeOpenAISize(size, model);
  const authHeaders = {
    'Authorization': `Bearer ${key}`
  };

  const postWithDeadline = async (endpoint, headers, body) => {
    const leftMs = deadline - Date.now();
    if (leftMs <= 1000) throw new Error('生图超时（已等待 200 秒），请稍后再试');
    try {
      return await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body
      }, leftMs);
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('生图超时（已等待 200 秒），请稍后再试');
      throw err;
    }
  };

  let res = null;
  if (refImg) {
    let refData = null;
    try { refData = await imageSrcToBlob(refImg); } catch {}
    if (refData?.blob) {
      const buildEditForm = includeFmt => {
        const fd = new FormData();
        fd.append('model', model);
        fd.append('prompt', prompt);
        fd.append('size', cleanSize);
        fd.append('n', '1');
        fd.append('image', refData.blob, 'reference.jpg');
        if (includeFmt) fd.append('response_format', 'b64_json');
        return fd;
      };
      res = await postWithDeadline(`${base}/images/edits`, authHeaders, buildEditForm(true));
      if (!res.ok && (res.status === 400 || res.status === 422)) {
        const errText = await res.text().catch(() => '');
        if (/response_format|unknown[_ ]field|extra[_ ]inputs|unrecognized|unsupported/i.test(errText)) {
          res = await postWithDeadline(`${base}/images/edits`, authHeaders, buildEditForm(false));
        } else if (/not[_ ]supported|not[_ ]implemented|multipart|edit/i.test(errText)) {
          res = null;
        } else {
          throw new Error(`改图请求失败 (${res.status}) ${errText.slice(0, 80)}`);
        }
      } else if (!res.ok && (res.status === 404 || res.status === 405 || res.status === 415 || res.status === 501)) {
        res = null;
      }
    }
    // Fallback: JSON /images/generations with image & image_url for relays supporting edit params there
    if (!res) {
      let safeRef = refData?.dataOrUrl || refImg;
      if (safeRef.startsWith('data:') && safeRef.length > 2500000) {
        try { safeRef = await compressImageSrcToJpeg(safeRef, 1536, 0.9); } catch {}
      }
      const editJsonBody = {
        model,
        prompt,
        size: cleanSize,
        n: 1,
        image: safeRef,
        image_url: safeRef,
        response_format: 'b64_json'
      };
      const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };
      res = await postWithDeadline(`${base}/images/generations`, jsonHeaders, JSON.stringify(editJsonBody));
      if (!res.ok && (res.status === 400 || res.status === 422)) {
        const errText = await res.text().catch(() => '');
        if (/response_format|unknown[_ ]field|extra[_ ]inputs|unrecognized|unsupported/i.test(errText)) {
          const fb = { ...editJsonBody };
          delete fb.response_format;
          res = await postWithDeadline(`${base}/images/generations`, jsonHeaders, JSON.stringify(fb));
        } else {
          throw new Error(`改图请求失败 (${res.status}) ${errText.slice(0, 80)}`);
        }
      }
    }
  } else {
    const reqBody = {
      model,
      prompt,
      size: cleanSize,
      n: 1,
      response_format: 'b64_json'
    };
    const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };
    res = await postWithDeadline(`${base}/images/generations`, jsonHeaders, JSON.stringify(reqBody));
    if (!res.ok && (res.status === 400 || res.status === 422)) {
      const errText = await res.text().catch(() => '');
      if (/response_format|unknown[_ ]field|extra[_ ]inputs|unrecognized|unsupported/i.test(errText)) {
        const fallbackBody = { ...reqBody };
        delete fallbackBody.response_format;
        res = await postWithDeadline(`${base}/images/generations`, jsonHeaders, JSON.stringify(fallbackBody));
      } else {
        throw new Error(`生图请求失败 (${res.status}) ${errText.slice(0, 80)}`);
      }
    }
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`生图请求失败 (${res.status}) ${txt.slice(0, 80)}`);
  }

  const json = await res.json();
  const directDataUrl = await extractOpenAIImageResult(json);
  if (directDataUrl) return directDataUrl;

  // 兼容返回 task_id / job_id / status_url 的异步生图协议
  const rawStatus = String(json?.status || json?.task_status || json?.state || json?.data?.status || '').toLowerCase();
  if (/^(failed|fail|error|cancelled|canceled|rejected)$/.test(rawStatus)) {
    throw new Error(`生图失败：${String(json?.error?.message || json?.message || rawStatus).slice(0, 100)}`);
  }

  const taskId = String(
    json?.task_id || json?.job_id || json?.request_id ||
    json?.data?.task_id || json?.data?.job_id || json?.data?.id || json?.id || ''
  ).trim();
  const explicitPoll = resolvePollUrl(
    json?.status_url || json?.result_url || json?.poll_url || json?.urls?.get || json?.data?.status_url,
    base
  );
  const candidateUrls = [
    explicitPoll,
    taskId ? `${base}/images/tasks/${encodeURIComponent(taskId)}` : '',
    taskId ? `${base}/tasks/${encodeURIComponent(taskId)}` : '',
    taskId ? `${base}/images/generations/${encodeURIComponent(taskId)}` : ''
  ].filter(Boolean);

  if (!candidateUrls.length) {
    throw new Error('接口未返回图片数据或异步任务 ID');
  }

  let activePollUrl = '';
  while (Date.now() < deadline) {
    const waitMs = Math.min(3500, Math.max(200, deadline - Date.now()));
    await sleep(waitMs);
    if (Date.now() >= deadline) break;

    const urlsToTry = activePollUrl ? [activePollUrl] : candidateUrls;
    let pollJson = null;
    let lastErrMsg = '';
    for (const pollUrl of urlsToTry) {
      const leftMs = deadline - Date.now();
      if (leftMs <= 500) break;
      let pollRes;
      try {
        pollRes = await fetchWithTimeout(pollUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${key}` }
        }, leftMs);
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error('生图超时（已等待 200 秒），请稍后再试');
        lastErrMsg = err?.message || '网络异常';
        continue;
      }
      if (pollRes.ok) {
        activePollUrl = pollUrl;
        pollJson = await pollRes.json().catch(() => null);
        break;
      }
      if (pollRes.status === 404 || pollRes.status === 405 || pollRes.status === 501) {
        lastErrMsg = `HTTP ${pollRes.status}`;
        continue;
      }
      const txt = await pollRes.text().catch(() => '');
      throw new Error(`轮询生图失败 (${pollRes.status}) ${txt.slice(0, 80)}`);
    }

    if (!pollJson) {
      if (!activePollUrl && lastErrMsg) {
        // 首次尚未探测到可用查询路径时若全 404 则直接提示，避免空等 200 秒
        throw new Error(`异步生图状态查询失败 (${lastErrMsg})`);
      }
      continue;
    }

    const polledDataUrl = await extractOpenAIImageResult(pollJson);
    if (polledDataUrl) return polledDataUrl;

    const status = String(pollJson?.status || pollJson?.task_status || pollJson?.state || pollJson?.data?.status || '').toLowerCase();
    if (/^(failed|fail|error|cancelled|canceled|rejected)$/.test(status)) {
      const reason = pollJson?.error?.message || pollJson?.fail_reason || pollJson?.message || status;
      throw new Error(`生图失败：${String(reason).slice(0, 100)}`);
    }
  }
  throw new Error('生图超时（已等待 200 秒），请稍后再试');
}

let imgTaskChain = Promise.resolve();

export function replaceImagePlaceholder(charId, placeholderId, finalDataUrl, imgPrompt = '') {
  const isCurrent = runtime.state.activeCharId === charId;
  const msgs = isCurrent
    ? runtime.state.messages
    : runtime.state.characters.find(c => c.id === charId)?.messages;
  if (!Array.isArray(msgs)) return;
  const idx = msgs.findIndex(m => m && m.id === placeholderId);
  let finalMsg = null;
  if (idx >= 0) {
    if (finalDataUrl) {
      finalMsg = {
        id: placeholderId,
        role: 'assistant',
        image: finalDataUrl,
        imgPrompt: String(imgPrompt || '').slice(0, 240),
        text: '',
        createdAt: Date.now()
      };
      msgs[idx] = finalMsg;
    } else {
      msgs.splice(idx, 1);
    }
  }
  if (isCurrent) {
    const chatScroll = document.getElementById('chatScroll');
      const row = chatScroll?.querySelector(`[data-pending-id="${placeholderId}"]`);
    if (row) {
      if (finalDataUrl) {
        const miniChar = escapeHtml((runtime.state.settings.name || '林澈').slice(-1));
        const fresh = _hooks.createMsgRowElement?.(finalMsg || { id: placeholderId, role: 'assistant', image: finalDataUrl, text: '' }, miniChar);
        if (fresh) row.replaceWith(fresh);
      } else {
        row.remove();
      }
    }
  }
  scheduleSave();
}

export function enqueueImageTask(task) {
  runtime.pendingImgCountByChar.set(task.charId, (runtime.pendingImgCountByChar.get(task.charId) || 0) + 1);
  if (runtime.state.activeCharId === task.charId) _hooks.renderHeader?.();
  const provider = runtime.state.settings.imgProvider;
  const runTask = async () => {
    const targetChar = runtime.state.characters.find(c => c.id === task.charId);
    if (!targetChar) return;
    try {
      const appearanceAnchor = (targetChar.appearance || runtime.state.settings.appearance || '').trim();
      const apiPrompt = (!task.refImg && appearanceAnchor && !task.prompt.includes(appearanceAnchor))
        ? `人物固定外貌与穿搭参考：${appearanceAnchor}。画面场景：${task.prompt}`
        : task.prompt;
      const reqTask = { ...task, prompt: apiPrompt };
      const dataUrl = provider === 'modelscope'
        ? await generateImageViaModelScope(reqTask)
        : await generateImageViaOpenAI(reqTask);
      replaceImagePlaceholder(task.charId, task.placeholderId, dataUrl, task.prompt);
      if (runtime.state.activeCharId === task.charId && runtime.currentPage === 1) {
        _hooks.showFloatingBanner?.('刚给你发了一张照片');
      }
    } catch (err) {
      replaceImagePlaceholder(task.charId, task.placeholderId, null);
      showWarn(err.message || '图片没发出来，稍后再试试', true);
      setTimeout(() => document.getElementById('warnToast').classList.remove('show'), 4200);
    } finally {
      const left = Math.max(0, (runtime.pendingImgCountByChar.get(task.charId) || 1) - 1);
      runtime.pendingImgCountByChar.set(task.charId, left);
      if (runtime.state.activeCharId === task.charId) _hooks.renderHeader?.();
      scheduleSave();
    }
  };
  if (provider === 'modelscope') {
    imgTaskChain = imgTaskChain.then(runTask).catch(() => {});
  } else {
    // OpenAI 兼容生图直接在后台异步并发执行，不互相卡队列
    void runTask();
  }
}
