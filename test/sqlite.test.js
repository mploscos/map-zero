import assert from 'node:assert/strict';
import test from 'node:test';

import Database from '../packages/cli/src/sqlite.js';

test('built-in SQLite adapter preserves transaction and nested rollback behavior', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE values_table (value TEXT)');
    const insert = db.prepare('INSERT INTO values_table VALUES (?)');
    const nested = db.transaction(() => {
      insert.run('rolled back');
      throw new Error('rollback');
    });

    db.transaction(() => {
      insert.run('kept');
      assert.throws(nested, /rollback/);
      insert.run('also kept');
    })();

    assert.deepEqual(
      db.prepare('SELECT value FROM values_table ORDER BY rowid').all(),
      [{ value: 'kept' }, { value: 'also kept' }]
    );
  } finally {
    db.close();
  }
});
