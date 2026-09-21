// 测鸿蒙端那份 xlsx 解析逻辑。
//
// 为什么需要：那段代码在手机上跑，我这边没有真机，编译通过不代表解析对 ——
// 正则写错、列取错、边界算错，全都能编译过去，只在用户选文件时才炸。
//
// 做法是从 entry/src/main/ets/service/XlsxImport.ets 里**把纯函数抠出来**
// 直接在 Node 里跑（不是抄一份，抄的会漂），喂真实导出文件，然后和
// import-pdd-export.mjs 的结果对比：两边必须得出同样的四个数。
//
// 用法：node scripts/test-xlsx-parser.mjs [导出文件.xlsx]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'E:/workspace/PersonalDashboard/entry/src/main/ets/service/XlsxImport.ets';
const xlsx = process.argv[2] || 'D:/桌面/商品数据.xlsx';

let pass = 0;
const fails = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(` FAIL  ${label}${detail ? `  →  ${detail}` : ''}`); }
};

if (!existsSync(sourcePath)) {
  console.error(`找不到鸿蒙端源码：${sourcePath}`);
  process.exit(1);
}
if (!existsSync(xlsx)) {
  console.error(`找不到测试用的导出文件：${xlsx}`);
  console.error('用法：node scripts/test-xlsx-parser.mjs <导出文件.xlsx>');
  process.exit(1);
}

// ---- 从 .ets 里抠出纯函数 ----
let source = readFileSync(sourcePath, 'utf8');
// 去掉 import 行和那两个依赖鸿蒙运行时的类/函数
source = source.split('\n').filter((line) => !line.trim().startsWith('import ')).join('\n');
source = stripBlock(source, 'export class XlsxImporter');
source = stripBlock(source, 'function readText');

function stripBlock(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return text;
  let depth = 0;
  let i = text.indexOf('{', start);
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return text.slice(0, start) + text.slice(i + 1);
}

// 抠出来的代码里不能有 ArkTS 专有的东西，有就是抠漏了
for (const forbidden of ['fileIo', 'zlib', 'util.TextDecoder', 'picker']) {
  if (source.includes(forbidden)) {
    console.error(`抠出来的代码里还有 ${forbidden}，stripBlock 需要补充`);
    process.exit(1);
  }
}

// 抠出来的是 ArkTS（TypeScript 语法），不能当 JS 直接跑。
// Node 24 自带类型剥离，写成 .ts 再 import 就行，不用为此装 typescript。
// 那几个函数在源码里本来就是 export function，不用再补 export 语句（补了会重复导出）
const moduleSource = `${source}\n`;
const tsDir = mkdtempSync(path.join(tmpdir(), 'xlsx-ts-'));
const tsPath = path.join(tsDir, 'parser.ts');
writeFileSync(tsPath, moduleSource, 'utf8');
let mod;
try {
  mod = await import(`file://${tsPath.replace(/\\/g, '/')}`);
} catch (err) {
  console.error('导入抠出来的代码失败：' + err.message);
  console.error('（Node 需要能剥类型注解，版本要 22.6 以上）');
  process.exit(1);
}

// ---- 拿真实文件喂进去 ----
const tmp = mkdtempSync(path.join(tmpdir(), 'xlsx-test-'));
execFileSync('unzip', ['-o', '-q', xlsx, '-d', tmp]);
const sharedXml = readFileSync(path.join(tmp, 'xl/sharedStrings.xml'), 'utf8');
const sheetXml = readFileSync(path.join(tmp, 'xl/worksheets/sheet1.xml'), 'utf8');

console.log('从鸿蒙端源码抠出纯函数，喂真实导出文件：\n');

const result = mod.extractTotals(sharedXml, sheetXml);
check('解析成功（ok=true）', result.ok === true, result.error);

// ---- 和电脑端脚本对比 ----
// 从 dry-run 的输出里抠数字当基准。两边独立实现，结论必须一致。
const dry = execFileSync('node', [
  path.join(rootDir, 'scripts/import-pdd-export.mjs'), xlsx, '--dry-run'
], { encoding: 'utf8', cwd: rootDir });

const pick = (label) => {
  const line = dry.split('\n').find((l) => l.trim().startsWith(label));
  return line ? Number(line.match(/([\d.]+)\s+←/)?.[1]) : NaN;
};

const pairs = [
  ['销售额', 'revenue', result.revenue],
  ['销量', 'orders', result.orders],
  ['广告花费', 'adSpend', result.adSpend],
  ['退款金额', 'refunds', result.refunds]
];

for (const [label, key, actual] of pairs) {
  const want = pick(label);
  check(`${label}：鸿蒙端 ${actual} 和电脑端 ${want} 一致`, actual === want, `差 ${actual - want}`);
}

console.log('\n顺带看看解析耗时（手机上有 250KB XML 要扫）：');
const t0 = process.hrtime.bigint();
mod.extractTotals(sharedXml, sheetXml);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`  一次解析 ${ms.toFixed(1)} ms`);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
