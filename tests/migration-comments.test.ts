import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATION_COMMENT_UPDATES, isDocumentedMigrationCommentUpdate } from '../src/server/db/migration-comment-updates.js';

const digest = (source: string): string => createHash('sha256').update(source).digest('hex');

test('documented migration notes preserve the exact historical SQL and match approved full-file hashes', async () => {
  for (const [version, update] of Object.entries(MIGRATION_COMMENT_UPDATES)) {
    const sql = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8');
    const original = sql.split('\n').filter((line) => !line.trimStart().startsWith('-- ')).join('\n');
    assert.equal(digest(original), update.before, version);
    assert.equal(digest(sql), update.after, version);
    assert.equal(isDocumentedMigrationCommentUpdate(version, update.before, digest(sql)), true);
  }
});

test('migration checksum compatibility rejects further SQL or comment edits and unknown stored checksums', async () => {
  for (const [version, update] of Object.entries(MIGRATION_COMMENT_UPDATES)) {
    const sql = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8');
    for (const suffix of ['\nSELECT 1;\n', '\n-- additional note\n']) {
      assert.equal(isDocumentedMigrationCommentUpdate(version, update.before, digest(sql + suffix)), false);
    }
    assert.equal(isDocumentedMigrationCommentUpdate(version, '0'.repeat(64), update.after), false);
    assert.equal(isDocumentedMigrationCommentUpdate(version, update.after, update.before), false);
    assert.equal(isDocumentedMigrationCommentUpdate(version, update.after, update.after), false);
  }
});

test('approved migration pairs cannot be reused for another version', () => {
  for (const [version, update] of Object.entries(MIGRATION_COMMENT_UPDATES)) {
    assert.equal(isDocumentedMigrationCommentUpdate('unknown_version', update.before, update.after), false);
    assert.equal(isDocumentedMigrationCommentUpdate(version + '_copy', update.before, update.after), false);
  }
});
