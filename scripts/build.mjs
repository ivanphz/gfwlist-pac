#!/usr/bin/env node
/**
 * gfwlist -> PAC builder
 *
 * 规则来源（优先级由低到高）：
 *   1. 上游 gfwlist                       —— 基础代理清单
 *   2. extraSources 里的第三方清单        —— 可选，默认只报告不改动
 *   3. rules/custom-proxy.txt             —— 自有：强制走代理
 *   4. rules/custom-direct.txt            —— 自有：强制直连（最高）
 *
 * 输出：
 *   <outDir>[/<pathToken>]/proxy.pac      PAC 脚本（ES5 / JScript 兼容）
 *   <outDir>[/<pathToken>]/stats.json     构建统计 + 冲突报告
 *
 * 用法：
 *   node scripts/build.mjs
 *   node scripts/build.mjs --input path.txt   用本地 gfwlist（离线调试）
 *   node scripts/build.mjs --offline          第三方清单只用 .cache/ 里的副本
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(ROOT, ...s);
const CACHE = p('.cache');

/* ---------------------------------------------------------------- config */

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`解析 ${path.basename(file)} 失败: ${e.message}`);
  }
}

export async function loadConfig() {
  const base = await readJson(p('config.json')); // 代码自带的默认值
  if (!base) throw new Error('缺少 config.json');
  const local = await readJson(p('config.local.json'), {}); // 个人覆盖
  const cfg = { ...base, ...local };
  if (base.extraSources || local.extraSources) {
    cfg.extraSources = { ...(base.extraSources || {}) };
    for (const [k, v] of Object.entries(local.extraSources || {})) {
      cfg.extraSources[k] = { ...(cfg.extraSources[k] || {}), ...v };
    }
  }

  // 环境变量优先级最高：仓库公开时把私密项放 GitHub Secrets，不落盘
  if (process.env.PAC_PROXY) {
    cfg.proxy = process.env.PAC_PROXY.includes('|')
      ? process.env.PAC_PROXY.split('|').map((s) => s.trim())
      : process.env.PAC_PROXY;
  }
  if (process.env.PAC_PATH_TOKEN) cfg.pathToken = process.env.PAC_PATH_TOKEN;
  if (process.env.PAC_UPSTREAM) cfg.upstream = process.env.PAC_UPSTREAM;

  if (!cfg.proxy) throw new Error('config 中必须有 proxy 字段');
  if (cfg.pathToken && !/^[A-Za-z0-9._-]+$/.test(cfg.pathToken)) {
    throw new Error('pathToken 只能用字母数字和 . _ -');
  }
  return cfg;
}

const CHAIN_SCHEMES = /^(DIRECT|PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)$/i;
// WinINET / WinHTTP（也就是 Windows「使用设置脚本」那条路）只认这几种。
// Chrome / Firefox 有自己的 PAC 引擎，额外支持 SOCKS / SOCKS4 / SOCKS5。
const WININET_SCHEMES = /^(DIRECT|PROXY)$/i;

/**
 * 检查代理链。返回 { errors, warns }。
 * errors 会直接中断构建 —— 这些写法会让 PAC 被客户端整个丢弃，
 * 表现成「像是没配 PAC 一样」，比构建失败难查得多。
 */
export function validateChain(list, opts = {}) {
  const errors = [];
  const warns = [];
  const endpoints = new Set();
  const socksHops = [];
  let sawWinInetHop = false;

  for (const hop of list) {
    const m = hop.trim().match(/^(\S+)(?:\s+(\S+))?$/);
    if (!m) {
      errors.push(`代理链条目格式看不懂: "${hop}"`);
      continue;
    }
    const [, scheme, addr] = m;
    if (!CHAIN_SCHEMES.test(scheme)) {
      errors.push(`"${hop}" 的类型 ${scheme} 不是合法的 PAC 关键字`);
      continue;
    }
    if (/^SOCKS/i.test(scheme)) socksHops.push(hop);
    if (/^DIRECT$/i.test(scheme)) {
      sawWinInetHop = true;
      continue;
    }
    if (!addr) {
      warns.push(`"${hop}" 缺少 host:port`);
      continue;
    }

    const pm = addr.match(/^(.+):(\d+)$/);
    if (!pm) {
      errors.push(`"${hop}" 的地址不是 host:port 形式`);
      continue;
    }
    const port = Number(pm[2]);
    if (port === 0) {
      warns.push(
        `"${hop}" 用了端口 0。0 不是合法 TCP 端口，不同客户端处理不一致：` +
          `有的整条跳过、有的会归一成默认端口（万一本机 80/1080 上真跑着东西，` +
          `被 block 的流量就送错地方了）。建议改成 127.0.0.1:1 —— ` +
          `合法端口、实际无人占用，环回口上立刻收到 RST，失败更快也更确定。`
      );
    } else if (port > 65535) {
      errors.push(`"${hop}" 的端口 ${port} 超出范围`);
    }

    endpoints.add(addr);
    if (WININET_SCHEMES.test(scheme)) sawWinInetHop = true;
  }

  if (socksHops.length && !opts.allowSocks) {
    errors.push(
      `代理链里有 SOCKS 条目（${socksHops.join(', ')}）。\n` +
        '        Windows 的系统代理（WinINET / WinHTTP）不支持 SOCKS，而且实测表明\n' +
        '        很多客户端遇到不认识的关键字不是跳过该条、而是把整个返回值判为无效，\n' +
        '        表现成「像是根本没配 PAC」——Google Drive 桌面端就是这样。\n' +
        '        请全部改成 PROXY。确实只给 Chrome/Firefox 用、且清楚后果的话，\n' +
        '        在 config 里设 "allowSocks": true 显式放行。'
    );
  }
  if (!sawWinInetHop && !errors.length) {
    errors.push('整条链里没有 PROXY 或 DIRECT，走系统代理的程序会全部连不上。');
  }

  // 末端的 block 地址不算冗余，排掉再判断
  const real = [...endpoints].filter((a) => !/:(0|1)$/.test(a));
  if (real.length === 1 && list.filter((h) => !/^DIRECT$/i.test(h)).length > 2) {
    warns.push(
      `链上多跳都指向同一个 ${real[0]}。如果它是混合端口（同时提供 SOCKS 和 HTTP），` +
        `这样写是对的 —— 分别照顾浏览器和系统代理两条路径；` +
        `但要注意进程一挂两跳一起失效，这不构成真正的冗余。`
    );
  }
  return { errors, warns };
}

/**
 * 把 proxy / fallback 拼成 PAC 的返回值字符串。
 *   ["SOCKS5 127.0.0.1:1080", "PROXY 127.0.0.1:7890"] + fallback:"block"
 *   -> "SOCKS5 127.0.0.1:1080; PROXY 127.0.0.1:7890; PROXY 127.0.0.1:1"
 */
export function buildProxyChain(cfg) {
  const list = (Array.isArray(cfg.proxy) ? cfg.proxy : String(cfg.proxy).split(';'))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!list.length) throw new Error('proxy 不能为空');

  const blockProxy = cfg.blockProxy || 'PROXY 127.0.0.1:1';
  const tail = list[list.length - 1].toUpperCase();
  const fallback = (cfg.fallback || 'block').toLowerCase();

  if (tail !== 'DIRECT' && list[list.length - 1] !== blockProxy) {
    if (fallback === 'direct') list.push('DIRECT');
    else if (fallback === 'block') list.push(blockProxy);
    else if (fallback !== 'none') {
      throw new Error(`fallback 只能是 block / direct / none，收到 ${cfg.fallback}`);
    }
  }
  return list.join('; ');
}

/* ----------------------------------------------------------- rule parsing */

const RE_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const RE_CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
// 合法域名（至少两段）
const RE_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// 单段：顶级域规则，只在自有规则里允许（含 punycode 的 IDN 顶级域）
const RE_TLD = /^(xn--[a-z0-9-]+|[a-z]{2,})$/;

/** 从规则里切出「主机名」那一段（去协议、路径、端口、根点），不做合法性判断 */
function extractHostPart(s) {
  if (!s) return '';
  let h = s.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // 去 scheme
  h = h.split('/')[0].split('?')[0].split('#')[0];
  h = h.replace(/:\d+$/, '');
  h = h.replace(/\.+$/, '');
  return h;
}

function normalizeHost(s) {
  const h = extractHostPart(s);
  if (!h) return null;
  if (RE_IPV4.test(h)) return h;
  if (!RE_DOMAIN.test(h)) return null;
  return h;
}

/** `*.foo.com` 这种整段通配的，等价于普通域名规则 */
function globToDomain(g) {
  const m = g.match(/^\*+\.(.+)$/);
  return m ? normalizeHost(m[1]) : null;
}

/**
 * IPv6 归一化：展开成 8 组 4 位小写十六进制。
 * 2001:db8::1 -> 2001:0db8:0000:0000:0000:0000:0000:0001
 * 内嵌 IPv4 的写法（::ffff:1.2.3.4、2001:db8::1.2.3.4）也一并处理。
 */
export function expandV6(input) {
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^\[/, '').replace(/\]$/, '');
  s = s.replace(/%[0-9a-z]+$/, ''); // 去掉 zone id，如 fe80::1%eth0
  if (!s.includes(':')) return null;

  // 尾部内嵌的 IPv4 转成两组十六进制
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, -v4[1].length) + hi + ':' + lo;
  }

  let groups;
  if (s.includes('::')) {
    const parts = s.split('::');
    if (parts.length !== 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill('0'), tail);
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/** IPv6 CIDR -> 十六进制前缀（去掉冒号）。前缀长度必须是 4 的倍数。 */
export function v6Prefix(input) {
  const m = String(input).trim().match(/^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/i);
  if (!m) return null;
  const bits = Number(m[2]);
  if (bits < 0 || bits > 128 || bits % 4 !== 0) return null;
  const full = expandV6(m[1]);
  if (!full) return null;
  return full.split(':').join('').slice(0, bits / 4);
}

/** CIDR -> ["网络地址", "掩码"]，给 PAC 的 isInNet 用 */
function cidrToNetmask(s) {
  const m = String(s).trim().match(RE_CIDR);
  if (!m) return null;
  const bits = Number(m[2]);
  if (bits < 0 || bits > 32) return null;
  const octets = m[1].split('.').map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return null;
  const ipInt = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const maskInt = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (ipInt & maskInt) >>> 0;
  const toDot = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  return [toDot(net), toDot(maskInt)];
}

/**
 * 把正则规则降级成 shExpMatch 的 glob，返回数组（可能多条）。
 * 只处理形状明确的；带反向断言 / 命名分组 / 字符集的一律返回 []，
 * 交给上层进 skipped 列表由人工决定，绝不猜、绝不硬塞进关键词。
 *
 *   /^https?:\/\/[^\/]+blogspot\.(.*)/
 *     -> ["*blogspot.*"]
 *   ^https?:\/\/(?=.*?(2x3|ni5|j5o))[a-z0-9.-]+\.xn--ngstr-lra8j\.com$
 *     -> ["*2x3*.xn--ngstr-lra8j.com", "*ni5*...", "*j5o*..."]
 */
function regexToGlobs(src) {
  let s = String(src);

  // 去掉 /.../ 定界符。上游偶尔会漏掉收尾那个斜杠，这里两种都认。
  if (s.startsWith('/')) s = s.slice(1);
  if (s.endsWith('/')) s = s.slice(0, -1);

  // JScript 不支持的语法，一律放弃（硬塞进去会让整个 PAC 加载失败）
  if (/\(\?<|\\p\{|\\k</i.test(s)) return [];

  // 抽出「URL 里必须含有其中之一」的前视断言：(?=.*?(A|B|C))
  let alts = null;
  const look = s.match(/^\^?(?:https\?:\\?\/\\?\/)?\(\?=\.[*+]\??\(([^)]*)\)\)/);
  if (look) {
    const parts = look[1].split('|').map((x) => x.trim().toLowerCase());
    if (parts.length && parts.every((x) => /^[a-z0-9_-]+$/.test(x))) alts = parts;
    else return [];
    s = s.slice(look[0].length);
    s = '^https?:\\/\\/' + s; // 把协议头补回去，走下面的通用流程
  }
  // 还残留断言/反向引用就放弃
  if (/\(\?[!<]/.test(s)) return [];

  s = s.replace(/^\^https\?:\\?\/\\?\//, '');
  s = s.replace(/^\^\(\.\+\\?\.\)\*/, '*.'); // ^(.+\.)*
  s = s.replace(/\[\^\\?\/\]\+/g, '*'); // [^/]+
  s = s.replace(/\[a-z0-9.\\?-\]\+/g, '*'); // [a-z0-9.-]+
  s = s.replace(/\(\.\*\??\)|\.\*\??|\.\+\??/g, '*'); // (.*) .* .+
  s = s.replace(/\\([./-])/g, '$1'); // 反转义
  s = s.replace(/^\^/, '').replace(/\$$/, '');
  s = s.split('/')[0]; // 只取主机部分
  s = s.replace(/\*{2,}/g, '*').toLowerCase();

  if (!/^[a-z0-9.*_-]+$/.test(s)) return []; // 还有正则元字符 -> 放弃
  if (!s.includes('.')) return [];
  if (s.replace(/[*.]/g, '').length < 4) return []; // 太泛，不要

  if (!alts) return [s];
  // 把「必须含有 A」和主机模式合成一条：*.foo.com -> *A*.foo.com
  if (!s.startsWith('*')) return [];
  return alts.map((a) => '*' + a + '*' + s.slice(1));
}

/** 关键词只能是纯字面子串；带正则元字符说明是条没解析干净的规则 */
function looksLikeRegex(s) {
  return /[\^$()[\]{}|\\+?]/.test(s);
}

/**
 * 主机名段含通配符 -> 走 shExpMatch；否则当普通域名。
 * allowTld=true 时，单段（cn / com）当顶级域后缀规则。
 */
function hostRule(rawHost, reasonTag, allowTld = false) {
  const h = extractHostPart(rawHost);
  if (!h) return { kind: 'skip', value: rawHost, reason: reasonTag };

  if (h.includes('*')) {
    const asDomain = globToDomain(h); // *.foo.com == ||foo.com
    if (asDomain) return { kind: 'domain', value: asDomain };
    if (h.includes('.')) return { kind: 'glob', value: h };
    return { kind: 'skip', value: rawHost, reason: 'wildcard-single-label' };
  }

  const host = normalizeHost(h);
  if (host) return { kind: 'domain', value: host };
  if (allowTld && RE_TLD.test(h)) return { kind: 'domain', value: h };
  return { kind: 'skip', value: rawHost, reason: reasonTag };
}

/* -------------------------------------------------- 上游 gfwlist（AutoProxy） */

function emptyBuckets() {
  return {
    domain: new Set(),
    exact: new Set(),
    glob: new Set(),
    cidr: new Set(),
    v6: new Set(), // IPv6 精确地址（已展开成 8 组）
    v6net: new Set(), // IPv6 前缀（十六进制，无冒号）
    keyword: new Set(),
  };
}

function addGlob(bucket, g) {
  bucket.glob.add(g);
  bucket.glob.add('*.' + g); // 以及其子域
}

function parseAutoProxy(text) {
  const proxy = emptyBuckets();
  const direct = emptyBuckets();
  const skipped = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[') continue;

    const isException = line.startsWith('@@');
    const body = isException ? line.slice(2) : line;
    const b = isException ? direct : proxy;

    let r;
    // 正则规则：标准写法是 /pattern/，但上游偶尔漏掉收尾斜杠，
    // 所以只要以 / 开头且长得像正则就按正则处理，不能让它掉进关键词兜底。
    const looksRegex =
      body.length > 1 &&
      body[0] === '/' &&
      (body[body.length - 1] === '/' || /[\^$\\]/.test(body));

    if (looksRegex) {
      const globs = regexToGlobs(body);
      if (globs.length) r = { kind: 'globs', value: globs };
      else r = { kind: 'skip', value: body, reason: 'regex-untranslatable' };
    } else if (body.startsWith('||')) {
      r = hostRule(body.slice(2), 'bad-domain'); // 上游不允许单段 TLD 规则
    } else if (body.startsWith('|')) {
      const rest = body.replace(/^\|+/, '');
      r = /^[a-z][a-z0-9+.-]*:\/\//i.test(rest)
        ? hostRule(rest, 'anchored-url')
        : { kind: 'skip', value: body, reason: 'anchored-non-url' };
    } else if (body.startsWith('.')) {
      r = hostRule(body.slice(1), 'dot-rule');
    } else {
      const host = normalizeHost(body);
      if (host) r = { kind: 'domain', value: host };
      else if (looksLikeRegex(body)) {
        // 带正则元字符的东西当子串匹配永远匹配不上，直接报告
        r = { kind: 'skip', value: body, reason: 'regex-like-not-keyword' };
      } else {
        const kw = body.replace(/\*/g, '').trim().toLowerCase();
        r =
          kw.length >= 4
            ? { kind: 'keyword', value: kw }
            : { kind: 'skip', value: body, reason: 'too-short' };
      }
    }

    if (r.kind === 'domain') b.domain.add(r.value);
    else if (r.kind === 'glob') addGlob(b, r.value);
    else if (r.kind === 'globs') for (const g of r.value) b.glob.add(g);
    else if (r.kind === 'keyword') b.keyword.add(r.value);
    else skipped.push(`${isException ? '@@' : ''}${r.value}  (${r.reason})`);
  }
  return { proxy, direct, skipped };
}

/* ------------------------------------------- 第三方清单（v2ray-rules-dat 风格） */

/**
 * 解析 Loyalsoldier/v2ray-rules-dat 的 *-list.txt。
 * 语法：bare / domain:x / full:x / keyword:x / regexp:x，可带 " @attr" 后缀。
 */
function parseDomainList(text) {
  const b = emptyBuckets();
  const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line[0] === '#') continue;
    line = line.split(/\s+@/)[0].trim(); // 去掉 " @cn" 之类的属性
    if (!line) continue;

    const i = line.indexOf(':');
    const pre = i < 0 ? '' : line.slice(0, i).toLowerCase();
    const val = i < 0 ? line : line.slice(i + 1);

    if (pre === 'full') {
      const h = normalizeHost(val);
      if (h) b.exact.add(h);
      else skipped.push(line);
    } else if (pre === 'keyword') {
      if (val.length >= 4 && !looksLikeRegex(val)) b.keyword.add(val.toLowerCase());
      else skipped.push(line);
    } else if (pre === 'regexp') {
      const globs = regexToGlobs(val);
      if (globs.length) for (const g of globs) b.glob.add(g);
      else skipped.push(line);
    } else if (pre === 'domain' || i < 0) {
      const r = hostRule(val, 'list');
      if (r.kind === 'domain') b.domain.add(r.value);
      else if (r.kind === 'glob') addGlob(b, r.value);
      else skipped.push(line);
    } else {
      skipped.push(line);
    }
  }
  return { buckets: b, skipped };
}

/** 只保留和 gfwlist 代理集合真正打架的条目 */
function conflictsWith(candidates, gfwProxy) {
  const sameDomain = []; // 整域冲突：两边都指名同一个域
  const carveOut = []; // 子域挖孔：gfwlist 代理父域，这里指定某个子域直连
  for (const e of candidates) {
    if (gfwProxy.has(e)) {
      sameDomain.push(e);
      continue;
    }
    let h = e;
    for (;;) {
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
      if (gfwProxy.has(h)) {
        carveOut.push(e);
        break;
      }
    }
  }
  return { sameDomain, carveOut };
}

async function fetchCached(url, name, offline) {
  const file = path.join(CACHE, name);
  if (!offline) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'gfwlist-pac-builder' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await fs.mkdir(CACHE, { recursive: true });
      await fs.writeFile(file, text, 'utf8');
      return text;
    } catch (e) {
      console.warn(`[warn] 拉取 ${name} 失败（${e.message}），改用本地缓存`);
    }
  }
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    // 第三方清单挂了不该拖垮整个构建 —— gfwlist 才是主线
    console.warn(`[warn] ${name} 既拉不到也没有缓存，本次跳过该清单`);
    return null;
  }
}

/* --------------------------------------------------------- 自有规则 */

export async function loadCustom(file) {
  let text = '';
  try {
    text = await fs.readFile(p('rules', file), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { buckets: emptyBuckets(), bad: [] };
  }

  const b = emptyBuckets();
  const bad = [];

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    line = line.split(/\s+#/)[0].trim(); // 支持行尾注释
    if (!line) continue;

    // 允许 AutoProxy 语法混写
    line = line.replace(/^@@/, '').replace(/^\|\|/, '').replace(/^\|/, '');

    const low = line.toLowerCase();
    if (low.startsWith('keyword:')) {
      const kw = line.slice(8).trim().toLowerCase();
      if (kw && !looksLikeRegex(kw)) b.keyword.add(kw);
      else bad.push(raw.trim());
      continue;
    }
    if (low.startsWith('full:')) {
      const h = normalizeHost(line.slice(5));
      if (h) b.exact.add(h);
      else bad.push(raw.trim());
      continue;
    }
    if (RE_CIDR.test(line)) {
      const nm = cidrToNetmask(line);
      if (nm) b.cidr.add(nm.join(' '));
      else bad.push(raw.trim());
      continue;
    }
    // IPv6：2001:db8::1 或 2001:db8::/32，方括号可有可无
    if (/^\[?[0-9a-f]*:[0-9a-f:.]*\]?(\/\d{1,3})?$/i.test(line) && line.includes(':')) {
      if (line.includes('/')) {
        const pfx = v6Prefix(line);
        if (pfx !== null) b.v6net.add(pfx);
        else bad.push(raw.trim() + '  (IPv6 前缀长度必须是 4 的倍数)');
      } else {
        const full = expandV6(line);
        if (full) b.v6.add(full);
        else bad.push(raw.trim());
      }
      continue;
    }

    const r = hostRule(line, 'custom', /* allowTld */ true);
    if (r.kind === 'domain') b.domain.add(r.value);
    else if (r.kind === 'glob') addGlob(b, r.value);
    else bad.push(raw.trim());
  }
  return { buckets: b, bad };
}

/* --------------------------------------------------------- 合并 / 去冗余 */

function mergeInto(target, src) {
  for (const k of Object.keys(target)) for (const v of src[k]) target[k].add(v);
}

/** 如果 a.b.com 的父域 b.com 已在集合里，a.b.com 就是多余的 */
function dropRedundant(set) {
  const out = new Set();
  for (const d of set) {
    let h = d;
    let covered = false;
    for (;;) {
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
      if (set.has(h)) {
        covered = true;
        break;
      }
    }
    if (!covered) out.add(d);
  }
  return out;
}

/* ------------------------------------------------------------ PAC 生成 */

function jsObject(set) {
  const keys = [...set].sort();
  if (!keys.length) return '{}';
  const lines = [];
  for (let i = 0; i < keys.length; i += 4) {
    lines.push(keys.slice(i, i + 4).map((k) => `"${k}":1`).join(','));
  }
  return '{\n' + lines.join(',\n') + '\n}';
}

function jsArray(set) {
  return '[' + [...set].sort().map((k) => `"${k}"`).join(',') + ']';
}

function jsNets(set) {
  const rows = [...set].sort().map((s) => {
    const [net, mask] = s.split(' ');
    return `["${net}","${mask}"]`;
  });
  return '[' + rows.join(',') + ']';
}

function buildPac(cfg, chain, defaultAction, d) {
  const meta = [
    `generated by gfwlist-pac  ${new Date().toISOString()}`,
    `upstream : ${cfg.upstream}`,
    `proxy    : ${chain}`,
    `default  : ${defaultAction === 'D' ? 'DIRECT（不在规则里就直连）' : 'PROXY'}`,
    `domains  : ${d.proxy.domain.size} proxy / ${d.direct.domain.size} direct`,
  ].join('\n// ');

  return `// ${meta}
//
// 本文件必须保持 ES5/JScript 语法（Windows 用旧版 JScript 引擎跑 PAC）。
// 不要出现 let / const / => / Set / 模板字符串，否则会静默失效。

var P = "${chain.replace(/"/g, '\\"')}";
var D = "DIRECT";
var DEF = ${defaultAction};

// 精确匹配（不含子域）
var PROXY_F = ${jsObject(d.proxy.exact)};
var DIRECT_F = ${jsObject(d.direct.exact)};

// 域名后缀（含所有子域）
var PROXY_D = ${jsObject(d.proxy.domain)};
var DIRECT_D = ${jsObject(d.direct.domain)};

// IP 网段 [网络地址, 掩码]
var PROXY_N = ${jsNets(d.proxy.cidr)};
var DIRECT_N = ${jsNets(d.direct.cidr)};

// IPv6 精确地址（已展开成 8 组 4 位）
var PROXY_V6 = ${jsObject(d.proxy.v6)};
var DIRECT_V6 = ${jsObject(d.direct.v6)};

// IPv6 前缀（十六进制，无冒号）
var PROXY_V6N = ${jsArray(d.proxy.v6net)};
var DIRECT_V6N = ${jsArray(d.direct.v6net)};

// 通配主机名
var PROXY_G = ${jsArray(d.proxy.glob)};
var DIRECT_G = ${jsArray(d.direct.glob)};

// 整条 URL 关键词
var PROXY_K = ${jsArray(d.proxy.keyword)};
var DIRECT_K = ${jsArray(d.direct.keyword)};

function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

function isIPv4(h) {
    return /^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(h);
}

function inAnyNet(h, list) {
    var i;
    for (i = 0; i < list.length; i++) {
        if (isInNet(h, list[i][0], list[i][1])) return true;
    }
    return false;
}

// 把 IPv6 展开成 8 组 4 位十六进制，方便做精确/前缀匹配
function expandV6(a) {
    var i, g, parts, head, tail, groups, m4, o, s;
    a = ("" + a).toLowerCase();
    if (a.charAt(0) === "[") a = a.substring(1);
    if (a.charAt(a.length - 1) === "]") a = a.substring(0, a.length - 1);
    i = a.indexOf("%");
    if (i >= 0) a = a.substring(0, i);          // 去掉 zone id
    if (a.indexOf(":") < 0) return null;

    // 尾部内嵌的 IPv4 转成两组十六进制
    m4 = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m4) {
        o = m4[1].split(".");
        a = a.substring(0, a.length - m4[1].length)
            + ((parseInt(o[0], 10) << 8) | parseInt(o[1], 10)).toString(16) + ":"
            + ((parseInt(o[2], 10) << 8) | parseInt(o[3], 10)).toString(16);
    }

    if (a.indexOf("::") >= 0) {
        parts = a.split("::");
        if (parts.length !== 2) return null;
        head = parts[0] ? parts[0].split(":") : [];
        tail = parts[1] ? parts[1].split(":") : [];
        groups = [];
        for (i = 0; i < head.length; i++) groups.push(head[i]);
        for (i = head.length + tail.length; i < 8; i++) groups.push("0");
        for (i = 0; i < tail.length; i++) groups.push(tail[i]);
    } else {
        groups = a.split(":");
    }
    if (groups.length !== 8) return null;

    s = "";
    for (i = 0; i < 8; i++) {
        g = groups[i];
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        while (g.length < 4) g = "0" + g;
        s += (i ? ":" : "") + g;
    }
    return s;
}

function hasPrefix(hex, list) {
    var i;
    for (i = 0; i < list.length; i++) {
        if (hex.substring(0, list[i].length) === list[i]) return true;
    }
    return false;
}

function routeV6(a) {
    var full = expandV6(a);
    if (full === null) return DEF;              // 不认识的写法，交给默认动作
    var hex = full.split(":").join("");
    var p3 = hex.substring(0, 3);
    var p2 = hex.substring(0, 2);

    // ::1 本机 / :: 未指定
    if (hex === "00000000000000000000000000000001") return D;
    if (hex === "00000000000000000000000000000000") return D;
    // fe80::/10 链路本地
    if (p3 === "fe8" || p3 === "fe9" || p3 === "fea" || p3 === "feb") return D;
    // fc00::/7 唯一本地地址（相当于 IPv6 的内网段）
    if (p2 === "fc" || p2 === "fd") return D;

    if (has(DIRECT_V6, full)) return D;
    if (has(PROXY_V6, full)) return P;
    if (hasPrefix(hex, DIRECT_V6N)) return D;
    if (hasPrefix(hex, PROXY_V6N)) return P;
    return DEF;                                 // 其余按默认动作，不再一刀切直连
}

function isPrivateIP(h) {
    return isInNet(h, "10.0.0.0", "255.0.0.0")
        || isInNet(h, "172.16.0.0", "255.240.0.0")
        || isInNet(h, "192.168.0.0", "255.255.0.0")
        || isInNet(h, "127.0.0.0", "255.0.0.0")
        || isInNet(h, "169.254.0.0", "255.255.0.0")
        || isInNet(h, "100.64.0.0", "255.192.0.0");
}

function FindProxyForURL(url, host) {
    host = ("" + host).toLowerCase();

    // ---- IPv6 字面量 ----
    var v6 = null, rb, m4;
    if (host.charAt(0) === "[") {
        rb = host.indexOf("]");
        v6 = rb > 0 ? host.substring(1, rb) : host.substring(1);
    } else if (host.indexOf(":") >= 0
               && host.indexOf(":", host.indexOf(":") + 1) >= 0) {
        v6 = host;                              // 裸 IPv6，不可能带端口
    }
    if (v6 !== null) {
        // IPv4 映射地址 ::ffff:1.2.3.4 拆回 IPv4，走下面那套规则
        m4 = v6.toLowerCase().match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        if (m4) host = m4[1];
        else return routeV6(v6);
    }

    // 去掉端口和结尾的点
    var c1 = host.indexOf(":");
    if (c1 >= 0) host = host.substring(0, c1);
    while (host.length && host.charAt(host.length - 1) === ".") {
        host = host.substring(0, host.length - 1);
    }
    if (!host.length) return D;

    // 单标签主机名（intranet / localhost / nas）直连
    if (isPlainHostName(host)) return D;

    // 精确匹配优先于一切后缀规则
    if (has(DIRECT_F, host)) return D;
    if (has(PROXY_F, host)) return P;

    // IP 字面量：不做后缀上溯，单独走一套
    if (isIPv4(host)) {
        if (isPrivateIP(host)) return D;
        if (has(DIRECT_D, host)) return D;
        if (has(PROXY_D, host)) return P;
        if (inAnyNet(host, DIRECT_N)) return D;
        if (inAnyNet(host, PROXY_N)) return P;
        return DEF;
    }

    // 直连通配：白名单例外规则优先于一切后缀规则（ABP 里 @@ 就是这个语义）
    var k;
    for (k = 0; k < DIRECT_G.length; k++) {
        if (shExpMatch(host, DIRECT_G[k])) return D;
    }

    // 域名后缀逐级上溯：最长匹配优先，同级 DIRECT 压过 PROXY
    var h = host;
    for (;;) {
        if (has(DIRECT_D, h)) return D;
        if (has(PROXY_D, h)) return P;
        var i = h.indexOf(".");
        if (i < 0) break;
        h = h.substring(i + 1);
    }

    // 代理通配
    for (k = 0; k < PROXY_G.length; k++) {
        if (shExpMatch(host, PROXY_G[k])) return P;
    }

    // 整条 URL 关键词兜底
    var u = ("" + url).toLowerCase();
    var j;
    for (j = 0; j < DIRECT_K.length; j++) {
        if (u.indexOf(DIRECT_K[j]) >= 0) return D;
    }
    for (j = 0; j < PROXY_K.length; j++) {
        if (u.indexOf(PROXY_K[j]) >= 0) return P;
    }

    return DEF;
}
`;
}

/* ------------------------------------------------------------------ main */

async function getUpstream(cfg, argv) {
  const idx = argv.indexOf('--input');
  let raw;
  if (idx >= 0 && argv[idx + 1]) {
    raw = await fs.readFile(argv[idx + 1], 'utf8');
    console.log(`[src] gfwlist <- 本地文件 ${argv[idx + 1]}`);
  } else {
    console.log(`[src] gfwlist <- ${cfg.upstream}`);
    const res = await fetch(cfg.upstream, { headers: { 'user-agent': 'gfwlist-pac-builder' } });
    if (!res.ok) throw new Error(`上游返回 ${res.status} ${res.statusText}`);
    raw = await res.text();
  }

  // gfwlist.txt 是 base64；list.txt 是明文。自动识别。
  const head = raw.slice(0, 200);
  if (!head.includes('[AutoProxy') && /^[A-Za-z0-9+/=\s]+$/.test(head)) {
    raw = Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8');
    console.log('[src] 已 base64 解码');
  }
  if (!raw.includes('[AutoProxy')) {
    throw new Error('上游内容不像 AutoProxy 格式，已中止（避免生成空 PAC）');
  }
  return raw;
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const cfg = await loadConfig();
  const chain = buildProxyChain(cfg);
  const chk = validateChain(
    chain.split(';').map((s) => s.trim()),
    { allowSocks: cfg.allowSocks === true }
  );
  for (const w of chk.warns) console.warn(`[warn] 代理链: ${w}`);
  if (chk.errors.length) {
    throw new Error('代理链有致命问题：\n  - ' + chk.errors.join('\n  - '));
  }
  const chainWarns = chk.warns;
  const defaultAction =
    (cfg.defaultAction || 'direct').toLowerCase() === 'proxy' ? 'P' : 'D';

  const parsed = parseAutoProxy(await getUpstream(cfg, argv));
  const proxy = parsed.proxy;
  const direct = parsed.direct;
  const gfwProxySnapshot = new Set(proxy.domain);

  /* ---- 第三方清单 ---- */
  const report = {};
  for (const [name, src] of Object.entries(cfg.extraSources || {})) {
    if (!src || src.enabled === false) continue;
    const mode = (src.mode || 'report').toLowerCase();
    const side = (src.side || 'direct').toLowerCase();
    const text = await fetchCached(src.url, `${name}.txt`, offline);
    if (text === null) {
      report[name] = { mode, side, skipped: 'unavailable' };
      continue;
    }
    const { buckets, skipped } = parseDomainList(text);
    const total = buckets.domain.size + buckets.exact.size;

    if (side === 'direct') {
      const c = conflictsWith([...buckets.domain, ...buckets.exact], gfwProxySnapshot);
      report[name] = {
        mode,
        side,
        totalEntries: total,
        sameDomainConflicts: c.sameDomain.length,
        subdomainCarveOuts: c.carveOut.length,
        sameDomainList: c.sameDomain.sort(),
        carveOutList: c.carveOut.sort(),
        unparsed: skipped.length,
      };
      if (mode === 'report') {
        console.log(
          `[src] ${name}: ${total} 条，仅报告。与 gfwlist 冲突 ` +
            `${c.sameDomain.length} 整域 + ${c.carveOut.length} 子域，未改动规则`
        );
      } else if (mode === 'intersect') {
        for (const d of c.sameDomain) direct.domain.add(d);
        for (const d of c.carveOut) direct.domain.add(d);
        console.log(
          `[src] ${name}: ${total} 条，intersect 模式，` +
            `采纳 ${c.sameDomain.length + c.carveOut.length} 条直连`
        );
      } else if (mode === 'full') {
        mergeInto(direct, buckets);
        console.log(`[src] ${name}: ${total} 条，full 模式全量并入直连（PAC 会明显变大）`);
      } else {
        throw new Error(`extraSources.${name}.mode 只能是 report / intersect / full`);
      }
    } else {
      report[name] = { mode, side, totalEntries: total, unparsed: skipped.length };
      if (mode === 'full') {
        mergeInto(proxy, buckets);
        console.log(`[src] ${name}: ${total} 条，全量并入代理`);
      } else {
        console.log(`[src] ${name}: ${total} 条，仅报告（side=proxy 只支持 full 生效）`);
      }
    }
  }

  /* ---- 自有规则：最高优先级 ---- */
  const cProxy = await loadCustom('custom-proxy.txt');
  const cDirect = await loadCustom('custom-direct.txt');
  for (const b of [...cProxy.bad, ...cDirect.bad]) {
    console.warn(`[warn] 自有规则无法解析，已忽略: ${b}`);
  }

  // 记录自有规则到底覆盖了什么，写进 stats 方便核对
  const overrides = { customDirectBeatsProxy: [], customProxyBeatsDirect: [] };
  for (const d of cDirect.buckets.domain) {
    if (proxy.domain.has(d)) overrides.customDirectBeatsProxy.push(d);
    proxy.domain.delete(d);
  }
  for (const d of cProxy.buckets.domain) {
    if (direct.domain.has(d)) overrides.customProxyBeatsDirect.push(d);
    direct.domain.delete(d);
  }
  mergeInto(proxy, cProxy.buckets);
  mergeInto(direct, cDirect.buckets);

  const beforeProxy = proxy.domain.size;
  const beforeDirect = direct.domain.size;
  proxy.domain = dropRedundant(proxy.domain);
  direct.domain = dropRedundant(direct.domain);

  if (proxy.cidr.size + direct.cidr.size > 200) {
    console.warn(
      `[warn] CIDR 规则 ${proxy.cidr.size + direct.cidr.size} 条，` +
        `每个 IP 请求都要线性扫一遍，建议控制在 200 条以内`
    );
  }

  const pac = buildPac(cfg, chain, defaultAction, { proxy, direct });

  /* ---- 落盘 ---- */
  const rootDir = p(cfg.outDir || 'public');
  await fs.rm(rootDir, { recursive: true, force: true });
  const outDir = cfg.pathToken ? path.join(rootDir, cfg.pathToken) : rootDir;
  await fs.mkdir(outDir, { recursive: true });
  try {
    await fs.cp(p('static'), rootDir, { recursive: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const outFile = path.join(outDir, cfg.fileName || 'proxy.pac');
  await fs.writeFile(outFile, pac, 'utf8');
  await fs.writeFile(
    path.join(rootDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>.</title>\n',
    'utf8'
  );

  const stats = {
    builtAt: new Date().toISOString(),
    upstream: cfg.upstream,
    proxyChain: chain,
    proxyChainWarnings: chainWarns,
    fallback: cfg.fallback || 'block',
    defaultAction: defaultAction === 'D' ? 'direct' : 'proxy',
    counts: {
      proxyDomains: proxy.domain.size,
      directDomains: direct.domain.size,
      proxyExact: proxy.exact.size,
      directExact: direct.exact.size,
      proxyCidr: proxy.cidr.size,
      directCidr: direct.cidr.size,
      proxyGlobs: proxy.glob.size,
      directGlobs: direct.glob.size,
      proxyKeywords: proxy.keyword.size,
      directKeywords: direct.keyword.size,
    },
    custom: {
      proxyRules:
        cProxy.buckets.domain.size + cProxy.buckets.exact.size + cProxy.buckets.cidr.size,
      directRules:
        cDirect.buckets.domain.size + cDirect.buckets.exact.size + cDirect.buckets.cidr.size,
      unparsed: [...cProxy.bad, ...cDirect.bad],
    },
    overrides,
    extraSources: report,
    redundantDropped: beforeProxy - proxy.domain.size + (beforeDirect - direct.domain.size),
    skippedUpstreamRules: parsed.skipped.length,
    skippedSamples: parsed.skipped.slice(0, 20),
    bytes: Buffer.byteLength(pac),
  };
  await fs.writeFile(path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');

  // 兜底断言：上游被墙 / 返回空页面时不要覆盖成空规则
  if (proxy.domain.size < 1000) {
    throw new Error(`代理域名只有 ${proxy.domain.size} 条，疑似上游异常，构建失败`);
  }

  console.log(
    `[ok] ${path.relative(ROOT, outFile)}  ${(stats.bytes / 1024).toFixed(1)} KB  ` +
      `proxy=${proxy.domain.size} direct=${direct.domain.size}  ` +
      `自有 +${stats.custom.proxyRules}/-${stats.custom.directRules}  ` +
      `默认${defaultAction === 'D' ? '直连' : '代理'}`
  );
  console.log(`[ok] 代理链: ${chain}`);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((e) => {
    console.error('[fail] ' + e.message);
    process.exit(1);
  });
}
