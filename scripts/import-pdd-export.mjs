// 读公司数据平台导出的 xlsx，把「合计」行的经营数据灌进面板。
//
// 用法：
//   node scripts/import-pdd-export.mjs <文件.xlsx>            # 导入，日期=今天
//   node scripts/import-pdd-export.mjs <文件.xlsx> --dry-run  # 只看会写什么，不提交
//   node scripts/import-pdd-export.mjs <文件.xlsx> --date 2026-09-20   # 补录某一天
//
// 走的是 /api/automation/entries，一次请求把 4 条记录写完，
// 来源标记为「拼多多导出」，在面板的记录列表里能和手记的区分开。
//
// 关于口径：销售额取「销售额」列（毛），不是「净销售额(支付)」。
// 因为面板里销售额和退款金额是两个独立字段，净额 = 销售额 - 退款 正好对得上；
// 若取净销售额再单独记退款，等于把退款扣了两遍。

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 导出文件的表头在第 1 行（A–Z 列）；AA 列之后表头在第 2 行。
// 不写死列号，按表头名字找 —— 哪天公司平台调整了列顺序也不会错位。
const FIELDS = [
  { header: '销售额', metricKey: 'business.revenue', label: '销售额', round: 2 },
  { header: '销量', metricKey: 'business.orders', label: '销量', round: 0 },
  { header: '推广费用(账单)', metricKey: 'business.ad_spend', label: '广告花费', round: 2 },
  { header: '退款金额', metricKey: 'business.refunds', label: '退款金额', round: 2 }
];

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

// xlsx 就是个 zip。用系统的 unzip 解出来，避免为这一个脚本装依赖。
function readSheet(file) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pdd-'));
  try {
    execFileSync('unzip', ['-o', '-q', file, '-d', tmp]);
    const sharedXml = readFileSync(path.join(tmp, 'xl/sharedStrings.xml'), 'utf8');
    const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      decodeEntities([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
    const sheetXml = readFileSync(path.join(tmp, 'xl/worksheets/sheet1.xml'), 'utf8');

    const rows = new Map(); // 行号 -> Map(列字母 -> 值)
    for (const rowMatch of sheetXml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = new Map();
      for (const c of rowMatch[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
        const [, col, attrs, inner] = c;
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        let value = v ? v[1] : '';
        if (attrs.includes('t="s"')) value = shared[Number(value)] ?? '';
        else if (attrs.includes('t="inlineStr"')) {
          const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          value = t ? decodeEntities(t[1]) : '';
        } else value = decodeEntities(String(value));
        cells.set(col, value);
      }
      rows.set(Number(rowMatch[1]), cells);
    }
    return rows;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 这份导出的表头是两级的：第 1 行是 A–Z 的**主列**，
// 第 2 行是 AA 之后那一组**明细**列（「净销售额(支付)明细」那个分组）。
// 两组里有重名的列（销量、退款金额、推广费用(账单)…），值通常一样，
// 但万一不一致时必须取主列 —— 主列是财务口径的那一套。
function buildHeaderMap(rows) {
  // 导出工具在合并单元格里留下纯数字杂质（26、31 这类），要跳过
  const isNoise = (name) => name.length === 0 || /^\d+(\.\d+)?$/.test(name);
  const collect = (rowNum) => {
    const out = new Map();
    for (const [col, text] of (rows.get(rowNum) || new Map())) {
      const name = String(text).trim();
      if (!isNoise(name)) out.set(col, name);
    }
    return out;
  };
  const primary = collect(1);
  const detail = collect(2);

  const colOf = new Map();
  // 先放明细组里独有的（成本占比、营销占比这类只在这里有）
  const primaryNames = new Set(primary.values());
  for (const [col, name] of detail) {
    if (!primaryNames.has(name)) colOf.set(name, col);
  }
  // 主列最后写入，同名的以主列为准
  for (const [col, name] of primary) colOf.set(name, col);

  const clashes = [...detail.values()].filter((name) => primaryNames.has(name));
  return { colOf, clashes };
}

function findTotalRow(rows) {
  for (const [rowNum, cells] of rows) {
    if (rowNum <= 2) continue;
    if (String(cells.get('A') || '').trim() === '合计') return { rowNum, cells };
  }
  return null;
}

function parseArgs(argv) {
  const args = { file: '', dryRun: false, date: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--date') args.date = argv[++i] || '';
    else if (!args.file) args.file = argv[i];
  }
  return args;
}

// 没给文件路径时，去常见位置找最新的那份导出。
// 这段放在 Node 里而不是 .bat 里，因为路径含中文（D:\桌面），
// cmd.exe 按 ANSI 码页解析批处理，中文路径会碎掉。
function findLatestExport() {
  const home = process.env.USERPROFILE || '';
  const dirs = [
    'D:\\桌面',
    process.env.EXPORT_DIR || '',
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'OneDrive', 'Desktop')
  ].filter((dir) => dir.length > 0 && existsSync(dir));

  const found = [];
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.xlsx$/i.test(name) || name.startsWith('~$')) continue;
      if (!name.includes('商品') && !name.includes('数据')) continue;
      const full = path.join(dir, name);
      try { found.push({ full, mtime: statSync(full).mtimeMs }); } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length > 0 ? found[0].full : '';
}

function localDate() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function readEnv() {
  const text = readFileSync(path.join(rootDir, '.env'), 'utf8');
  const pick = (key) => (text.match(new RegExp(`^${key}=(.+)$`, 'm')) || [])[1];
  return { supabaseUrl: (pick('SUPABASE_URL') || '').trim(), token: (pick('DASHBOARD_TOKEN') || '').trim() };
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  args.file = findLatestExport();
  if (args.file) {
    console.log(`没指定文件，自动用最新的这份：${args.file}\n`);
  } else {
    console.error('没找到导出文件。把 xlsx 拖到这个脚本（或 import-data.bat）上，');
    console.error('或者用 --date 之外的方式显式指定路径：');
    console.error('  node scripts/import-pdd-export.mjs "D:\\桌面\\商品数据.xlsx"');
    process.exit(1);
  }
}
if (!existsSync(args.file)) {
  console.error(`找不到文件：${args.file}`);
  process.exit(1);
}

const recordDate = args.date || localDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
  console.error(`日期格式不对：${recordDate}，应为 YYYY-MM-DD`);
  process.exit(1);
}

const rows = readSheet(args.file);
const { colOf, clashes } = buildHeaderMap(rows);
if (clashes.length) {
  console.log(`注意：${clashes.length} 个列名在主列和明细组里都有（${clashes.slice(0, 4).join('、')}…），一律取主列。\n`);
}
const total = findTotalRow(rows);
if (!total) {
  console.error('在这份表里没找到「合计」行 —— 确认一下导出的是不是商品列表，且没删掉合计行。');
  process.exit(1);
}
console.log(`读到位图：${rows.size} 行，合计行在第 ${total.rowNum} 行\n`);

const entries = [];
const missing = [];
for (const field of FIELDS) {
  const col = colOf.get(field.header);
  if (!col) { missing.push(field.header); continue; }
  const raw = total.cells.get(col);
  const num = Number(raw);
  if (!Number.isFinite(num)) { missing.push(`${field.header}（第 ${col} 列的值不是数字：${JSON.stringify(raw)}）`); continue; }
  const value = Number(num.toFixed(field.round));
  entries.push({ metricKey: field.metricKey, value, recordedOn: recordDate, note: '' });
  console.log(`  ${field.label.padEnd(6)} ${String(value).padStart(12)}   ← 第 ${col} 列「${field.header}」`);
}

if (missing.length) {
  console.error(`\n这些字段没取到，先确认导出文件的表头有没有变：\n  - ${missing.join('\n  - ')}`);
  process.exit(1);
}

console.log(`\n将记录到日期：${recordDate}`);

if (args.dryRun) {
  console.log('\n--dry-run：没有提交。以上就是要写入的 4 条记录。');
  process.exit(0);
}

const { supabaseUrl, token } = readEnv();
if (!token) {
  console.error('.env 里缺 DASHBOARD_TOKEN');
  process.exit(1);
}
// API_BASE 用来指向本地服务做测试，避免误写生产库。正常跑不设它。
const apiBase = process.env.API_BASE
  ? process.env.API_BASE.replace(/\/+$/, '')
  : `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/personal-dashboard`;
if (!apiBase.startsWith('http')) {
  console.error('.env 里缺 SUPABASE_URL，读不到接口地址（或用 API_BASE 显式指定）');
  process.exit(1);
}

// 同一天导入两次会变成 8 条，面板就把数字算了两遍。所以先把当天已经导过的
// 删掉再写新的 —— 重跑等于刷新，而不是累加。手动记的（source=manual）不动。
const authHeader = { authorization: `Bearer ${token}` };
const boot = await (await fetch(`${apiBase}/api/bootstrap?days=7`, { headers: authHeader })).json().catch(() => null);
if (!boot || !Array.isArray(boot.entries)) {
  console.error('读不到现有数据，先确认接口地址和令牌对不对');
  process.exit(1);
}
// 同一天同一个指标，如果还有手记的记录，两边的数会相加。
// 脚本没法替你判断那条手记是「重复」还是「故意另记的」，所以只警告不动它。
const importedKeys = new Set(entries.map((e) => e.metricKey));
const manualClash = boot.entries.filter((e) =>
  e.recordedOn === recordDate && e.source !== '拼多多导出' && importedKeys.has(e.metricKey));
if (manualClash.length > 0) {
  console.log(`\n⚠️  ${recordDate} 这天还有 ${manualClash.length} 条手记的记录，和将要导入的是同一个指标：`);
  for (const clash of manualClash) {
    console.log(`     ${clash.name} ${clash.value} ${clash.unit}（来源 ${clash.source}，id=${clash.id}）`);
  }
  console.log('   导入不会动它们 —— 两条会相加，面板上的数会偏大。');
  console.log('   如果是重复的，请到面板「数据」页把旧的删掉。\n');
}

const stale = boot.entries.filter((e) => e.recordedOn === recordDate && e.source === '拼多多导出');
if (stale.length > 0) {
  console.log(`\n${recordDate} 已经导入过 ${stale.length} 条，先删掉再写新的（重跑=刷新，不会翻倍）`);
  for (const old of stale) {
    await fetch(`${apiBase}/api/entries/${old.id}`, { method: 'DELETE', headers: authHeader });
  }
}

// 线上偶尔会抖（实测遇到过一次 502，同一时间 bootstrap 也返回空）。
// 这个脚本要每天跑，不该因为一次瞬时故障就失败，5xx 和网络错误重试三次。
async function postWithRetry(url, options) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status < 500) return res;
      lastResponse = res;
      console.log(`  第 ${attempt} 次返回 ${res.status}，重试…`);
    } catch {
      console.log(`  第 ${attempt} 次网络错误，重试…`);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  return lastResponse;
}

const response = await postWithRetry(`${apiBase}/api/automation/entries`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ entries, source: '拼多多导出' })
});
const payload = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(`\n导入失败（${response.status}）：${payload.error || JSON.stringify(payload)}`);
  process.exit(1);
}
console.log(`\n已导入 ${payload.imported} 条记录（来源标记为「拼多多导出」）。`);
console.log('打开面板的「数据」页就能看到。');
