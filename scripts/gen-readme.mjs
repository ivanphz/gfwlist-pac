#!/usr/bin/env node
/**
 * 由 docs/README.template.md 生成 README.md。
 *
 * 目的：CDN 地址、规则条数这些会变的东西不要手写死。
 * 仓库改名之后，下一次构建 README 里的地址就自动跟着变。
 *
 * 注意：这只解决「文档里的地址是新的」。已经填进 Windows 设置里的那个 URL
 * 不会自动更新 —— 那是系统设置，跟仓库没有任何联系。想要永不变的地址，
 * 还是得用自己的域名（见 README 里那一节）。
 *
 * 仓库名来源优先级：
 *   1. 环境变量 GITHUB_REPOSITORY / GITHUB_REF_NAME（Actions 里自动有）
 *   2. config.json 里的 repo / branch
 *   3. git remote（本地有 git 时）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(ROOT, ...s);

function fromGit() {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function main() {
  const cfg = await loadConfig();

  const repo =
    process.env.GITHUB_REPOSITORY || cfg.repo || fromGit() || 'YOUR-NAME/gfwlist-pac';
  const branch = process.env.GITHUB_REF_NAME || cfg.branch || 'main';

  if (repo.includes('YOUR-NAME')) {
    console.warn(
      '[warn] 拿不到仓库名（不在 Actions 里、config 也没写 repo），' +
        'README 里的 CDN 地址会是占位符'
    );
  }

  const outDir = cfg.outDir || 'public';
  const pacRel = cfg.pathToken
    ? `${outDir}/${cfg.pathToken}/${cfg.fileName || 'proxy.pac'}`
    : `${outDir}/${cfg.fileName || 'proxy.pac'}`;

  // 有构建产物就把真实数字填进去，没有就用占位
  let stats = null;
  try {
    const statsPath = cfg.pathToken
      ? p(outDir, cfg.pathToken, 'stats.json')
      : p(outDir, 'stats.json');
    stats = JSON.parse(await fs.readFile(statsPath, 'utf8'));
  } catch {
    /* 还没构建过，忽略 */
  }

  const ls = stats?.extraSources?.['loyalsoldier-direct'] || {};

  const vars = {
    REPO: repo,
    BRANCH: branch,
    PAC_PATH: pacRel,
    IPV6_MODE: (cfg.ipv6 || 'direct').toLowerCase(),
    PROXY_DOMAINS: stats?.counts?.proxyDomains ?? '—',
    DIRECT_DOMAINS: stats?.counts?.directDomains ?? '—',
    PAC_KB: stats ? (stats.bytes / 1024).toFixed(1) : '—',
    LS_TOTAL: ls.totalEntries?.toLocaleString('en-US') ?? '—',
    LS_SAME: ls.sameDomainConflicts ?? '—',
    LS_CARVE: ls.subdomainCarveOuts ?? '—',
    BUILT_AT: stats?.builtAt?.slice(0, 10) ?? '—',
  };

  let md = await fs.readFile(p('docs', 'README.template.md'), 'utf8');
  for (const [k, v] of Object.entries(vars)) md = md.split(`{{${k}}}`).join(String(v));

  const left = md.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (left) throw new Error(`模板还有未替换的占位符: ${[...new Set(left)].join(', ')}`);

  await fs.writeFile(p('README.md'), md, 'utf8');
  console.log(`[ok] README.md 已生成  repo=${repo} branch=${branch} pac=${pacRel}`);
}

main().catch((e) => {
  console.error('[fail] ' + e.message);
  process.exit(1);
});
