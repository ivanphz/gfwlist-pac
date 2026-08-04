#!/usr/bin/env node
/**
 * 在沙箱里真跑一遍生成的 PAC，验证路由结果。
 * 同时做 ES5 语法体检（Windows 的 PAC 引擎是老 JScript，不支持 ES6）。
 *
 *   node scripts/test.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadCustom, buildProxyChain } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------- PAC 运行时内置函数（简化实现） ---------------------- */

function isPlainHostName(host) {
  return host.indexOf('.') === -1;
}

function shExpMatch(str, shexp) {
  const re = new RegExp(
    '^' +
      String(shexp)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return re.test(str);
}

function ip2long(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function isInNet(host, pattern, mask) {
  const h = ip2long(host);
  const p = ip2long(pattern);
  const m = ip2long(mask);
  if (h === null || p === null || m === null) return false;
  return ((h & m) >>> 0) === ((p & m) >>> 0);
}

function dnsDomainIs(host, domain) {
  return host.length >= domain.length && host.slice(-domain.length) === domain;
}

/* ------------------------------- 语法体检 ------------------------------- */

const ES6_PATTERNS = [
  [/^[^\S\n]*(?:let|const)\s+[A-Za-z_$]/m, 'let/const'],
  [/=>/, '箭头函数'],
  [/\bnew\s+(?:Set|Map|Promise|WeakMap)\b/, 'ES6 内置对象'],
  [/`/, '模板字符串'],
  [/\.\.\./, '展开运算符'],
  [/\bclass\s+[A-Za-z_$]/, 'class'],
  [/\bfunction\s*\*/, 'generator'],
  [/\basync\b/, 'async'],
  [/\?\./, '可选链'],
  [/\?\?/, '空值合并'],
];

function lintES5(src) {
  // 去掉注释再检查，避免注释里的示例误报
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const found = [];
  for (const [re, name] of ES6_PATTERNS) {
    if (re.test(code)) found.push(name);
  }
  return found;
}

/* --------------------------------- 用例 --------------------------------- */
// [主机名, 期望结果]   'P' = 走代理, 'D' = 直连
const CASES = [
  // 被墙域名及其子域
  ['www.google.com', 'P'],
  ['google.de', 'P'],
  ['mail.google.com', 'P'],
  ['youtube.com', 'P'],
  ['i.ytimg.com', 'P'],
  ['twitter.com', 'P'],
  ['x.com', 'P'],
  ['telegram.org', 'P'],
  ['en.wikipedia.org', 'P'],
  ['foo.blogspot.jp', 'P'], // 正则规则降级成 glob 后应该命中
  ['fbcdn3.akamaihd.net', 'P'], // 通配主机名

  // 国内 / 未列入的域名
  ['www.baidu.com', 'D'],
  ['taobao.com', 'D'],
  ['weixin.qq.com', 'D'],
  ['bilibili.com', 'D'],
  ['gov.cn', 'D'],

  // 内网 / 本机
  ['localhost', 'D'],
  ['nas', 'D'],
  ['192.168.1.1', 'D'],
  ['10.0.0.5', 'D'],
  ['127.0.0.1', 'D'],
  ['172.16.9.9', 'D'],
  ['100.64.0.1', 'D'], // CGNAT / Tailscale

  // 公网 IP 不在内网段，且没有域名规则 -> 直连
  ['1.1.1.1', 'D'],

  // 边界：端口、结尾点、大小写
  ['WWW.GOOGLE.COM', 'P'],
  ['www.google.com.', 'P'],
  ['www.google.com:8443', 'P'],

  // 白名单例外（gfwlist @@ 规则）
  ['www.gov.tw', 'D'],

  // TLD 规则 vs 更具体的 gfwlist 规则：长的先赢
  ['www.qq.com.cn', 'D'],       // 命中 cn
  ['gov.cn', 'D'],
  ['futu.cn', 'P'],             // gfwlist 明确列了，压过 cn
  ['bloomberg.cn', 'P'],
  ['openapi.longbridge.cn', 'P'],

  // 内网域名后缀
  ['printer.lan', 'D'],
  ['nas.home.arpa', 'D'],

  // 公共 DNS 的 IP（只有 DoH 才走 PAC）
  ['114.114.114.114', 'D'],
  ['223.5.5.5', 'D'],
  ['223.6.6.6', 'D'],
  ['223.5.5.99', 'D'],          // 命中 223.5.5.0/24
];

/* --------------------------------- main --------------------------------- */

async function main() {
  const cfg = await loadConfig();
  const pacDir = cfg.pathToken
    ? path.join(ROOT, cfg.outDir || 'public', cfg.pathToken)
    : path.join(ROOT, cfg.outDir || 'public');
  const pacPath = path.join(pacDir, cfg.fileName || 'proxy.pac');
  const src = await fs.readFile(pacPath, 'utf8');

  let failed = 0;

  // 1) ES5 体检
  const es6 = lintES5(src);
  if (es6.length) {
    console.error(`[FAIL] PAC 里出现 ES6 语法，Windows 会静默失效: ${es6.join(', ')}`);
    failed++;
  } else {
    console.log('[ok]   ES5 语法体检通过');
  }

  // 2) 沙箱执行
  const ctx = vm.createContext({
    isPlainHostName,
    shExpMatch,
    isInNet,
    dnsDomainIs,
    Object,
    RegExp,
    String,
  });
  vm.runInContext(src, ctx, { filename: 'proxy.pac' });
  if (typeof ctx.FindProxyForURL !== 'function') {
    console.error('[FAIL] 没有导出 FindProxyForURL');
    process.exit(1);
  }
  console.log('[ok]   PAC 加载成功，FindProxyForURL 可调用');

  // 3) 代理链拼装
  const chain = buildProxyChain(cfg);
  const hops = chain.split(';').map((s) => s.trim());
  const fb = (cfg.fallback || 'block').toLowerCase();
  if (fb === 'block') {
    if (hops[hops.length - 1].toUpperCase() === 'DIRECT') {
      console.error('[FAIL] fallback=block，但代理链结尾是 DIRECT，会泄露流量');
      failed++;
    } else {
      console.log(`[ok]   代理链 ${hops.length} 跳，末端 block: ${chain}`);
    }
  } else {
    console.log(`[ok]   代理链 ${hops.length} 跳: ${chain}`);
  }
  if (cfg.defaultAction && cfg.defaultAction.toLowerCase() === 'proxy') {
    console.log('[warn] defaultAction=proxy，不在规则里的域名会全部走代理');
  }

  // 4) 把 rules/ 里的自有规则也变成用例，确保个性化配置真的生效
  const cProxy = await loadCustom('custom-proxy.txt');
  const cDirect = await loadCustom('custom-direct.txt');
  const cases = CASES.slice();
  const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
  const isTld = (s) => !s.includes('.');
  for (const d of cProxy.buckets.domain) {
    if (cDirect.buckets.domain.has(d)) continue;
    cases.push([d, 'P']);
    if (!isTld(d) && !isIp(d)) cases.push(['sub.' + d, 'P']);
  }
  for (const d of cDirect.buckets.domain) {
    cases.push([d, 'D']);
    if (!isTld(d) && !isIp(d)) cases.push(['sub.' + d, 'D']);
  }
  for (const d of cProxy.buckets.exact) cases.push([d, 'P']);
  for (const d of cDirect.buckets.exact) cases.push([d, 'D']);
  console.log(
    `[ok]   自有规则 ${cProxy.buckets.domain.size} 代理 / ${cDirect.buckets.domain.size} 直连，已纳入用例`
  );

  // 5) 路由用例
  const proxyStr = chain;
  for (const [host, want] of cases) {
    const bare = host.replace(/:\d+$/, '').replace(/\.$/, '');
    const url = 'https://' + bare + '/';
    let got;
    try {
      got = ctx.FindProxyForURL(url, host);
    } catch (e) {
      console.error(`[FAIL] ${host} 抛异常: ${e.message}`);
      failed++;
      continue;
    }
    const isProxy = got !== 'DIRECT';
    const ok = want === 'P' ? isProxy && got === proxyStr : got === 'DIRECT';
    if (!ok) {
      console.error(`[FAIL] ${host}  期望 ${want === 'P' ? '代理' : '直连'}，实际 ${got}`);
      failed++;
    }
  }

  if (failed) {
    console.error(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log(`[ok]   ${cases.length} 条路由用例全部通过`);
}

main().catch((e) => {
  console.error('[fail] ' + e.message);
  process.exit(1);
});
