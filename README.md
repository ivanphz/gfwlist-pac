# gfwlist-pac

把上游 [gfwlist](https://github.com/gfwlist/gfwlist)、可选的第三方清单和自己的规则合并，
编译成 Windows 能直接用的 PAC 脚本，托管在 Cloudflare Pages 上，每天自动同步。

```
上游 gfwlist ──────────┐
第三方清单（可选）─────┼─► scripts/build.mjs ─► public/<token>/proxy.pac ─► Cloudflare Pages
rules/custom-*.txt ────┘                          ES5 / JScript 兼容
```

**默认策略是「白名单代理」**：只有命中规则的域名走代理，其余一律直连。

---

## 一、跑起来

### 1. 建仓库

GitHub 新建仓库（**建议设为 Private**），把本项目全部文件传上去。

### 2. 配置代理链

`config.json` 里的 `proxy` 支持写成数组，系统会从左到右依次尝试：

```json
{
  "proxy": [
    "SOCKS5 127.0.0.1:1080",
    "PROXY 127.0.0.1:7890"
  ],
  "fallback": "block"
}
```

编译出来就是：

```
SOCKS5 127.0.0.1:1080; PROXY 127.0.0.1:7890; PROXY 127.0.0.1:1
```

`fallback` 三个取值：

| 值 | 末端追加 | 含义 |
|---|---|---|
| `block`（默认） | `PROXY 127.0.0.1:1` | 代理全挂就**失败**，不泄露到直连 |
| `direct` | `DIRECT` | 代理全挂就走直连（会明文出去） |
| `none` | 不追加 | 自己在 `proxy` 数组里写全 |

PAC 标准里没有 `BLOCK` 关键字，所以「阻断」是靠返回一个必然连不通的地址实现的。
选 `127.0.0.1:1` 是因为 loopback 上会立刻收到 RST，**快速失败**；
换成 `0.0.0.0:0` 之类要等超时，体验差很多。

> **关于降级的真实行为**：切换不是零成本的。浏览器要先真的连一次失败才会换下一跳，
> 而且会把失败的代理记进「坏代理」缓存（Chrome 默认 5 分钟）不再重试。
> 所以第一次故障时会卡一下，之后才顺滑。
> 另外降级只在**连接层失败**时触发 —— 代理连上了但返回 502，PAC 是不会换的。

也可以用 GitHub Secret `PAC_PROXY` 覆盖，多个代理用 `|` 分隔：

```
SOCKS5 127.0.0.1:1080|PROXY 127.0.0.1:7890
```

### 3. 设访问口令（可选但推荐）

`config.json` 填 `pathToken`，PAC 会生成到 `public/<token>/proxy.pac`，URL 变成：

```
https://pac.你的域名/<token>/proxy.pac
```

Windows 拉 PAC 不会带任何认证头，所以**路径即口令**是这里唯一能用的方案。
根目录只有一个空白页，扫不到东西。仓库公开的话就改用 Secret `PAC_PATH_TOKEN`。

### 4. 部署到 Cloudflare Pages

**A. Git 集成（推荐）** — Dashboard → Workers & Pages → Pages → Connect to Git，
构建命令留空，输出目录 `public`。Actions 每天把结果提交回仓库，Pages 自动重新部署，零 Secret。

**B. wrangler 直推** — 配 Secret `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
和 Variable `CF_PAGES_PROJECT`，workflow 里那步自动生效。

> workflow 里 `--branch=main` 不能省。不写的话 wrangler 在 CI 的 detached HEAD 下
> 会判成 Preview 部署，正式域名不更新。

### 5. Windows 上开起来

设置 → 网络和 Internet → 代理 → **使用设置脚本** → 打开开关 → 填 PAC 完整 URL → 保存。

---

## 二、匹配优先级

从上往下，命中即返回：

| # | 检查 | 结果 |
|---|---|---|
| 1 | IPv6 字面量 | 直连 |
| 2 | 单标签主机名（`localhost` / `nas` / `router`） | 直连 |
| 3 | 精确匹配 `full:` | DIRECT 优先 |
| 4 | IP 字面量：内网段 → 精确 IP → CIDR | DIRECT 优先 |
| 5 | **域名后缀逐级上溯，最长匹配优先，同级 DIRECT 压 PROXY** | |
| 6 | 通配主机名 `shExpMatch` | DIRECT 优先 |
| 7 | 整条 URL 关键词 | DIRECT 优先 |
| 8 | 都没命中 | **直连** |

第 5 条是核心。举两个例子：

- `custom-direct.txt` 写了 `cn`，gfwlist 里有 `futu.cn` →
  查 `futu.cn` 时先命中 gfwlist 的代理规则，**走代理**。`www.qq.com.cn` 一路上溯到 `cn`，**直连**。
  长的、具体的规则永远赢。
- `custom-direct.txt` 写了 `docs.github.com`，gfwlist 里有 `github.com` →
  `docs.github.com` 直连，其余 `*.github.com` 照走代理。

### 规则重复了怎么办

**自动合并，你的规则赢。** 不需要手动去重，也不会报错。

`stats.json` 里会记录到底覆盖了什么：

```json
"overrides": {
  "customDirectBeatsProxy": ["docs.github.com"],
  "customProxyBeatsDirect": []
}
```

---

## 三、写自己的规则

改 `rules/` 下两个文件，两边语法完全一样：

```
example.com          该域名 + 所有子域
full:example.com     只匹配这一个主机名，子域不算
cn                   单段 = 顶级域后缀，所有 *.cn 命中
xn--fiqs8s           .中国（IDN 写 punycode）
*.cdn.example.com    等价于 cdn.example.com
img*.example.com     主机名通配
223.5.5.5            单个 IP
223.5.5.0/24         IP 网段
keyword:/api/stream  整条 URL 含该子串（慎用，每个请求线性扫）
||example.com        AutoProxy 语法也认
example.com   # 行尾注释
```

`rules/custom-direct.txt` 里已经写好了一批样例：`.cn` 顶级域、
内网域名后缀（`lan` / `local` / `home.arpa`）、路由器 NAS 后台、
公共 DNS、银行支付政务、国内 CDN。直接删改就行。

内网 IP 段（10 / 172.16 / 192.168 / 127 / 169.254 / 100.64）和单标签主机名
PAC 里已经硬编码了，不用重复写。

> **PAC 管不到 DNS。** 普通域名解析走 UDP 53，根本不经过 PAC。
> 规则里写 `114.114.114.114` 只有在它被当作 **DoH 端点**访问时才有意义
> （比如浏览器请求 `https://223.5.5.5/dns-query`）。
> 想让 DNS 走特定服务器，得在系统或代理软件里配，PAC 帮不上。

---

## 四、第三方清单（Loyalsoldier/v2ray-rules-dat）

`config.json` 的 `extraSources` 可以接入外部清单。每个源三个模式：

| mode | 行为 |
|---|---|
| `report`（默认） | 只在 `stats.json` 里报告冲突，**不改动任何规则** |
| `intersect` | 只采纳和 gfwlist 真正冲突的条目 |
| `full` | 全量并入 |

### 关于 geosite:cn / geoip:cn，先看这组数字

我拿 `direct-list.txt`（111,459 条，就是 geosite:cn）和当前 gfwlist 的
4,262 条代理域名做了实测比对：

| | 条目数 | PAC 体积 |
|---|---|---|
| `report` | 0 条落地 | **78.9 KB** |
| `intersect` | 98 条落地 | **80.6 KB** |
| `full` | 110,933 条落地 | **1,924.5 KB** |

**因为默认动作已经是直连，导入 11 万条「中国域名走直连」几乎全是冗余的** ——
它们本来就直连。真正有价值的只有和 gfwlist 打架的那部分：

- **39 条整域冲突**：两边指名同一个域，一个说代理一个说直连
- **59 条子域挖孔**：gfwlist 代理父域，direct-list 指定某个子域直连
  （`adservice.google.com`、`cache.pack.google.com`、`cn.widevine.com` 这类）

**98 条 vs 111,459 条，体积差 24 倍，效果完全一样。**

`geoip:cn`（约 4,189 个 CIDR）同理，在默认直连的前提下 100% 冗余，
而且每个 IP 请求都要线性扫一遍 `isInNet`，纯亏。所以没有内置。

### 那 39 条冲突建议你自己看一眼

默认给的是 `report`，因为这批域名的归属值得你自己拍板 —— 大部分是券商：

```
futunn.com  futu5.com  futubull.cn  moomoo.com  tigerbrokers.com
itigerup.com  laohu8.com  longbridgeapp.com  hotcoin.com  oklink.com  ...
```

它们境内境外都有节点，走代理还是直连取决于你用哪个版本的 App、
以及会不会触发风控。看完 `stats.json` 里的 `sameDomainList` 再决定：

- 认可 → `config.local.json` 里把 mode 改成 `intersect`
- 只认可其中几条 → 抄进 `rules/custom-direct.txt`，更精确

### 反过来，proxy-list 才是真正能加东西的

`proxy-list.txt` 有 26,195 条，比 gfwlist 多出 **22,042 条**。
想要更激进的覆盖就打开它（`+0.46 MB`）：

```json
"loyalsoldier-proxy": { "enabled": true, "side": "proxy", "mode": "full" }
```

第三方清单拉取失败或没缓存时会**跳过并告警**，不会拖垮整个构建 —— gfwlist 才是主线。

---

## 五、命令

```bash
npm run build    # 拉上游 + 合并 + 生成 PAC
npm test         # 沙箱里真跑一遍 PAC
npm run all

node scripts/build.mjs --input some/gfwlist.txt   # 用本地 gfwlist
node scripts/build.mjs --offline                  # 第三方清单只用 .cache/
```

`npm test` 做四件事：

1. **ES5 语法体检** — Windows 的 PAC 引擎是老 JScript，出现 `let`/`const`/箭头函数
   会**静默失效**（不报错，代理直接不生效）。这一步专门拦这个。
2. **代理链断言** — `fallback: block` 时如果链尾是 `DIRECT` 就报错，防止意外泄露。
3. 在 vm 沙箱里加载 PAC，补上 `isInNet` / `shExpMatch` 等运行时函数。
4. 跑路由用例；`rules/` 里你写的每一条都会**自动变成用例**，
   包括 TLD 规则和 gfwlist 里更具体的 `.cn` 域名是否仍然走代理。

---

## 六、构建产物

```
public/
├── index.html              空白页
├── robots.txt
├── _headers                Cloudflare Pages 响应头（MIME + 缓存）
└── <pathToken>/
    ├── proxy.pac
    └── stats.json          统计 + 冲突报告 + 覆盖清单
```

`stats.json` 值得偶尔看的三处：

- `overrides` — 你的规则实际盖掉了什么
- `extraSources.*.sameDomainList` / `carveOutList` — 第三方清单的冲突明细
- `skippedSamples` — 上游新增了 PAC 表达不了的规则会列在这里

---

## 七、踩坑记录

**改了 PAC，Windows 没反应** — WinHTTP 会缓存。管理员 CMD：

```cmd
netsh winhttp reset autoproxy
ipconfig /flushdns
```

再把「使用设置脚本」开关关掉→保存→打开→保存。急的话 URL 后面挂 `?v=2`。

**PAC 完全不生效** — 八成踩了 ES6，`npm test` 就是防这个的。
其次检查 `Content-Type` 是不是 `application/x-ns-proxy-autoconfig`（`static/_headers` 配好了）。

**改成 `defaultAction: "proxy"` 之后很多站点变慢** — 那就是全局代理模式了，
这时才需要 geosite:cn / geoip:cn 那套庞大的直连清单。默认不建议动。

**Cloudflare 边缘缓存返回旧内容** — `_headers` 设了 `max-age=300`，
要立刻验证就带随机 query 绕过，workflow 里的冒烟测试就是这么干的。

**上游异常导致规则被清空** — 两道闸：内容里没有 `[AutoProxy` 标记直接中止；
代理域名少于 1000 条构建失败。不会拿空 PAC 覆盖线上的好文件。
