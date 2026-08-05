/* ============================================================
 * PAC 运行时模板
 *
 * 这是一个真正的、可以直接被解析器检查的 ES5 文件。
 * build.mjs 只做两件事：把占位符替换成数据，把没选中的
 * //#region 段删掉。正则字面量原样输出，不经过模板字面量转义 ——
 * 之前 \d 被吃成 d 就是那么来的。
 *
 * 约束：Windows 用旧 JScript 跑 PAC，只能用 ES5/ES3 语法。
 * 另外尽量少依赖内建方法，PAC 沙箱各家实现宽严不一。
 * ============================================================ */

var P = "__PROXY_CHAIN__";
var D = "DIRECT";
var DEF = __DEFAULT_ACTION__;

// 精确匹配（不含子域）
var PROXY_F = __PROXY_F__;
var DIRECT_F = __DIRECT_F__;

// 域名后缀（含所有子域）
var PROXY_D = __PROXY_D__;
var DIRECT_D = __DIRECT_D__;

// IPv4 网段 [网络地址, 掩码]
var PROXY_N = __PROXY_N__;
var DIRECT_N = __DIRECT_N__;

// 通配主机名
var PROXY_G = __PROXY_G__;
var DIRECT_G = __DIRECT_G__;

// 整条 URL 关键词
var PROXY_K = __PROXY_K__;
var DIRECT_K = __DIRECT_K__;

//#region V6_SMART
// IPv6 精确地址（32 位十六进制，无冒号）
var PROXY_V6 = __PROXY_V6__;
var DIRECT_V6 = __DIRECT_V6__;

// IPv6 前缀（十六进制，无冒号）
var PROXY_V6N = __PROXY_V6N__;
var DIRECT_V6N = __DIRECT_V6N__;
//#endregion V6_SMART

function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

function isIPv4(h) {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function inAnyNet(h, list) {
    var i;
    for (i = 0; i < list.length; i++) {
        if (isInNet(h, list[i][0], list[i][1])) return true;
    }
    return false;
}

function isPrivateIP(h) {
    return isInNet(h, "10.0.0.0", "255.0.0.0")
        || isInNet(h, "172.16.0.0", "255.240.0.0")
        || isInNet(h, "192.168.0.0", "255.255.0.0")
        || isInNet(h, "127.0.0.0", "255.0.0.0")
        || isInNet(h, "169.254.0.0", "255.255.0.0")
        || isInNet(h, "100.64.0.0", "255.192.0.0");
}

//#region V6_SMART
/* 把 IPv6 补零展开成 32 个十六进制字符（不带冒号）。失败返回 ""。
 * 刻意只用 split / length / charAt / 字符串拼接 —— 不用 push、join、
 * match、parseInt、toString，减少对 PAC 沙箱内建方法的依赖。
 * 内嵌 IPv4（::ffff:1.2.3.4）在调用方已经拆走，这里不处理。 */
function normV6(a) {
    var parts, head, tail, out, i, g, n, s;
    a = ("" + a).toLowerCase();
    if (a.indexOf("::") >= 0) {
        parts = a.split("::");
        if (parts.length !== 2) return "";
        head = parts[0] === "" ? [] : parts[0].split(":");
        tail = parts[1] === "" ? [] : parts[1].split(":");
        n = head.length + tail.length;
        if (n > 8) return "";
        out = [];
        for (i = 0; i < head.length; i++) out[out.length] = head[i];
        for (i = n; i < 8; i++) out[out.length] = "0";
        for (i = 0; i < tail.length; i++) out[out.length] = tail[i];
    } else {
        out = a.split(":");
    }
    if (out.length !== 8) return "";
    s = "";
    for (i = 0; i < 8; i++) {
        g = out[i];
        if (g.length < 1 || g.length > 4) return "";
        if (!/^[0-9a-f]{1,4}$/.test(g)) return "";
        while (g.length < 4) g = "0" + g;
        s = s + g;
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
    var hex = normV6(a);
    if (hex === "") return DEF;
    var p3 = hex.substring(0, 3);
    var p2 = hex.substring(0, 2);

    if (hex === "00000000000000000000000000000001") return D;   // ::1
    if (hex === "00000000000000000000000000000000") return D;   // ::
    if (p3 === "fe8" || p3 === "fe9" || p3 === "fea" || p3 === "feb") return D; // fe80::/10
    if (p2 === "fc" || p2 === "fd") return D;                   // fc00::/7

    if (has(DIRECT_V6, hex)) return D;
    if (has(PROXY_V6, hex)) return P;
    if (hasPrefix(hex, DIRECT_V6N)) return D;
    if (hasPrefix(hex, PROXY_V6N)) return P;
    return DEF;
}
//#endregion V6_SMART

function FindProxyForURL(url, host) {
    host = ("" + host).toLowerCase();

//#region V6_SIMPLE
    // IPv6 字面量一律直连（保守模式）
    if (host.charAt(0) === "[") return D;
    var c0 = host.indexOf(":");
    if (c0 >= 0 && host.indexOf(":", c0 + 1) >= 0) return D;
//#endregion V6_SIMPLE

//#region V6_SMART
    // IPv6 字面量：本机/链路本地/唯一本地直连，IPv4 映射拆回 v4，其余按规则
    var v6 = null, rb, m4;
    if (host.charAt(0) === "[") {
        rb = host.indexOf("]");
        v6 = rb > 0 ? host.substring(1, rb) : host.substring(1);
    } else if (host.indexOf(":") >= 0 && host.indexOf(":", host.indexOf(":") + 1) >= 0) {
        v6 = host;
    }
    if (v6 !== null) {
        m4 = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
        if (m4) host = m4[1];
        else return routeV6(v6);
    }
//#endregion V6_SMART

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

    // 直连通配：白名单例外优先于一切后缀规则（ABP 里 @@ 就是这个语义）
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
