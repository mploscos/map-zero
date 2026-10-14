import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Small compatibility wrapper around Node's built-in SQLite implementation.
 * It keeps the subset of the better-sqlite3 API used by map-zero so the rest
 * of the code can remain focused on GeoPackage operations.
 */
export default class Database {
  /**
   * @param {string} path
   * @param {{ readonly?: boolean, fileMustExist?: boolean }} [options]
   */
  constructor(path, options = {}) {
    if (options.fileMustExist && !existsSync(path)) {
      throw new Error(`SQLite database does not exist: ${path}`);
    }
    this.database = new DatabaseSync(path, { readOnly: options.readonly === true });
    this.transactionDepth = 0;
  }

  prepare(sql) {
    return new Statement(this.database.prepare(sql));
  }

  exec(sql) {
    return this.database.exec(sql);
  }

  /**
   * @param {string} source
   * @param {{ simple?: boolean }} [options]
   */
  pragma(source, options = {}) {
    const rows = this.prepare(`PRAGMA ${source}`).all();
    if (!options.simple) {
      return rows;
    }
    const row = rows[0];
    return row ? Object.values(row)[0] : undefined;
  }

  transaction(fn) {
    return (...args) => {
      const depth = this.transactionDepth;
      const savepoint = `map_zero_transaction_${depth}`;
      this.database.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      this.transactionDepth = depth + 1;
      try {
        const result = fn(...args);
        this.database.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        if (depth === 0) {
          this.database.exec('ROLLBACK');
        } else {
          this.database.exec(`ROLLBACK TO ${savepoint}`);
          this.database.exec(`RELEASE ${savepoint}`);
        }
        throw error;
      } finally {
        this.transactionDepth = depth;
      }
    };
  }

  close() {
    this.database.close();
  }
}

class Statement {
  constructor(statement) {
    this.statement = statement;
  }

  run(...params) {
    return this.statement.run(...expandParams(params));
  }

  get(...params) {
    return normalizeRow(this.statement.get(...expandParams(params)));
  }

  all(...params) {
    return this.statement.all(...expandParams(params)).map(normalizeRow);
  }

  *iterate(...params) {
    for (const row of this.statement.iterate(...expandParams(params))) {
      yield normalizeRow(row);
    }
  }
}

function expandParams(params) {
  return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

function normalizeRow(row) {
  if (row === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value
  ]));
}
