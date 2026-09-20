import { metricSeeds, normalizeEntry } from './common.mjs';

function encodePath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function mapMetric(row) {
  return {
    id: row.id,
    metricKey: row.metric_key,
    name: row.name,
    domain: row.domain,
    unit: row.unit,
    precision: row.precision,
    goal: row.goal,
    goalMode: row.goal_mode,
    sortOrder: row.sort_order
  };
}

function mapEntry(row) {
  const metric = row.metrics || {};
  return {
    id: row.id,
    metricKey: metric.metric_key,
    name: metric.name,
    domain: metric.domain,
    unit: metric.unit,
    precision: metric.precision,
    value: Number(row.value),
    recordedOn: row.recorded_on,
    recordedAt: row.recorded_at,
    note: row.note,
    source: row.source
  };
}

function mapTask(row) {
  return {
    id: row.id,
    title: row.title,
    domain: row.domain,
    dueOn: row.due_on,
    priority: row.priority,
    status: row.status,
    completedAt: row.completed_at,
    createdAt: row.created_at
  };
}

function mapImage(row) {
  return {
    id: row.id,
    objectPath: row.object_path,
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    category: row.category,
    relatedType: row.related_type,
    relatedId: row.related_id,
    capturedAt: row.captured_at,
    note: row.note,
    metadata: row.metadata || {},
    createdAt: row.created_at
  };
}

export class SupabaseStore {
  constructor({ url, serviceKey, bucket = 'personal-images', fetchImpl = fetch }) {
    if (!url || !serviceKey) throw new Error('Supabase URL 和服务端密钥必须同时配置');
    this.url = url.replace(/\/$/, '');
    this.serviceKey = serviceKey;
    this.bucket = bucket;
    this.fetch = (...args) => fetchImpl(...args);
  }

  get headers() {
    return { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}` };
  }

  async request(pathname, options = {}) {
    const headers = { ...this.headers, ...(options.headers || {}) };
    let body = options.body;
    if (body != null && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await this.fetch(`${this.url}${pathname}`, { ...options, headers, body });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = text; }
    }
    if (!response.ok) {
      const message = payload?.message || payload?.error_description || payload?.error || `Supabase 请求失败 (${response.status})`;
      const error = new Error(message);
      error.statusCode = response.status >= 500 ? 502 : response.status;
      throw error;
    }
    return payload;
  }

  async init() {
    const seedRows = metricSeeds.map((item) => ({
      metric_key: item.metricKey,
      name: item.name,
      domain: item.domain,
      unit: item.unit,
      precision: item.precision,
      goal: item.goal,
      goal_mode: item.goalMode,
      sort_order: item.sortOrder,
      active: true
    }));
    try {
      await this.request('/rest/v1/metrics?on_conflict=metric_key', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: seedRows
      });
    } catch (error) {
      throw new Error(`Supabase 初始化失败，请先执行 supabase/migrations/001_initial.sql：${error.message}`);
    }
  }

  async metrics() {
    const rows = await this.request('/rest/v1/metrics?select=id,metric_key,name,domain,unit,precision,goal,goal_mode,sort_order&active=eq.true&order=domain.asc,sort_order.asc,id.asc');
    return rows.map(mapMetric);
  }

  async latestEntries(limit = 50) {
    const query = `/rest/v1/entries?select=id,value,recorded_on,recorded_at,note,source,metrics!inner(metric_key,name,domain,unit,precision)&order=recorded_on.desc,recorded_at.desc,id.desc&limit=${limit}`;
    return (await this.request(query)).map(mapEntry);
  }

  async entriesBetween(from, to) {
    const query = `/rest/v1/entries?select=id,value,recorded_on,recorded_at,note,source,metrics!inner(metric_key,name,domain,unit,precision)&recorded_on=gte.${encodeURIComponent(from)}&recorded_on=lte.${encodeURIComponent(to)}&order=recorded_on.asc,recorded_at.asc,id.asc`;
    return (await this.request(query)).map(mapEntry);
  }

  async taskList() {
    const rows = await this.request('/rest/v1/tasks?select=id,title,domain,due_on,priority,status,completed_at,created_at&order=id.desc');
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    return rows.map(mapTask).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      if (a.priority !== b.priority) return priorityOrder[a.priority] - priorityOrder[b.priority];
      return (a.dueOn || '9999-12-31').localeCompare(b.dueOn || '9999-12-31') || b.id - a.id;
    });
  }

  async createEntry(body, sourceOverride) {
    const entry = normalizeEntry(body, await this.metrics(), sourceOverride);
    const rows = await this.request('/rest/v1/entries', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: {
        metric_id: entry.metricId,
        value: entry.value,
        recorded_on: entry.recordedOn,
        recorded_at: entry.recordedAt,
        note: entry.note,
        source: entry.source
      }
    });
    return rows[0].id;
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
    if (!normalized.length) return { ids: [], count: 0, errors };
    const rows = await this.request('/rest/v1/entries', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: normalized.map((entry) => ({
        metric_id: entry.metricId,
        value: entry.value,
        recorded_on: entry.recordedOn,
        recorded_at: entry.recordedAt,
        note: entry.note,
        source: entry.source
      }))
    });
    return { ids: rows.map((row) => row.id), count: rows.length, errors };
  }

  async entryById(id) {
    const query = `/rest/v1/entries?select=id,value,recorded_on,recorded_at,note,source,metrics!inner(metric_key,name,domain,unit,precision)&id=eq.${encodeURIComponent(id)}&limit=1`;
    const rows = await this.request(query);
    return rows[0] ? mapEntry(rows[0]) : null;
  }

  async updateEntry(id, patch) {
    const existing = await this.entryById(id);
    if (!existing) return null;
    // recordedAt 和 source 属于审计信息，编辑时不覆盖，沿用首次写入的值。
    const entry = normalizeEntry(
      { ...existing, ...patch, recordedAt: existing.recordedAt, source: existing.source },
      await this.metrics()
    );
    const rows = await this.request(`/rest/v1/entries?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: {
        metric_id: entry.metricId,
        value: entry.value,
        recorded_on: entry.recordedOn,
        note: entry.note
      }
    });
    return rows.length ? this.entryById(id) : null;
  }

  async deleteEntry(id) {
    const rows = await this.request(`/rest/v1/entries?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { prefer: 'return=representation' }
    });
    return rows.length > 0;
  }

  async createTask(body) {
    if (!String(body.title || '').trim()) throw new Error('任务标题不能为空');
    const rows = await this.request('/rest/v1/tasks', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: {
        title: String(body.title).trim(),
        domain: ['business', 'health', 'planning'].includes(body.domain) ? body.domain : 'planning',
        due_on: body.dueOn || null,
        priority: ['high', 'normal', 'low'].includes(body.priority) ? body.priority : 'normal'
      }
    });
    return rows[0].id;
  }

  async taskById(id) {
    const rows = await this.request(`/rest/v1/tasks?select=id,title,domain,due_on,priority,status,completed_at,created_at&id=eq.${encodeURIComponent(id)}&limit=1`);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async updateTask(id, patch) {
    const existing = await this.taskById(id);
    if (!existing) return null;
    const title = patch.title === undefined ? existing.title : String(patch.title).trim();
    if (!title) throw new Error('任务标题不能为空');
    const status = patch.status === undefined ? existing.status : (patch.status === 'done' ? 'done' : 'open');
    const domain = ['business', 'health', 'planning'].includes(patch.domain) ? patch.domain : existing.domain;
    const priority = ['high', 'normal', 'low'].includes(patch.priority) ? patch.priority : existing.priority;
    const dueOn = patch.dueOn === undefined ? existing.dueOn : (patch.dueOn || null);
    // 只有状态真正翻转时才重写完成时间，原样保存不该刷新它。
    const completedAt = status === existing.status
      ? existing.completedAt
      : (status === 'done' ? new Date().toISOString() : null);
    const rows = await this.request(`/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: { title, domain, due_on: dueOn, priority, status, completed_at: completedAt }
    });
    return rows.length ? this.taskById(id) : null;
  }

  async deleteTask(id) {
    const rows = await this.request(`/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { prefer: 'return=representation' }
    });
    return rows.length > 0;
  }

  async createReport(period, title, summary, dashboard) {
    const rows = await this.request('/rest/v1/reports', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: { period, title, summary, payload_json: dashboard }
    });
    return rows[0].id;
  }

  async reportList() {
    const rows = await this.request('/rest/v1/reports?select=id,period,title,summary,created_at&order=id.desc&limit=20');
    return rows.map((row) => ({ ...row, createdAt: row.created_at, created_at: undefined }));
  }

  async exportAll() {
    const [metrics, entries, tasks, reports] = await Promise.all([
      this.metrics(),
      this.latestEntries(100000),
      this.taskList(),
      this.request('/rest/v1/reports?select=*&order=id.asc')
    ]);
    return { metrics, entries, tasks, reports };
  }

  async uploadImage({ bytes, originalName, mimeType, category, relatedType, relatedId, capturedAt, note }) {
    const extensions = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/heic': '.heic',
      'image/heif': '.heif'
    };
    const suppliedExtension = originalName.includes('.') ? `.${originalName.split('.').pop()}` : '';
    const extension = extensions[mimeType] || suppliedExtension.toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.bin';
    const now = new Date();
    const objectPath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}${extension}`;
    await this.request(`/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodePath(objectPath)}`, {
      method: 'POST',
      headers: { 'content-type': mimeType, 'x-upsert': 'false' },
      body: bytes
    });
    try {
      const rows = await this.request('/rest/v1/images', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: {
          object_path: objectPath,
          original_name: originalName,
          mime_type: mimeType,
          byte_size: bytes.byteLength,
          category,
          related_type: relatedType,
          related_id: relatedId,
          captured_at: capturedAt,
          note,
          metadata: {}
        }
      });
      return mapImage(rows[0]);
    } catch (error) {
      await this.deleteStorageObjects([objectPath]).catch(() => {});
      throw error;
    }
  }

  async imageList(limit = 50) {
    const rows = await this.request(`/rest/v1/images?select=*&order=created_at.desc&limit=${limit}`);
    return rows.map(mapImage);
  }

  async imageById(id) {
    const rows = await this.request(`/rest/v1/images?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    return rows[0] ? mapImage(rows[0]) : null;
  }

  async signedImageUrl(id, expiresIn = 900) {
    const image = await this.imageById(id);
    if (!image) return null;
    const payload = await this.request(`/storage/v1/object/sign/${encodeURIComponent(this.bucket)}/${encodePath(image.objectPath)}`, {
      method: 'POST', body: { expiresIn }
    });
    const signedPath = payload.signedURL || payload.signedUrl;
    const signedUrl = /^https?:\/\//.test(signedPath) ? signedPath : `${this.url}/storage/v1${signedPath}`;
    return { ...image, signedUrl, expiresIn };
  }

  async deleteStorageObjects(paths) {
    return this.request(`/storage/v1/object/${encodeURIComponent(this.bucket)}`, {
      method: 'DELETE', body: { prefixes: paths }
    });
  }

  async deleteImage(id) {
    const image = await this.imageById(id);
    if (!image) return false;
    await this.deleteStorageObjects([image.objectPath]);
    const rows = await this.request(`/rest/v1/images?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { prefer: 'return=representation' }
    });
    return rows.length > 0;
  }
}
