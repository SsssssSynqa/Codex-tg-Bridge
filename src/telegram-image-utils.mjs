import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(?:png|jpe?g|webp|gif)$/i;

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

export function getTelegramMessageText(message) {
  return String(message?.text || message?.caption || '').trim();
}

export function getTelegramMessageEntities(message) {
  return message?.entities || message?.caption_entities || [];
}

export function getImageRefs(message) {
  const refs = [];

  if (Array.isArray(message?.photo) && message.photo.length) {
    const photo = message.photo.at(-1);
    refs.push({
      kind: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || photo.file_id,
      width: photo.width || null,
      height: photo.height || null,
      fileSize: photo.file_size || null,
      mimeType: 'image/jpeg',
    });
  }

  const document = message?.document;
  if (document?.file_id && IMAGE_MIME_RE.test(String(document.mime_type || ''))) {
    refs.push({
      kind: 'document',
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id || document.file_id,
      width: null,
      height: null,
      fileSize: document.file_size || null,
      mimeType: document.mime_type,
      fileName: document.file_name || null,
    });
  }

  return refs;
}

export function hasTelegramImages(message) {
  return getImageRefs(message).length > 0;
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {}
}

function extensionFor(filePath, mimeType) {
  const fromPath = path.extname(filePath || '').toLowerCase();
  if (fromPath) return fromPath;
  return MIME_EXTENSIONS.get(String(mimeType || '').toLowerCase()) || '.img';
}

async function fetchTelegramJson(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || response.statusText || 'unknown Telegram error');
  }
  return data.result;
}

export async function downloadTelegramImages(message, {
  token,
  cacheDir,
  log = () => {},
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const refs = getImageRefs(message);
  const images = [];
  const notes = [];
  if (!refs.length) return { images, notes };

  if (!token) {
    return { images, notes: ['Image was not downloaded: missing Telegram bot token.'] };
  }

  ensurePrivateDir(cacheDir);
  const api = `https://api.telegram.org/bot${token}`;
  const fileApi = `https://api.telegram.org/file/bot${token}`;
  const chatId = String(message?.chat?.id || 'chat').replace(/[^-0-9A-Za-z_]/g, '_');
  const messageId = String(message?.message_id || Date.now()).replace(/[^0-9A-Za-z_]/g, '_');

  for (const [index, ref] of refs.entries()) {
    if (ref.fileSize && ref.fileSize > maxImageBytes) {
      notes.push(`Image ${index + 1} exceeded ${Math.round(maxImageBytes / 1024 / 1024)}MB and was skipped.`);
      continue;
    }

    try {
      const file = await fetchTelegramJson(`${api}/getFile`, { file_id: ref.fileId });
      if (file.file_size && file.file_size > maxImageBytes) {
        notes.push(`Image ${index + 1} exceeded ${Math.round(maxImageBytes / 1024 / 1024)}MB and was skipped.`);
        continue;
      }

      const fileResponse = await fetch(`${fileApi}/${file.file_path}`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!fileResponse.ok) {
        throw new Error(`download failed: ${fileResponse.status} ${fileResponse.statusText}`);
      }

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      if (buffer.length > maxImageBytes) {
        notes.push(`Image ${index + 1} exceeded ${Math.round(maxImageBytes / 1024 / 1024)}MB and was skipped.`);
        continue;
      }

      const responseMimeType = fileResponse.headers.get('content-type')?.split(';')[0] || '';
      const mimeType = IMAGE_MIME_RE.test(responseMimeType)
        ? responseMimeType
        : ref.mimeType || 'application/octet-stream';
      const hash = crypto
        .createHash('sha256')
        .update(`${chatId}:${messageId}:${ref.fileUniqueId}:${index}`)
        .digest('hex')
        .slice(0, 16);
      const outPath = path.join(
        cacheDir,
        `${Date.now()}-${chatId}-${messageId}-${hash}${extensionFor(file.file_path, mimeType)}`,
      );
      fs.writeFileSync(outPath, buffer, { mode: 0o600 });

      images.push({
        path: outPath,
        mimeType,
        width: ref.width,
        height: ref.height,
        fileSize: buffer.length,
        source: ref.kind,
      });
    } catch (error) {
      log(`image download failed chat=${message?.chat?.id || '?'} message=${message?.message_id || '?'}: ${error.message}`);
      notes.push(`Image ${index + 1} download failed: ${error.message}`);
    }
  }

  return { images, notes };
}

export function summarizeImages(images = [], notes = []) {
  const parts = [];
  if (images.length) {
    parts.push(`${images.length} image attachment(s) were provided as visual input.`);
    for (const [index, image] of images.entries()) {
      const size = image.width && image.height ? `, ${image.width}x${image.height}` : '';
      parts.push(`Image ${index + 1}: ${image.mimeType || 'unknown'}${size}`);
    }
  }
  if (notes.length) parts.push(...notes);
  return parts.join('\n');
}

export function buildMessageTextWithImages(text, images = [], notes = []) {
  const trimmed = String(text || '').trim();
  const imageSummary = summarizeImages(images, notes);
  if (!imageSummary) return trimmed;
  if (!trimmed) return `(sent image attachments)\n${imageSummary}`;
  return `${trimmed}\n\n[image attachments]\n${imageSummary}`;
}
