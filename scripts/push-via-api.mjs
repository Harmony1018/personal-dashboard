// 当 github.com:443 不可达（被墙 / 代理没开）但 api.github.com 可达时，
// 用 GitHub REST API 把本地某个提交原样搬到远端。
//
// 关键在于「原样」：GitHub 自己算 blob/tree/commit 的 SHA，只要喂进去的字节
// 和本地 git 对象一致，产出的 SHA 就会和本地完全一样，本地和远端不会分叉。
// 每一步都做校验，任何一步对不上就中止，远端不会被改坏。
//
// 用法：node scripts/push-via-api.mjs [提交] [分支]   （默认 HEAD、当前分支）
// 注意：本脚本推不了 .github/workflows/ 下的改动 —— 那需要 token 带 workflow 权限。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, getToken } from './lib/github-api.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 这个仓库的 git 目录属主和当前用户不一致，读 git 要带 safe.directory
const safeDir = rootDir.replace(/\\/g, '/');
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${safeDir}`, ...args], {
  cwd: rootDir,
  maxBuffer: 64 * 1024 * 1024
});

const argv = process.argv.slice(2).filter((item) => !item.startsWith('--'));
const force = process.argv.includes('--force');
const commit = argv[0] || 'HEAD';
const branch = argv[1] || git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim();

const sha = git('rev-parse', commit).toString().trim();
const raw = git('cat-file', 'commit', sha);

// commit 对象 = 头部若干行 + 空行 + message。message 必须逐字节保留，
// 否则算出来的 SHA 就和本地对不上。
const splitAt = raw.indexOf('\n\n');
if (splitAt < 0) throw new Error('无法解析 commit 对象');
const header = raw.subarray(0, splitAt).toString('utf8');
const message = raw.subarray(splitAt + 2).toString('utf8');

const headerValue = (key) => (header.match(new RegExp(`^${key} (.+)$`, 'm')) || [])[1];
const treeSha = headerValue('tree');
const parents = header.split('\n').filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));

const ident = (key) => {
  const value = headerValue(key);
  const match = value.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`无法解析 ${key}: ${value}`);
  const [, name, email, epoch, tz] = match;
  // git 存的是 epoch + 时区偏移，API 要的是「该时区的墙上时间 + 偏移」。
  // 先把 epoch 加上偏移再按 UTC 格式化，得到的才是墙上时间；
  // 直接 toISOString 再贴偏移会差一个时区，算出来的 SHA 就对不上了。
  const offsetSeconds =
    (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 3600 + Number(tz.slice(3, 5)) * 60);
  const wallClock = new Date((Number(epoch) + offsetSeconds) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '');
  return { name, email, date: `${wallClock}${tz.slice(0, 3)}:${tz.slice(3)}` };
};

const author = ident('author');
const committer = ident('committer');
const client = createClient(getToken());

const check = (label, expected, actual) => {
  const ok = expected === actual;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}  ${actual}${ok ? '' : `  （期望 ${expected}）`}`);
  if (!ok) throw new Error(`${label} 不匹配，已中止：远端未被修改`);
};

const ref = await client.ref(branch);
const remoteHead = ref ? ref.object.sha : null;
console.log(`远端 ${branch} = ${remoteHead || '(不存在)'}`);
console.log(`本地 ${commit} = ${sha}`);
if (remoteHead === sha) {
  console.log('远端已经是这个提交，无需推送。');
  process.exit(0);
}
// 默认要求本提交是远端 head 的直接后继，防止误覆盖别人的提交。
// --force 用于重写历史（把误提交的内容从历史里摘掉）—— 这时远端 head
// 会变成一个孤儿，所以先把要丢弃的提交列出来，别让人蒙着眼睛覆盖。
if (remoteHead !== parents[0]) {
  if (!force) {
    throw new Error(`远端 head 不是本提交的父提交 ${parents[0] || '(根提交)'}，先对齐再推，避免覆盖。`);
  }
  if (remoteHead === null) throw new Error('远端分支不存在，无法判断要丢弃什么');
  const dropped = git('log', '--oneline', `${parents[0] || ''}..${remoteHead}`).toString().trim();
  console.log('⚠️  --force：远端 head 不是本提交的父提交，以下是即将被丢弃的远端提交：');
  console.log(dropped ? dropped.split('\n').map((line) => `     ${line}`).join('\n') : '     （无）');
  console.log('');
}

const changed = git('diff-tree', '-r', '--no-commit-id', '--name-status', `${sha}^`, sha)
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);

const entries = [];
for (const line of changed) {
  const [status, ...rest] = line.split('\t');
  const filePath = rest[rest.length - 1]; // 重命名时取新路径
  if (status === 'D') {
    entries.push({ path: filePath, mode: '100644', type: 'blob', sha: null });
    console.log(`  删除 ${filePath}`);
    continue;
  }
  const localBlob = git('rev-parse', `${sha}:${filePath}`).toString().trim();
  const mode = git('ls-tree', sha, '--', filePath).toString().split(/\s+/)[0];
  const blob = await client.blob(git('cat-file', 'blob', localBlob));
  check(`blob ${filePath}`, localBlob, blob.sha);
  entries.push({ path: filePath, mode, type: 'blob', sha: blob.sha });
}

const baseTree = git('rev-parse', `${parents[0]}^{tree}`).toString().trim();
const newTree = await client.tree(entries, baseTree);
check('tree', treeSha, newTree.sha);

const newCommit = await client.commit({ message, tree: newTree.sha, parents, author, committer });
check('commit', sha, newCommit.sha);

if (ref) await client.setRef(branch, newCommit.sha, force);
else await client.createRef(branch, newCommit.sha);

console.log(`\n已推送：${branch} -> ${newCommit.sha}（与本地一致，未分叉）`);
