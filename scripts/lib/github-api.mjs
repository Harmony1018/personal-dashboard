// GitHub REST API 的最小封装。
//
// 为什么需要它：这台机器上 github.com:443 不可达（被墙），git push / fetch / clone 全都不通，
// 但 api.github.com 可达。所以推送和发布都改走 REST API。
// 详见 scripts/push-via-api.mjs 和 scripts/deploy-pages.mjs 的说明。

import { execFileSync } from 'node:child_process';

export const REPO = 'Harmony1018/personal-dashboard';

export function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // 退回 Windows 凭据管理器里给 git 用的那份 token
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8'
    });
    const match = out.match(/^password=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // 落到下面的报错
  }
  throw new Error('拿不到 GitHub token：设置 GITHUB_TOKEN，或确认凭据管理器里存了 github.com 的凭据');
}

export function createClient(token) {
  const request = async (method, endpoint, body) => {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'personal-dashboard-deploy'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      // 404 在写 .github/workflows/ 时代表缺 workflow 权限，补一句人话
      const hint = response.status === 404 && endpoint.includes('/git/') && body
        ? '（若涉及 .github/workflows/，404 通常表示 token 缺少 workflow 权限）'
        : '';
      throw new Error(`${method} ${endpoint} -> ${response.status} ${text.slice(0, 300)}${hint}`);
    }
    return payload;
  };

  return {
    request,
    blob: (content) =>
      request('POST', `/repos/${REPO}/git/blobs`, {
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64'
      }),
    tree: (entries, baseTree) =>
      request('POST', `/repos/${REPO}/git/trees`, baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries }),
    commit: (payload) => request('POST', `/repos/${REPO}/git/commits`, payload),
    ref: async (branch) => {
      try {
        return await request('GET', `/repos/${REPO}/git/ref/heads/${branch}`);
      } catch (error) {
        if (error.message.includes('-> 404')) return null;
        throw error;
      }
    },
    // force 只在重写历史时用（比如把误提交的文件从历史里摘掉）。
    // 常规推送一律 force: false，让远端自己挡住覆盖。
    setRef: (branch, sha, force = false) =>
      request('PATCH', `/repos/${REPO}/git/refs/heads/${branch}`, { sha, force }),
    createRef: (branch, sha) =>
      request('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha })
  };
}
