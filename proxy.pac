var P = "PROXY 127.0.0.1:1085; PROXY 127.0.0.1:1";
var D = "DIRECT";

function FindProxyForURL(url, host) {
    host = ("" + host).toLowerCase();

    // 1. 处理 IPv6 格式：除了本地回环 [::1]，其余全部代理
    if (host.charAt(0) === "[") {
        return (host === "[::1]") ? D : P;
    }
    var c1 = host.indexOf(":");
    if (c1 >= 0 && host.indexOf(":", c1 + 1) >= 0) {
        return (host === "::1") ? D : P;
    }

    // 去掉端口号和末尾多余的 "."
    if (c1 >= 0) host = host.substring(0, c1);
    while (host.length && host.charAt(host.length - 1) === ".") {
        host = host.substring(0, host.length - 1);
    }
    if (!host.length) return D;

    // 2. 单标签主机名（如 localhost, intranet）直连
    if (isPlainHostName(host)) return D;

    // 3. 处理 IPv4 格式：局域网私有 IP 直连，公网 IP 强制代理
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
        if (isInNet(host, "10.0.0.0", "255.0.0.0") ||
            isInNet(host, "172.16.0.0", "255.240.0.0") ||
            isInNet(host, "192.168.0.0", "255.255.0.0") ||
            isInNet(host, "127.0.0.0", "255.0.0.0") ||
            isInNet(host, "169.254.0.0", "255.255.0.0")) {
            return D;
        }
        return P;
    }

    // 4. 白名单直连机制测试完成：其余所有公网域名、地址，无条件全部走代理！
    return P;
}
