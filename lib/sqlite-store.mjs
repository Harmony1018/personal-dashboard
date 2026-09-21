import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { metricSeeds, normalizeDueOn, normalizeEntry, normalizeTaskTitle } from './common.mjs';

export class SqliteStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'dashboard.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        domain TEXT NOT NULL CHECK(domain IN ('business', 'health', 'planning')),
        unit TEXT NOT NULL DEFAULT '',
        precision INTEGER NOT NULL DEFAULT 0,
        goal REAL,
        goal_mode TEXT NOT NULL DEFAULT 'higher',
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_id INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
        value REAL NOT NULL,
        recorded_on TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS entries_metric_date_idx ON entries(metric_id, recorded_on);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'planning',
        due_on TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'open',
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const insert = this.db.prepare(`
      INSERT INTO metrics
        (metric_key, name, domain, unit, precision, goal, goal_mode, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metric_key) DO UPDATE SET
        name = excluded.name, domain = excluded.domain, unit = excluded.unit,
        precision = excluded.precision, goal = excluded.goal,
        goal_mode = excluded.goal_mode, sort_order = excluded.sort_order
    `);
    // 用 upsert 而不是 INSERT OR IGNORE：改名/改单位时，已经建好的库也能跟上
    // （之前是 IGNORE，改了 seeds 老库纹丝不动）。Supabase 那边本来就是
    // merge-duplicates，两边行为现在一致了。
    for (const item of metricSeeds) {
      insert.run(item.metricKey, item.name, item.domain, item.unit, item.precision, item.goal, item.goalMode, item.sortOrder);
    }
  }

  async metrics() {
    return this.db.prepare(`
      SELECT id, metric_key AS metricKey, name, domain, unit, precision, goal,
             goal_mode AS goalMode, sort_order AS sortOrder
      FROM metrics WHERE active = 1 ORDER BY domain, sort_order, id
    `).all();
  }

  async latestEntries(limit = 50) {
    return this.db.prepare(`
      SELECT e.id, m.metric_key AS metricKey, m.name, m.domain, m.unit, m.precision,
             e.value, e.recorded_on AS recordedOn, e.recorded_at AS recordedAt,
             e.note, e.source
      FROM entries e JOIN metrics m ON m.id = e.metric_id
      ORDER BY e.recorded_on DESC, e.recorded_at DESC, e.id DESC LIMIT ?
    `).all(limit);
  }

  async entriesBetween(from, to) {
    return this.db.prepare(`
      SELECT e.id, m.metric_key AS metricKey, m.name, m.domain, m.unit, m.precision,
             e.value, e.recorded_on AS recordedOn, e.recorded_at AS recordedAt,
             e.note, e.source
      FROM entries e JOIN metrics m ON m.id = e.metric_id
      WHERE e.recorded_on BETWEEN ? AND ? ORDER BY e.recorded_on, e.recorded_at, e.id
    `).all(from, to);
  }

  async taskList() {
    return this.db.prepare(`
      SELECT id, title, domain, due_on AS dueOn, priority, status,
             completed_at AS completedAt, created_at AS createdAt
      FROM tasks
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
               CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               COALESCE(due_on, '9999-12-31'), id DESC
    `).all();
  }

  async createEntry(body, sourceOverride) {
    const entry = normalizeEntry(body, await this.metrics(), sourceOverride);
    const result = this.db.prepare(`
      INSERT INTO entries (metric_id, value, recorded_on, recorded_at, note, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.metricId, entry.value, entry.recordedOn, entry.recordedAt, entry.note, entry.source);
    return Number(result.lastInsertRowid);
  }

  async createEntries(items, sourceOverride, partial = false) {
    const metrics = await this.metrics();
    const normalized = [];
    const errors = [];
    items.forEach((item, index) => {
      try { normalized.push(normalizeEntry(item, metrics, sourceOverride)); }
      catch (error) { errors.push({ row: index + 2, message: error.message }); }
    });
    if (errors.length && !partial) throw new Error(errors[0].message);
    const ids = [];
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(`
        INSERT INTO entries (metric_id, value, recorded_on, recorded_at, note, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const entry of normalized) {
        const result = insert.run(entry.metricId, entry.value, entry.recordedOn, entry.recordedAt, entry.note, entry.source);
        ids.push(Number(result.lastInsertRowid));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ids, count: ids.length, errors };
  }

  async entryById(id) {
    return this.db.prepare(`
      SELECT e.id, m.metric_key AS metricKey, m.name, m.domain, m.unit, m.precision,
             e.value, e.recorded_on AS recordedOn, e.recorded_at AS recordedAt,
             e.note, e.source
      FROM entries e JOIN metrics m ON m.id = e.metric_id
      WHERE e.id = ?
    `).get(id) || null;
  }

  async updateEntry(id, patch) {
    const existing = await this.entryById(id);
    if (!existing) return null;
    // recordedAt 和 source 属于审计信息，编辑时不覆盖，沿用首次写入的值。
    const entry = normalizeEntry(
      { ...existing, ...patch, recordedAt: existing.recordedAt, source: existing.source },
      await this.metrics()
    );
    this.db.prepare(`
      UPDATE entries SET metric_id = ?, value = ?, recorded_on = ?, note = ? WHERE id = ?
    `).run(entry.metricId, entry.value, entry.recordedOn, entry.note, id);
    return this.entryById(id);
  }

  async deleteEntry(id) {
    return Boolean(this.db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes);
  }

  async createTask(body) {
    const result = this.db.prepare('INSERT INTO tasks (title, domain, due_on, priority) VALUES (?, ?, ?, ?)').run(
      normalizeTaskTitle(body.title),
      ['business', 'health', 'planning'].includes(body.domain) ? body.domain : 'planning',
      normalizeDueOn(body.dueOn),
      ['high', 'normal', 'low'].includes(body.priority) ? body.priority : 'normal'
    );
    return Number(result.lastInsertRowid);
  }

  async taskById(id) {
    return this.db.prepare(`
      SELECT id, title, domain, due_on AS dueOn, priority, status,
             completed_at AS completedAt, created_at AS createdAt
      FROM tasks WHERE id = ?
    `).get(id) || null;
  }

  async updateTask(id, patch) {
    const existing = await this.taskById(id);
    if (!existing) return null;
    const title = patch.title === undefined ? existing.title : normalizeTaskTitle(patch.title);
    const status = patch.status === undefined ? existing.status : (patch.status === 'done' ? 'done' : 'open');
    const domain = ['business', 'health', 'planning'].includes(patch.domain) ? patch.domain : existing.domain;
    const priority = ['high', 'normal', 'low'].includes(patch.priority) ? patch.priority : existing.priority;
    const dueOn = patch.dueOn === undefined ? existing.dueOn : normalizeDueOn(patch.dueOn);
    // 只有状态真正翻转时才重写完成时间，原样保存不该刷新它。
    const completedAt = status === existing.status
      ? existing.completedAt
      : (status === 'done' ? new Date().toISOString() : null);
    this.db.prepare(`
      UPDATE tasks SET title = ?, domain = ?, due_on = ?, priority = ?, status = ?, completed_at = ? WHERE id = ?
    `).run(title, domain, dueOn, priority, status, completedAt, id);
    return this.taskById(id);
  }

  async deleteTask(id) {
    return Boolean(this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes);
  }

  async createReport(period, title, summary, dashboard) {
    const result = this.db.prepare(`
      INSERT INTO reports (period, title, summary, payload_json) VALUES (?, ?, ?, ?)
    `).run(period, title, summary, JSON.stringify(dashboard));
    return Number(result.lastInsertRowid);
  }

  async reportList() {
    return this.db.prepare(`
      SELECT id, period, title, summary, created_at AS createdAt
      FROM reports ORDER BY id DESC LIMIT 20
    `).all();
  }

  // 列表里不带 payload —— 一份报告的快照有几十 KB，二十份一起给前端太重。
  // 展开哪一份再单独取。
  async reportById(id) {
    const row = this.db.prepare(`
      SELECT id, period, title, summary, payload_json AS payloadJson, created_at AS createdAt
      FROM reports WHERE id = ?
    `).get(id);
    if (!row) return null;
    const { payloadJson, ...rest } = row;
    return { ...rest, dashboard: JSON.parse(payloadJson) };
  }

  async exportAll() {
    return {
      metrics: await this.metrics(),
      entries: await this.latestEntries(100000),
      tasks: await this.taskList(),
      reports: this.db.prepare('SELECT * FROM reports ORDER BY id').all()
    };
  }
}
