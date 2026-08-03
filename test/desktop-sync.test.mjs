// Desktop sync writes a preview of real chat text into Codex's own state
// database. The one thing that must never happen is that text reaching the
// sqlite parser as literal SQL, so it is encoded as a hex blob and cast back
// to TEXT. These tests assert the raw text is genuinely absent from the SQL.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDesktopMetadataSql, sqlText } from '../src/desktop-sync.mjs';

test('sqlText produces a hex blob with no raw text', () => {
  const literal = sqlText("Zoë's line\nsecond");
  assert.match(literal, /^CAST\(X'[0-9a-f]+' AS TEXT\)$/);
  assert.equal(literal.includes('Zoë'), false);
  assert.equal(literal.includes('second'), false);
});

test('the generated UPDATE never contains raw preview text', () => {
  const sql = buildDesktopMetadataSql({
    threadId: 'thread-id',
    title: 'Codex via Telegram',
    preview: "Zoë's line\nsecond",
    cwd: '/tmp/workdir',
    nowMs: 123_000,
  });

  assert.match(sql, /^PRAGMA busy_timeout = 2000;/);
  assert.equal(sql.includes('Zoë'), false);
  assert.equal(sql.includes('second'), false);
});
