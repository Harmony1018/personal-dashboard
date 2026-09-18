export const metricSeeds = [
  { metricKey: 'business.revenue', name: '销售额', domain: 'business', unit: '¥', precision: 2, goal: null, goalMode: 'higher', sortOrder: 10 },
  { metricKey: 'business.orders', name: '订单数', domain: 'business', unit: '单', precision: 0, goal: null, goalMode: 'higher', sortOrder: 20 },
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

export function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return isoDate(date);
}

export function normalizeEntry(body, metrics, sourceOverride) {
  const metric = metrics.find((item) => item.metricKey === body.metricKey);
  const value = Number(body.value);
  if (!metric) throw new Error('指标不存在');
  if (!Number.isFinite(value)) throw new Error('请输入有效数值');
  return {
    metricId: metric.id,
    value,
    recordedOn: /^\d{4}-\d{2}-\d{2}$/.test(body.recordedOn || '') ? body.recordedOn : isoDate(),
    recordedAt: body.recordedAt || new Date().toISOString(),
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
      revenueChange
    },
    series: [...dailyMap.values()],
    insights
  };
}
