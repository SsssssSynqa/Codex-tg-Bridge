import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildMessageTextWithAttachments,
  downloadTelegramFiles,
  getFileRefs,
  getImageRefs,
  hasTelegramAttachments,
  hasTelegramFiles,
  hasTelegramImages,
} from '../src/telegram-image-utils.mjs';

const pdfDocumentMessage = {
  document: {
    file_id: 'file-doc',
    file_unique_id: 'unique-doc',
    file_name: '../report final.pdf',
    mime_type: 'application/pdf',
    file_size: 2048,
  },
};

const plainTextDocumentMessage = {
  document: {
    file_id: 'file-text',
    file_unique_id: 'unique-text',
    file_name: '../notes.txt',
    mime_type: 'text/plain',
    file_size: 10,
  },
};

test('regular Telegram documents are file attachments', () => {
  assert.equal(hasTelegramAttachments(pdfDocumentMessage), true);
  assert.equal(hasTelegramFiles(pdfDocumentMessage), true);
  assert.equal(hasTelegramImages(pdfDocumentMessage), false);
  assert.deepEqual(getFileRefs(pdfDocumentMessage), [
    {
      kind: 'document',
      fileId: 'file-doc',
      fileUniqueId: 'unique-doc',
      fileSize: 2048,
      mimeType: 'application/pdf',
      fileName: '../report final.pdf',
    },
  ]);
});

test('image documents still use the image pipeline', () => {
  const imageDocumentMessage = {
    document: {
      file_id: 'file-image',
      file_unique_id: 'unique-image',
      file_name: 'photo.png',
      mime_type: 'image/png',
      file_size: 1024,
    },
  };

  assert.equal(hasTelegramAttachments(imageDocumentMessage), true);
  assert.equal(hasTelegramFiles(imageDocumentMessage), false);
  assert.equal(hasTelegramImages(imageDocumentMessage), true);
  assert.equal(getImageRefs(imageDocumentMessage)[0].mimeType, 'image/png');
});

test('downloaded text files get safe names and text previews', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-files-test-'));
  const originalFetch = globalThis.fetch;
  const payload = Buffer.from('hello file');

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/getFile')) {
      return new Response(JSON.stringify({
        ok: true,
        result: {
          file_path: 'documents/notes.txt',
          file_size: payload.length,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };

  try {
    const { files, notes } = await downloadTelegramFiles(plainTextDocumentMessage, {
      token: '123:test-token',
      cacheDir: tempDir,
    });

    assert.deepEqual(notes, []);
    assert.equal(files.length, 1);
    assert.equal(files[0].fileName, 'notes.txt');
    assert.equal(path.dirname(files[0].path), tempDir);
    assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'hello file');
    assert.equal(files[0].textPreview, 'hello file');

    const promptText = buildMessageTextWithAttachments('Please read this', [], files, []);
    assert.match(promptText, /Please read this/);
    assert.match(promptText, /notes\.txt/);
    assert.match(promptText, /Text preview:\nhello file/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
