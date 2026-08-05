# gfwlist-pac

把上游 [gfwlist](https://github.com/gfwlist/gfwlist)、可选的第三方清单和自己的规则合并，
编译成 Windows 能直接用的 PAC 脚本，托管在 Cloudflare Pages 上，每天自动同步。

```
上游 gfwlist ──────────┐
第三方清单（可选）─────┼─► build.mjs ─┬─► {{PAC_PATH}} ─► Cloudflare Pages / jsDelivr
rules/custom-*.txt ────┘              │
                    scripts/pac-runtime.js（PAC 运行时模板，ES5）
```

**默认策略是白名单代理**：只有命中规则的域名走代理，其余一律直连。

> 本文件由 `docs/README.template.md` 自动生成，别直接改 README.md。
> 当前数据：{{PROXY_DOMAINS}} 条代理域名 / {{DIRECT_DOMAINS}} 条直连，
> PAC 体积 {{PAC_KB}} KB，最后构建 {{BUILT_AT}}。

---

## 一、跑起来

### 1. 建仓库

把本项目全部文件传上去。注意 `.github/workflows/build.yml` 和 `.gitignore`
是点开头的路径，网页版拖拽上传有时会被浏览器吃掉 —— 传完确认一下，
丢了就用「Add file → Create new file」，文件名栏直接输完整路径。

### 2. 配置代理链

> **`config.json` 是代码自带的默认值，每次升级都会被覆盖。**
> 你自己的设置放 `config.local.json`（复制 `config.local.json.example` 改），
> 它覆盖 `config.json` 的同名字段，`extraSources` 按 key 深合并。

```json
{
  "proxy": ["PROXY 127.0.0.1:1085"],
  "fallback": "block",
  "blockProxy": "PROXY 127.0.0.1:1"
}
```

### 🚫 不要在链里写 SOCKS

微软的 netsh 文档写明 WinHTTP 不支持 SOCKS5，Windows 系统代理也没有原生 SOCKS 支持。
实际后果比「不支持」严重：**很多客户端遇到不认识的关键字不是跳过该条、
而是把整个返回值判为无效，表现成「像是根本没配 PAC」**，Google Drive 桌面端实测就是这样。

`npm run build` 遇到 SOCKS 条目会**直接构建失败**。确实只给 Chrome / Firefox 用、
且清楚后果的，设 `"allowSocks": true` 显式放行。

### ⚠️ 多级 fallback 对系统代理不成立

微软文档：WinHTTP 不支持多代理配置，返回列表时**只用第一个**，第一个连不上
也不会切到后面的。所以 `PROXY A; PROXY B` 这种链只在 Chrome / Firefox 自带的
PAC 引擎里才有降级效果，系统代理那条路只认第一跳。

末端的 `blockProxy` 用 `127.0.0.1:1`，**不要用端口 0** —— 0 不是合法 TCP 端口，
有的客户端跳过整条、有的归一成默认端口（万一本机 80/1080 上真跑着东西，
被 block 的流量就送错地方）。端口 1 合法、无人占用，环回口上立刻收到 RST。

### 3. 部署

**Cloudflare Pages Git 集成（推荐）**：构建命令留空，输出目录 `{{PAC_PATH}}` 的上级（`public`）。
Actions 每天把结果提交回仓库，Pages 自动重新部署，零 Secret。

**wrangler 直推**：配 Secret `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
和 Variable `CF_PAGES_PROJECT`。workflow 里 `--branch={{BRANCH}}` 不能省，
否则 CI 的 detached HEAD 会被判成 Preview 部署。

### 4. Windows 上开起来

设置 → 网络和 Internet → 代理 → **使用设置脚本** → 打开开关 → 填 PAC 完整 URL → 保存。

---

## 二、jsDelivr CDN 地址

仓库公开的话不用自己部署也能用。四个是同一份文件的不同边缘节点，任选其一。
每个代码块右上角有独立的复制按钮。

**官方主入口**

```
https://cdn.jsdelivr.net/gh/{{REPO}}@{{BRANCH}}/{{PAC_PATH}}
```

**Cloudflare 节点**

```
https://testingcf.jsdelivr.net/gh/{{REPO}}@{{BRANCH}}/{{PAC_PATH}}
```

**Gcore 节点**

```
https://gcore.jsdelivr.net/gh/{{REPO}}@{{BRANCH}}/{{PAC_PATH}}
```

**Fastly 节点**

```
https://fastly.jsdelivr.net/gh/{{REPO}}@{{BRANCH}}/{{PAC_PATH}}
```

实测 jsDelivr 会以正确的 `application/x-ns-proxy-autoconfig` 返回 `.pac`，
Windows 那栏直接填就能用。

上面这些地址是由 `docs/README.template.md` 里的 `{{REPO}}` / `{{BRANCH}}` 占位符
生成的，仓库改名后下一次构建会自动跟着变 —— **但这只解决文档里的地址是新的**，
已经填进 Windows 设置里的那个 URL 不会自动更新。

### ⚠️ 缓存 12 小时

jsDelivr 对分支型 URL（`@{{BRANCH}}`）最长缓存 12 小时。workflow 里已经加了
自动 purge，PAC 有实质变化就调一次 `purge.jsdelivr.net`（每小时限 3~4 次，
每天一次远在限额内），失败只告警不阻塞。

### ⚠️ 公开仓库下 pathToken 没有意义

整个仓库可浏览，目录名一眼可见。要真隐私就改回私有仓库 + 自己的域名。

---

## 三、PAC 改了但 Windows 不认新的

这是最容易浪费时间的坑，单独拎出来说。

**`netsh winhttp reset autoproxy` 常常没用**，因为它只重置 WinHTTP 那一层，
而设置界面和多数程序走的是 **WinINET，缓存是独立的**；每个进程还各自缓存一份。
浏览器手动下载同一个 URL 拿到的是最新的，不代表系统拿到的是最新的。

按可靠程度排序：

1. **给 URL 加版本号** —— Windows 的 PAC 缓存按 URL 做键，URL 一变必然重拉：
   ```
   https://cdn.jsdelivr.net/gh/{{REPO}}@{{BRANCH}}/{{PAC_PATH}}?v=20260805
   ```
   这条基本必成，改规则之后顺手把日期改一下。
2. `Restart-Service WinHttpAutoProxySvc -Force`（管理员 PowerShell）
3. 重启目标程序本身 —— Google Drive、Dropbox 这类常驻进程不重启不会重读
4. 「使用设置脚本」开关关掉→保存→打开→保存

服务端这边 `static/_headers` 已经把 `.pac` 设成 `no-cache, must-revalidate, max-age=0`
（不是「不缓存」，是「每次必须回源验证」，命中返 304 很便宜），至少不再火上浇油。

**验证当前实际生效的是哪一份**（PowerShell，返回目标 URI 本身 = 没走代理）：

```powershell
[System.Net.WebRequest]::DefaultWebProxy.GetProxy("https://drive.google.com")
```

注意 `GetProxy` 只返回第一跳可用的代理，看不出 fallback 链，而且
`DefaultWebProxy` 在进程内缓存 —— 测之前开个新窗口。

---

## 四、匹配优先级

从上往下，命中即返回：

| # | 检查 | 结果 |
|---|---|---|
| 1 | IPv6 字面量 | 见下节 |
| 2 | 单标签主机名（`localhost` / `nas` / `router`） | 直连 |
| 3 | 精确匹配 `full:` | DIRECT 优先 |
| 4 | IP 字面量：内网段 → 精确 IP → CIDR | DIRECT 优先 |
| 5 | 直连通配 `DIRECT_G` | 直连 |
| 6 | **域名后缀逐级上溯，最长匹配优先，同级 DIRECT 压 PROXY** | |
| 7 | 代理通配 `PROXY_G` | 代理 |
| 8 | 整条 URL 关键词 | DIRECT 优先 |
| 9 | 都没命中 | **直连** |

第 5 步排在后缀上溯**之前**是刻意的：ABP 里 `@@` 例外规则本来就压过一切拦截规则。
上游有一条「`xn--ngstr-lra8j.com` 整域走代理，但主机名含 `2x3`/`ni5`/`j5o` 的走直连」
就靠这个顺序才生效。

**这个 PAC 全程不做 DNS 解析**（`isInNet` 只在 host 已经是 IPv4 字面量时才调用），
所以没有解析延迟，也不会因为 PAC 里的 `dnsResolve` 泄露查询。

### 域名解析成 IPv6 会怎样

**不会有任何影响，照常走域名规则。** PAC 拿到的 `host` 参数是**主机名**，
不是解析后的 IP —— `ipv6.google.com` 和 `www.google.com` 一样命中 gfwlist 的
`google.com` 走代理，跟它是 A 记录还是 AAAA 记录无关。
解析发生在路由决策之后；走代理的话由代理去解析。

下面这节只管**URL 里直接写 IP 字面量**的少数情况，比如 `https://[2606:4700::1111]/`。

### IPv6 字面量：两种模式

当前是 **`{{IPV6_MODE}}`**，在 config 里用 `"ipv6"` 切换。

**`direct`（默认）** —— IPv6 字面量一律直连，三行逻辑，不打折扣。
这是长期验证可用的行为。`rules/` 里写的 IPv6 规则在这个模式下不会写进 PAC，
构建时会告警。

**`smart`（可选）** —— 分层处理：

| IPv6 地址 | 结果 |
|---|---|
| `::1`、`::` | 直连 |
| `fe80::/10` 链路本地 | 直连 |
| `fc00::/7` 唯一本地地址 | 直连 |
| `::ffff:1.2.3.4` IPv4 映射 | **拆回 IPv4**，走 IPv4 那一整套 |
| 命中 `rules/` 里的 IPv6 规则 | 按规则 |
| 其余 | 按 `defaultAction` |

地址会先归一化成 32 位十六进制再比对，所以 `240C::6666` 和
`2400:3200:0000:...:0001` 这些压缩写法、大小写都能命中。
这段代码刻意只用 `split` / `charAt` / `substring` / 字符串拼接，
**不用 `push`、`join`、`match`、`parseInt`、`toString`** —— PAC 沙箱各家实现宽严不一，
少依赖内建方法更保险。

---

## 五、写自己的规则

改 `rules/` 下两个文件，语法完全一样：

```
example.com          该域名 + 所有子域
full:example.com     只匹配这一个主机名，子域不算
cn                   单段 = 顶级域后缀，所有 *.cn 命中
xn--fiqs8s           .中国（IDN 写 punycode）
*.cdn.example.com    等价于 cdn.example.com
img*.example.com     主机名通配
223.5.5.5            单个 IP
223.5.5.0/24         IP 网段
2001:db8::1          IPv6 精确地址        （需 ipv6:smart）
2001:db8::/32        IPv6 前缀，长度须为 4 的倍数（需 ipv6:smart）
keyword:/api/stream  整条 URL 含该子串（慎用，每个请求线性扫）
example.com   # 行尾注释
```

`custom-direct.txt` 里已经写好一批样例：`.cn` 顶级域、内网域名后缀、
路由器 NAS 后台、公共 DNS、银行支付政务、国内 CDN。

内网 IP 段（10 / 172.16 / 192.168 / 127 / 169.254 / 100.64）和单标签主机名
PAC 里已经硬编码，不用重复写。

> **PAC 管不到 DNS。** 普通域名解析走 UDP 53，不经过 PAC。规则里写
> `114.114.114.114` 只有在它被当 DoH 端点访问时才有意义。

### 规则重复了怎么办

自动合并，**你的规则赢**，不用手动去重。`stats.json` 的
`overrides.customDirectBeatsProxy` 会列出实际盖掉了什么。

---

## 六、第三方清单（Loyalsoldier/v2ray-rules-dat）

`extraSources` 三个模式：`report`（默认，只报告不改动）、`intersect`（只采纳冲突项）、
`full`（全量并入）。

### 关于 geosite:cn，先看这组数字

拿 `direct-list.txt`（{{LS_TOTAL}} 条，就是 geosite:cn）和当前 gfwlist 实测比对：

| mode | 落地条目 | PAC 体积 |
|---|---|---|
| `report` | 0 | ~79 KB |
| `intersect` | {{LS_SAME}} + {{LS_CARVE}} | ~81 KB |
| `full` | 11 万+ | **~1,925 KB** |

**因为默认动作已经是直连，导入十几万条「中国域名直连」几乎全是冗余** —— 它们本来就直连。
真正有价值的只有和 gfwlist 打架的：**{{LS_SAME}} 条整域冲突 + {{LS_CARVE}} 条子域挖孔**。
体积差 24 倍，效果一样。`geoip:cn` 同理 100% 冗余，还要每个 IP 请求线性扫 `isInNet`。

默认给 `report` 是因为那几十条冲突大多是券商（futunn / tigerbrokers / moomoo /
longbridge），境内外都有节点，走哪边取决于你用哪个版本的 App 和会不会触发风控。
看完 `stats.json` 的 `sameDomainList` 再决定改不改成 `intersect`。

反过来 `proxy-list.txt` 才是真能加东西的，比 gfwlist 多两万多条，
想要更激进覆盖就 `"enabled": true`。

---

## 七、命令

```bash
npm run build    # 拉上游 + 合并 + 生成 PAC
npm test         # 沙箱里真跑一遍 PAC
npm run readme   # 由模板重新生成 README.md
npm run all

node scripts/build.mjs --input some/gfwlist.txt   # 用本地 gfwlist
node scripts/build.mjs --offline                  # 第三方清单只用 .cache/
```

`npm test` 做五件事：

1. **ES5 语法体检** —— Windows 的 PAC 引擎是老 JScript，出现 `let`/`const`/箭头函数
   会**静默失效**（不报错，代理直接不生效）
2. **正则字面量转义检查** —— 模板转义写错会把 `\d` 吃成 `d`，静默失配
3. **代理链断言** —— `fallback: block` 时链尾若是 `DIRECT` 就报错，防止意外泄露
4. 沙箱加载 PAC，补上 `isInNet` / `shExpMatch` 等运行时函数
5. 跑路由用例；`rules/` 里你写的每一条都会**自动变成用例**

---

## 八、文件结构

```
.github/workflows/build.yml   每日同步 + 构建 + 自测 + 部署 + purge
config.json                   代码自带默认值（升级会覆盖）
config.local.json             你的个人覆盖（自己建，不会被覆盖）
docs/README.template.md       README 的来源，改这个
rules/custom-proxy.txt        自有代理规则
rules/custom-direct.txt       自有直连规则
scripts/build.mjs             构建器
scripts/pac-runtime.js        PAC 运行时模板（独立 ES5 文件）
scripts/test.mjs              沙箱自测
scripts/gen-readme.mjs        README 生成器
static/_headers               MIME + 缓存头
public/                       构建产物，每次全量重建
```

`scripts/pac-runtime.js` 是 PAC 的实际代码，一个能被解析器直接检查的 ES5 文件。
`build.mjs` 只做占位符替换和 `//#region` 段裁剪 —— 以前 PAC 代码写在
`build.mjs` 的模板字符串里，正则要双重转义，栽过两次跟头，所以抽出来了。

---

## 九、踩坑记录

**PAC 完全不生效** —— 八成踩了 ES6 或者链里写了 SOCKS，`npm test` 和构建期校验就是防这个的。
其次检查 `Content-Type` 是不是 `application/x-ns-proxy-autoconfig`。

**改成 `defaultAction: "proxy"` 之后很多站点变慢** —— 那是全局代理模式了，
这时才需要 geosite:cn / geoip:cn 那套庞大的直连清单。默认不建议动。

**上游异常导致规则被清空** —— 两道闸：内容里没有 `[AutoProxy` 标记直接中止；
代理域名少于 1000 条构建失败。不会拿空 PAC 覆盖线上的好文件。

**第三方清单拉不到** —— 跳过并告警，不拖垮整个构建。gfwlist 才是主线。
