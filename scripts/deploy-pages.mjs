// 把 public/ 发布到 gh-pages 分支，供 GitHub Pages 直接托管。
//
// 为什么不用 GitHub Actions：写 .github/workflows/ 需要 token 带 workflow 权限，
// 而当前 token 只有 repo 权限；重新授权又要登录 github.com，那台机器上 github.com 不可达。
// Pages 支持直接按分支发布，于是改成「本地构建 + 推到 gh-pages 分支」，绕开 workflow 权限。
//
// 本地版和线上版的唯一差别是 config.js 里的 apiBase：
//   本地 npm start  -> apiBase 为空，走同源相对路径
//   线上 gh-pages   -> apiBase 指向 Supabase Edge Function
// 这个差异由本脚本在推送时生成，public/config.js 里永远保持为空。
//
// 用法：npm run deploy
//   API_BASE 显式指定接口地址；否则用 .env 里的 SUPABASE_URL 推导。

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, createClient, getToken } from './lib/github-api.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(rootDir, 'public');
const branch = 'gh-pages';

async function walk(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(full, rel)));
    else if (entry.isFile()) files.push({ rel, full });
  }
  return files;
}

async function resolveApiBase() {
  if (process.env.API_BASE) return process.env.API_BASE.replace(/\/+$/, '');
  let env = '';
  try {
    env = await readFile(path.join(rootDir, '.env'), 'utf8');
  } catch {
    throw new Error('没有 API_BASE，也读不到 .env，无法推导接口地址');
  }
  const supabaseUrl = (env.match(/^SUPABASE_URL=(.+)$/m) || [])[1];
  if (!supabaseUrl) throw new Error('.env 里没有 SUPABASE_URL，请显式设置 API_BASE');
  return `${supabaseUrl.trim().replace(/\/+$/, '')}/functions/v1/personal-dashboard`;
}

const apiBase = await resolveApiBase();
console.log(`接口地址 = ${apiBase}`);

// 线上版的 config.js 由这里生成，覆盖仓库里那份（那份是给本地用的）
const generatedConfig = `// 本文件由 scripts/deploy-pages.mjs 生成，请勿在 gh-pages 分支上手动修改。
// 要改接口地址，改仓库 .env 的 SUPABASE_URL 或部署时的 API_BASE，然后重新 npm run deploy。
window.PERSONAL_DASHBOARD_CONFIG = {
  apiBase: '${apiBase}'
};
`;

const files = await walk(publicDir);
console.log(`public/ 下 ${files.length} 个文件`);

const client = createClient(getToken());
const entries = [{ path: '.nojekyll', mode: '100644', type: 'blob', sha: (await client.blob('')).sha }];

for (const file of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
  const content = file.rel === 'config.js' ? generatedConfig : await readFile(file.full);
  const blob = await client.blob(content);
  entries.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  ${file.rel}${file.rel === 'config.js' ? '（已注入 apiBase）' : ''}`);
}

const tree = await client.tree(entries);
const existing = await client.ref(branch);
const stamp = new Date().toISOString();
const commit = await client.commit({
  message: `Deploy site to GitHub Pages\n\napiBase: ${apiBase}`,
  tree: tree.sha,
  parents: existing ? [existing.object.sha] : [],
  author: { name: 'Harmony1018', email: '120187548+Harmony1018@users.noreply.github.com', date: stamp },
  committer: { name: 'Harmony1018', email: '120187548+Harmony1018@users.noreply.github.com', date: stamp }
});

if (existing) await client.setRef(branch, commit.sha);
else await client.createRef(branch, commit.sha);

console.log(`\n已发布 ${branch} -> ${commit.sha}`);
console.log(`站点地址：https://harmony1018.github.io/personal-dashboard/`);
console.log(`（${REPO} 的 Pages 首次发布后需要一两分钟生效）`);
