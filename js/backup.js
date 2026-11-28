import { todayKey } from './utils.js';

export const APP_VERSION = '0.23.5';
const PBKDF2_ITERATIONS = 120000;

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || '').trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveAesKey(passphrase, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持本地加密接口（Web Crypto）');
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey(
    'raw',
    enc.encode(String(passphrase)),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: Math.max(10000, Math.min(1000000, Number(iterations) || PBKDF2_ITERATIONS)),
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBackupPayload(plainObj, passphrase) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持本地加密接口（Web Crypto）');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const encoded = new TextEncoder().encode(JSON.stringify(plainObj));
  const cipherBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    _type: 'roomi_encrypted_backup',
    version: 1,
    alg: 'AES-GCM-256',
    iter: PBKDF2_ITERATIONS,
    exportedAt: Date.now(),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    cipher: bytesToBase64(new Uint8Array(cipherBuf))
  };
}

export async function decryptBackupPayload(encObj, passphrase) {
  if (!encObj || encObj._type !== 'roomi_encrypted_backup' || !encObj.salt || !encObj.iv || !encObj.cipher) {
    throw new Error('加密备份文件格式不完整');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持本地解密接口（Web Crypto）');
  try {
    const salt = base64ToBytes(encObj.salt);
    const iv = base64ToBytes(encObj.iv);
    const cipher = base64ToBytes(encObj.cipher);
    const fileIter = Number(encObj.iter) || PBKDF2_ITERATIONS;
    const key = await deriveAesKey(passphrase, salt, fileIter);
    const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    throw new Error('口令不正确或备份文件已损坏');
  }
}

export function isEncryptedBackup(obj) {
  return Boolean(obj && typeof obj === 'object' && obj._type === 'roomi_encrypted_backup' && obj.cipher);
}

export function summarizeBackupData(data) {
  const chars = Array.isArray(data?.characters) ? data.characters : [];
  let msgCount = 0;
  let imgCount = 0;
  let memCount = 0;
  let widgetCount = 0;
  if (chars.length) {
    for (const c of chars) {
      const msgs = Array.isArray(c?.messages) ? c.messages : [];
      msgCount += msgs.length;
      imgCount += msgs.filter(m => m && m.image).length;
      memCount += Array.isArray(c?.memories) ? c.memories.length : 0;
      widgetCount += Array.isArray(c?.widgets) ? c.widgets.length : 0;
    }
  } else {
    const msgs = Array.isArray(data?.messages) ? data.messages : [];
    msgCount = msgs.length;
    imgCount = msgs.filter(m => m && m.image).length;
    memCount = Array.isArray(data?.memories) ? data.memories.length : 0;
    widgetCount = Array.isArray(data?.widgets) ? data.widgets.length : 0;
  }
  const hasApiKey = Boolean(String(data?.settings?.apiKey || '').trim());
  const hasImgApiKey = Boolean(String(data?.settings?.imgApiKey || '').trim());
  const charCount = chars.length || 1;
  return { charCount, msgCount, imgCount, memCount, widgetCount, hasApiKey, hasImgApiKey };
}

export async function buildBackupPackage(stateSnapshot, { includeKeys = true, passphrase = '' } = {}) {
  const copy = JSON.parse(JSON.stringify(stateSnapshot));
  copy._backupMeta = {
    app: 'Roomi',
    version: APP_VERSION,
    exportedAt: Date.now(),
    includesKeys: Boolean(includeKeys)
  };
  if (!includeKeys && copy.settings) {
    copy.settings.apiKey = '';
    copy.settings.imgApiKey = '';
    copy.settings.privacyPin = '';
    copy.settings.privacyLock = false;
  }
  const pass = String(passphrase || '').trim();
  const encrypted = Boolean(pass);
  const payload = encrypted ? await encryptBackupPayload(copy, pass) : copy;
  const suffix = encrypted ? '-enc' : '';
  const fileName = `roomi-backup-${todayKey()}${suffix}.json`;
  return {
    fileName,
    encrypted,
    jsonText: JSON.stringify(payload, null, 2)
  };
}

export async function saveLocalBackupFile(jsonText, fileName) {
  const fs = window.Capacitor?.Plugins?.Filesystem;
  if (fs?.writeFile) {
    try {
      await fs.writeFile({
        path: `Roomi/${fileName}`,
        data: jsonText,
        directory: 'DOCUMENTS',
        encoding: 'utf8',
        recursive: true
      });
      return { mode: 'capacitor_documents', path: `Documents/Roomi/${fileName}` };
    } catch {}
  }
  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { mode: 'browser_download', path: fileName };
}
