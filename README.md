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

> **`config.json` 是代码自带的默认值，每次我更新项目都会覆盖它。**
> 你自己的设置请放 `config.local.json`（复制 `config.local.json.example` 改），
> 它会覆盖 `config.json` 的同名字段，`extraSources` 按 key 深合并。
> 这样升级时你的配置永远不会被冲掉。

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

### 🚫 不要在链里写 SOCKS —— 会让整个 PAC 失效

微软的 netsh 文档写明 **WinHTTP 不支持 SOCKS5**，Windows 的系统代理也没有原生
SOCKS 支持。但实际后果比"不支持"严重得多：

**很多客户端遇到不认识的关键字，不是跳过该条、而是把整个返回值判为无效，
表现成「像是根本没配 PAC」。** Google Drive 桌面端实测就是这样 —— 
写了 `SOCKS5 ...; PROXY ...; PROXY ...` 之后它完全不认，直连出去。
浏览器却一切正常，这种"一半能用"的故障最难查。

所以：**代理链里只写 `PROXY` 和 `DIRECT`**。

```json
"proxy": ["PROXY 127.0.0.1:1085"],
"fallback": "block"
```

`npm run build` 现在遇到 SOCKS 条目会**直接构建失败**，不再只是告警。
确实只给 Chrome / Firefox 用、且清楚后果的，在 config 里设 `"allowSocks": true`
显式放行。

构建期还会一并检查：

- 端口是不是 0 或超出范围
- 有没有拼错的关键字（`SOCK5` 之类）
- 多跳是不是都指向同一个 `host:port`（那不构成真正的冗余）

前三项是**错误**，直接中断构建；最后一项是告警，会写进 `stats.json` 的
`proxyChainWarnings`。

### blockProxy 用端口 1，不要用 0

**结论：`PROXY 127.0.0.1:1`。**

0 不是合法 TCP 端口，不同客户端处理不一致 —— 有的把整条跳过，有的会归一成
默认端口（万一本机 80 或 1080 上真跑着东西，被 block 的流量就送错地方了）。
端口 1 是合法端口、实际无人占用，环回口上立刻收到 RST，失败更快也更确定。

用 0 不会中断构建，只会告警。

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

## 二、jsDelivr CDN 地址

仓库公开后，不用自己部署也能直接用。四个是同一份文件的不同边缘节点，**任选其一**，
哪个快用哪个。每个代码块右上角有独立的复制按钮，点一下就是完整地址。

**官方主入口**

```
https://cdn.jsdelivr.net/gh/ivanphz/gfwlist-pac@main/public/proxy.pac
```

**Cloudflare 节点**

```
https://testingcf.jsdelivr.net/gh/ivanphz/gfwlist-pac@main/public/proxy.pac
```

**Gcore 节点**

```
https://gcore.jsdelivr.net/gh/ivanphz/gfwlist-pac@main/public/proxy.pac
```

**Fastly 节点**

```
https://fastly.jsdelivr.net/gh/ivanphz/gfwlist-pac@main/public/proxy.pac
```

已实测：jsDelivr 会把 `.pac` 以正确的 `application/x-ns-proxy-autoconfig`
返回，Windows 那栏直接填就能用，不需要额外配置。

### ⚠️ 缓存 12 小时

jsDelivr 对分支型 URL（`@main`）**最长缓存 12 小时**。每天构建出的新规则不会立刻生效。

workflow 里已经加了自动 purge 步骤，每次 PAC 有实质变化就调用一次
`purge.jsdelivr.net`（purge 接口每小时限 3~4 次，每天一次远在限额内）。
purge 失败只告警，不阻塞构建 —— 最坏情况就是等 12 小时自然过期。

### ⚠️ 公开仓库下 pathToken 没有意义

整个仓库可浏览，token 目录名一眼可见，等于没设。要么接受它只是个摆设，
要么改回私有仓库 + Cloudflare Pages。

---

## 三、关于「相对地址」

**不行，而且这个概念在这里不成立。** 三个层面：

**1. PAC URL 天然就是绝对的。** 它是填进 Windows 系统设置的一个独立地址，
不像网页里的 `<script src>` 有个 base URL 可以相对。没有参照物，谈不上相对。

**2. jsDelivr 的 `/gh/` 路径把 `用户名/仓库名` 写死在 URL 里。**
没有用户级别名，也没有「当前默认仓库」这种间接层。改仓库名 = 换 URL。

**3. 靠 GitHub 的改名重定向不牢靠。** 改名后 GitHub 会 301 老地址，
但一旦你哪天又建了个同名的新仓库，重定向立刻失效 —— 那时 CDN 要么 404，
要么给出另一个仓库的内容。把长期有效的代理配置押在这上面不合适。

### 真想要一个永不变的地址，用你自己的域名

这才是解法，而且你已经有这套东西了：

```
https://pac.你的域名/proxy.pac        <- Cloudflare Pages 自定义域名
```

它跟仓库叫什么、托管在 GitHub 还是别处、用不用 jsDelivr 都无关。
改仓库名只要 Pages 那边重新关联一下，对外的 URL 一个字都不用动。

**建议**：自己的域名当主地址填进 Windows，jsDelivr 四条当备份 —— 
哪天 Pages 出问题，手动换一条就行。

---

## 四、匹配优先级

从上往下，命中即返回：

| # | 检查 | 结果 |
|---|---|---|
| 1 | IPv6 字面量 | 见下方单独一节 |
| 2 | 单标签主机名（`localhost` / `nas` / `router`） | 直连 |
| 3 | 精确匹配 `full:` | DIRECT 优先 |
| 4 | IP 字面量：内网段 → 精确 IP → CIDR | DIRECT 优先 |
| 5 | **直连通配** `DIRECT_G` | 直连 |
| 6 | **域名后缀逐级上溯，最长匹配优先，同级 DIRECT 压 PROXY** | |
| 7 | 代理通配 `PROXY_G` | 代理 |
| 8 | 整条 URL 关键词 | DIRECT 优先 |
| 9 | 都没命中 | **直连** |

### IPv6 怎么走

早期版本是「IPv6 一律直连」，太粗暴，已经改成分层处理：

| IPv6 地址 | 结果 |
|---|---|
| `::1`、`::` | 直连 |
| `fe80::/10` 链路本地 | 直连 |
| `fc00::/7` 唯一本地地址（相当于 IPv6 的内网段） | 直连 |
| `::ffff:1.2.3.4` IPv4 映射 | **拆回 IPv4**，走 IPv4 那一整套规则 |
| 命中 `rules/` 里的 IPv6 规则 | 按规则 |
| 其余 | 按 `defaultAction`（默认直连） |

地址会先归一化成 8 组 4 位十六进制再比对，所以 `2400:3200::1`、
`2400:3200:0000:...:0001`、`240C::6666` 这些压缩写法和大小写都能正确命中。

需要说明的是：**这一节只管 URL 里直接写 IP 的情况**，比如
`https://[2606:4700::1111]/`。域名解析到 IPv6 不受影响 —— PAC 拿到的是主机名，
照常走域名规则。所以实际会命中这里的流量本来就很少。

第 5 步排在后缀上溯**之前**，是刻意的：ABP 里 `@@` 例外规则本来就压过一切拦截规则。
上游有一条「`xn--ngstr-lra8j.com` 整域走代理，但主机名里含 `2x3`/`ni5`/`j5o` 的走直连」
就靠这个顺序才能生效 —— 通配放在后缀之后的话，会先被父域的代理规则截胡。

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

## 五、写自己的规则

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

## 六、第三方清单（Loyalsoldier/v2ray-rules-dat）

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

## 七、命令

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

## 八、构建产物

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

### 正则规则怎么处理

PAC 里**不执行**上游的正则，一律在构建期降级成 `shExpMatch` 的 glob：

```
/^https?:\/\/[^\/]+blogspot\.(.*)/                     -> *blogspot.*
^https?:\/\/(?=.*?(2x3|ni5|j5o))[a-z0-9.-]+\.foo\.com$  -> *2x3*.foo.com
                                                            *ni5*.foo.com
                                                            *j5o*.foo.com
```

降不下来的（反向断言 `(?<=`、命名分组、复杂字符集）**直接进 skipped 报告，
绝不硬塞**。原因是 Windows 的 JScript 不支持 ES6 正则语法，一旦把这种正则
写进 PAC，加载阶段就是语法错误 —— **整个 PAC 全废**，比一条规则不生效严重得多。

同理，关键词数组只放纯字面子串。`npm test` 里有一条断言专门扫 `DIRECT_K`/`PROXY_K`，
发现正则元字符就报错。

---

## 九、踩坑记录

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

---

## 十、以后要做的：按域名分流到不同代理

**技术上完全可行，PAC 本来就是干这个的。** `FindProxyForURL` 每次调用返回一个字符串，
不同域名返回不同的代理地址是它的原始设计，不是绕路。

预期的配置形态：

```json
"proxies": {
  "default": ["SOCKS5 127.0.0.1:1080", "PROXY 127.0.0.1:7890"],
  "hk":      ["SOCKS5 127.0.0.1:1085"],
  "us":      ["PROXY 127.0.0.1:10808"],
  "block":   []
}
```

```
rules/proxy-hk.txt      -> a.com
rules/proxy-us.txt      -> b.com
rules/block.txt         -> 隐私跟踪域名
```

现在的架构改起来不大：`PROXY_D` 现在是 `{"a.com":1}`，把值从 `1` 换成代理档位的下标
`{"a.com":2}`，再加一个 `var PF = ["DIRECT","SOCKS5 ...","PROXY ..."]` 就行。
匹配逻辑一行不用动，还是 O(标签数) 的哈希查找，PAC 体积也不变。

### 但现在先别做，两个原因

**1. 公开仓库会把你的分流表暴露出去。** 现在公开的只是一份公共规则的编译产物，
没什么信息量。一旦加了「哪个域名走哪个节点」，那是你的实际使用画像 —— 
自建服务的域名、常用的私有站点、节点的地域分布，都会写在明处。
这个功能等仓库转私有再上。

**2. 分流档位越多，测试面越大。** 现在 150 条用例覆盖的是「代理 or 直连」二选一，
加到四五个档位后组合会翻几倍，得先把用例框架改成按档位断言。

### 关于 block 隐私域名，先说清它的边界

PAC 的 block 只对**走系统代理设置的 HTTP/HTTPS 流量**有效。它管不到：

- DNS 查询（UDP 53 根本不经过 PAC）
- 非 HTTP 协议的流量
- 自己配了代理、不读系统设置的 App

所以它挡不住真正的遥测，效果远不如 hosts 文件或 DNS 层拦截。当成「顺手挡一层」
可以，别当成隐私方案。
