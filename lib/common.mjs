export const metricSeeds = [
  { metricKey: 'business.revenue', name: '销售额', domain: 'business', unit: '¥', precision: 2, goal: null, goalMode: 'higher', sortOrder: 10 },
  // 叫「销量」而不是「订单数」：拼多多导出里给的是件数（销量 71），
  // 不是订单数（发货订单量 55）。两个数不一样，一个订单可能含多件。
  { metricKey: 'business.orders', name: '销量', domain: 'business', unit: '件', precision: 0, goal: null, goalMode: 'higher', sortOrder: 20 },
  { metricKey: 'business.ad_spend', name: '广告花费', domain: 'business', unit: '¥', precision: 2, goal: null, goalMode: 'lower', sortOrder: 30 },
  { metricKey: 'business.refunds', name: '退款金额', domain: 'business', unit: '¥', precision: 2, goal: null, goalMode: 'lower', sortOrder: 40 },
  { metricKey: 'health.sleep', name: '睡眠', domain: 'health', unit: '小时', precision: 1, goal: 7.5, goalMode: 'higher', sortOrder: 10 },
  { metricKey: 'health.exercise', name: '运动', domain: 'health', unit: '分钟', precision: 0, goal: 30, goalMode: 'higher', sortOrder: 20 },
  { metricKey: 'health.weight', name: '体重', domain: 'health', unit: 'kg', precision: 1, goal: null, goalMode: 'neutral', sortOrder: 30 },
  { metricKey: 'health.mood', name: '状态', domain: 'health', unit: '分', precision: 0, goal: 4, goalMode: 'higher', sortOrder: 40 },
  { metricKey: 'planning.focus', name: '专注时间', domain: 'planning', unit: '分钟', precision: 0, goal: 90, goalMode: 'higher', sortOrder: 10 }
];

export function isoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 校验类错误：消息可以安全地回给调用方。api-handler 只把 expose 为 true 的
// 错误原文返回，其余一律降级成通用 500 —— 否则 TypeError 文案、PostgREST 的
// 表名列名会顺着响应漏到浏览器。
export function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

// 严格校验 YYYY-MM-DD：格式要对，而且得是真日期。
// 2026-13-45 会被 Date 悄悄滚到下一年，所以回写一遍再比对。
export function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && isoDate(date) === value;
}

export function addDays(dateString, amount) {
  // 日期非法时绝不能返回 "NaN-NaN-NaN"：它恰好是 buildDashboard 里
  // `cursor <= to` 那个循环的不动点，字符串比较下条件恒为真，整个服务会
  // 同步死循环 —— 连 /api/health 都不再响应，只能重启进程。
  if (!isValidIsoDate(dateString)) throw validationError('日期格式无效，请用 YYYY-MM-DD');
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return isoDate(date);
}

// 截止日允许为空（表示没有截止日），填了就必须是合法日期。
export function normalizeDueOn(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidIsoDate(value)) throw validationError('截止日期格式无效，请用 YYYY-MM-DD');
  return value;
}

export function normalizeTaskTitle(value) {
  const title = String(value ?? '').trim();
  if (!title) throw validationError('任务标题不能为空');
  // 跟页面上的 maxlength 对齐。以前不设限，塞十万字能把列表渲染卡死。
  return title.slice(0, 100);
}

export function normalizeEntry(body, metrics, sourceOverride) {
  const metric = metrics.find((item) => item.metricKey === body.metricKey);
  if (!metric) throw validationError('指标不存在');

  // Number(null) 得 0、Number(true) 得 1。不拦住的话，一个 JSON 客户端
  // 发出 {"value":null} 会存进一条货真价实的 0 销售额。
  const raw = body.value;
  if (raw === null || raw === undefined || typeof raw === 'boolean' || String(raw).trim() === '') {
    throw validationError('请输入有效数值');
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw validationError('请输入有效数值');

  // 以前格式不对会被静默改写成今天，补录的数据就悄悄落到错误日期上，
  // CSV 导入还不计入错误行 —— 用户完全不会发现。
  let recordedOn = body.recordedOn;
  if (recordedOn === undefined || recordedOn === null || recordedOn === '') {
    recordedOn = isoDate();
  } else if (!isValidIsoDate(recordedOn)) {
    throw validationError('记录日期格式无效，请用 YYYY-MM-DD');
  }

  const recordedAt = body.recordedAt || new Date().toISOString();
  if (Number.isNaN(new Date(recordedAt).getTime())) throw validationError('记录时间格式无效');

  return {
    metricId: metric.id,
    value,
    recordedOn,
    recordedAt,
    note: String(body.note || '').slice(0, 500),
    source: String(sourceOverride || body.source || 'manual').slice(0, 60)
  };
}

function sum(entries, metricKey, from, to) {
  return entries
    .filter((entry) => entry.metricKey === metricKey && entry.recordedOn >= from && entry.recordedOn <= to)
    .reduce((total, entry) => total + Number(entry.value), 0);
}

function average(entries, metricKey, from, to) {
  const values = entries
    .filter((entry) => entry.metricKey === metricKey && entry.recordedOn >= from && entry.recordedOn <= to)
    .map((entry) => Number(entry.value));
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function last(entries, metricKey) {
  return entries
    .filter((entry) => entry.metricKey === metricKey)
    .sort((a, b) => `${b.recordedOn}${b.recordedAt}`.localeCompare(`${a.recordedOn}${a.recordedAt}`))[0] || null;
}

export async function buildDashboard(store, days, to = isoDate()) {
  const from = addDays(to, -(days - 1));
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  const [entries, tasks] = await Promise.all([
    store.entriesBetween(previousFrom, to),
    store.taskList()
  ]);

  const chartKeys = new Set([
    'business.revenue', 'business.orders', 'business.ad_spend',
    'health.sleep', 'health.exercise', 'planning.focus'
  ]);
  const dailyMap = new Map();
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) dailyMap.set(cursor, { day: cursor });
  for (const entry of entries) {
    if (!dailyMap.has(entry.recordedOn) || !chartKeys.has(entry.metricKey)) continue;
    const day = dailyMap.get(entry.recordedOn);
    day[entry.metricKey] = Number(day[entry.metricKey] || 0) + Number(entry.value);
  }

  const revenue = sum(entries, 'business.revenue', from, to);
  const previousRevenue = sum(entries, 'business.revenue', previousFrom, previousTo);
  const orders = sum(entries, 'business.orders', from, to);
  const adSpend = sum(entries, 'business.ad_spend', from, to);
  const refunds = sum(entries, 'business.refunds', from, to);
  const sleepAverage = average(entries, 'health.sleep', from, to);
  const exercise = sum(entries, 'health.exercise', from, to);
  const focus = sum(entries, 'planning.focus', from, to);
  const relevantTasks = tasks.filter((task) => !task.dueOn || task.dueOn <= to);
  const taskCounts = { total: relevantTasks.length, done: relevantTasks.filter((task) => task.status === 'done').length };
  const revenueChange = previousRevenue === 0 ? null : ((revenue - previousRevenue) / previousRevenue) * 100;

  // 环比。求和型和平均型不能混：睡眠按天取平均，销售额按天求和。
  const changeTargets = {
    'business.revenue': 'sum', 'business.orders': 'sum', 'business.ad_spend': 'sum',
    'health.sleep': 'average', 'health.exercise': 'sum', 'planning.focus': 'sum'
  };
  const changes = {};
  for (const [key, mode] of Object.entries(changeTargets)) {
    const pick = mode === 'average'
      ? (start, end) => average(entries, key, start, end)
      : (start, end) => sum(entries, key, start, end);
    const current = pick(from, to);
    const previous = pick(previousFrom, previousTo);
    changes[key] = {
      current,
      previous,
      // 上一周期是 0（或压根没记录）时环比没有意义，给 null 让前端显示「等待上一周期数据」。
      change: previous ? ((current - previous) / previous) * 100 : null
    };
  }

  // 同 chart 的理由：changes 的键是业务指标键（带点），ArkTS 取不了 obj['business.revenue']，
  // 所以鸿蒙端一直没用上这份数据。另给一份数组形状的，键名都成了普通字符串字段。
  // 顺序跟 changeTargets 一致，网页端继续用 changes，两边互不牵制。
  const changeList = Object.keys(changeTargets).map((metricKey) => ({
    metricKey,
    current: changes[metricKey].current,
    previous: changes[metricKey].previous,
    change: changes[metricKey].change
  }));

  // 每个指标最近一次记录的值，给指标目录显示「最近一次」和达标与否。
  // 只看当前窗口内的记录 —— 更早的值对「最近一次」没有参考意义。
  const latest = {};
  for (const entry of entries) {
    const stamp = `${entry.recordedOn} ${entry.recordedAt}`;
    if (!latest[entry.metricKey] || stamp > latest[entry.metricKey].stamp) {
      latest[entry.metricKey] = { stamp, value: Number(entry.value), recordedOn: entry.recordedOn };
    }
  }
  for (const key of Object.keys(latest)) delete latest[key].stamp;

  const insights = [];

  if (revenue || previousRevenue) {
    insights.push({
      tone: revenueChange != null && revenueChange < 0 ? 'warning' : 'positive',
      title: '经营趋势',
      text: revenueChange == null
        ? `本周期已记录销售额 ¥${revenue.toFixed(2)}，积累更多历史数据后可进行环比。`
        : `销售额较上一周期${revenueChange >= 0 ? '增长' : '下降'} ${Math.abs(revenueChange).toFixed(1)}%。`
    });
  }
  if (revenue > 0 && adSpend > 0) {
    const ratio = (adSpend / revenue) * 100;
    insights.push({
      tone: ratio > 30 ? 'warning' : 'neutral',
      title: '广告投入',
      text: `广告花费占销售额 ${ratio.toFixed(1)}%，当前未计入成本和平台费用。`
    });
  }
  if (sleepAverage != null) {
    insights.push({
      tone: sleepAverage < 7 ? 'warning' : 'positive',
      title: '恢复状态',
      text: `平均睡眠 ${sleepAverage.toFixed(1)} 小时，${sleepAverage < 7 ? '低于建议目标，请留意连续不足。' : '达到当前目标区间。'}`
    });
  }
  if (!insights.length) insights.push({ tone: 'neutral', title: '开始记录', text: '添加今天的数据后，这里会出现趋势和异常提示。' });

  return {
    range: { from, to, days },
    overview: {
      revenue, orders, adSpend, refunds, sleepAverage, exercise, focus,
      weight: last(entries, 'health.weight'),
      mood: last(entries, 'health.mood'),
      tasks: taskCounts,
      revenueChange,
      changes,
      latest
    },
    series: [...dailyMap.values()],
    // 给鸿蒙端的。ArkTS 不允许 obj['business.revenue'] 这种带点的键取属性，
    // 所以另给一份字段名干净的。网页端继续用 series，两边不互相牵制。
    chart: [...dailyMap.values()].map((day) => ({
      day: day.day,
      revenue: Number(day['business.revenue'] || 0),
      orders: Number(day['business.orders'] || 0),
      adSpend: Number(day['business.ad_spend'] || 0),
      sleep: Number(day['health.sleep'] || 0),
      exercise: Number(day['health.exercise'] || 0),
      focus: Number(day['planning.focus'] || 0)
    })),
    changeList,
    insights
  };
}
