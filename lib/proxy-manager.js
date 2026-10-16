"use strict";

const fs = require("fs");
const path = require("path");
const { log } = require("./utils");

/**
 * Proxy Manager
 *
 * Modes:
 *   - "proxy_file"  : Đọc list từ file, mỗi main 1 proxy, rotate khi fail
 *   - "http_static" : 1 proxy duy nhất từ config.PROXY.address
 *   - "api_socks5"  : Fetch từ API (giữ logic cũ)
 *
 * Format file: host:port:user:pass (mỗi dòng 1 proxy)
 *
 * State trong-process:
 *   - mainProxyMap: Map<mainEmail, proxyStr>  — main hiện đang dùng proxy nào
 *   - deadProxies: Set<proxyStr>              — proxy đã bị mark dead
 *   - usedProxies: Set<proxyStr>              — proxy đã từng được pick
 */
function createProxyManager(config) {
  const proxyCfg = config?.PROXY || {};
  const mode = proxyCfg.mode || "http_static";
  const enabled = proxyCfg.enabled !== false;

  let filePool = []; // array proxy strings
  const mainProxyMap = new Map();
  const deadProxies = new Set();
  const usedProxies = new Set();

  // ── Load file pool nếu mode = proxy_file ────────────────────────────
  if (enabled && mode === "proxy_file") {
    const filePath = path.isAbsolute(proxyCfg.file)
      ? proxyCfg.file
      : path.join(process.cwd(), proxyCfg.file || "./proxies.txt");

    if (!fs.existsSync(filePath)) {
      log.err(`Proxy file not found: ${filePath}`);
      throw new Error(`Proxy file not found: ${filePath}`);
    }

    filePool = fs
      .readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.split(":").length >= 2);

    if (filePool.length === 0) {
      throw new Error(`Proxy file empty: ${filePath}`);
    }

    log.proxy(`Loaded ${filePool.length} proxies from ${filePath}`);
  }

  /**
   * Lấy 1 proxy cho main account.
   * - Nếu main đã có proxy đang dùng (chưa fail) → return luôn
   * - Nếu chưa → pick proxy mới từ pool
   */
  function getProxyForMain(mainEmail) {
    if (!enabled) return null;

    if (mode === "http_static") {
      return proxyCfg.address || null;
    }

    if (mode === "proxy_file") {
      // Đã có proxy đang dùng cho main này?
      const existing = mainProxyMap.get(mainEmail);
      if (existing && !deadProxies.has(existing)) {
        return existing;
      }

      // Pick mới
      const proxy = pickFromPool();
      if (!proxy) {
        log.err(`Pool exhausted — không còn proxy alive`);
        throw new Error("PROXY_POOL_EXHAUSTED");
      }

      mainProxyMap.set(mainEmail, proxy);
      usedProxies.add(proxy);
      log.proxy(`Main ${mainEmail} → proxy ${maskProxy(proxy)}`);
      return proxy;
    }

    // api_socks5 hoặc các mode khác — caller tự xử lý
    return null;
  }

  /**
   * Rotate sang proxy mới cho main account này (khi login fail / rate-limit).
   */
  function rotateProxyForMain(mainEmail, reason = "manual") {
    if (!enabled || mode !== "proxy_file") {
      log.warn(`Rotate skipped — mode=${mode} (chỉ proxy_file mới rotate)`);
      return null;
    }

    const old = mainProxyMap.get(mainEmail);
    if (old) {
      deadProxies.add(old);
      log.warn(
        `Mark dead: ${maskProxy(old)} (main ${mainEmail}, reason=${reason})`,
      );
    }
    mainProxyMap.delete(mainEmail);

    const fresh = pickFromPool();
    if (!fresh) {
      log.err(`Pool exhausted khi rotate cho ${mainEmail}`);
      throw new Error("PROXY_POOL_EXHAUSTED");
    }

    mainProxyMap.set(mainEmail, fresh);
    usedProxies.add(fresh);
    log.proxy(`Rotated ${mainEmail} → ${maskProxy(fresh)} (reason=${reason})`);
    return fresh;
  }

  /**
   * Đánh dấu proxy đã chết — không pick lại.
   */
  function markProxyDead(proxyStr, reason = "fail") {
    if (!proxyStr) return;
    deadProxies.add(proxyStr);
    log.warn(`Marked dead: ${maskProxy(proxyStr)} (${reason})`);
  }

  /**
   * Pick proxy alive từ pool — random hoặc sequential.
   * Ưu tiên proxy chưa từng dùng > proxy đã dùng nhưng còn alive.
   */
  function pickFromPool() {
    const alive = filePool.filter((p) => !deadProxies.has(p));
    if (alive.length === 0) return null;

    // Ưu tiên proxy chưa dùng
    const fresh = alive.filter((p) => !usedProxies.has(p));
    const pool = fresh.length > 0 ? fresh : alive;

    if (proxyCfg.random !== false) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    return pool[0]; // sequential
  }

  /**
   * Get stats cho debug/log.
   */
  function getStats() {
    return {
      mode,
      total: filePool.length,
      dead: deadProxies.size,
      used: usedProxies.size,
      alive: filePool.length - deadProxies.size,
      assignedMains: mainProxyMap.size,
    };
  }

  /**
   * Mask credentials cho log (chỉ hiện host:port).
   */
  function maskProxy(proxyStr) {
    if (!proxyStr) return "(null)";
    const parts = proxyStr.split(":");
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[1]}${parts.length > 2 ? ":***" : ""}`;
    }
    return proxyStr;
  }

  return {
    enabled,
    mode,
    getProxyForMain,
    rotateProxyForMain,
    markProxyDead,
    getStats,
    maskProxy,
  };
}

module.exports = { createProxyManager };
