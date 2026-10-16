"use strict";

const { createFileIO } = require("./file-io");
const { createImapClient } = require("./imap");
const { launchBrowser, safeGoto, clearBrowserData } = require("./browser");
const {
  loginTOnline,
  gotoAliasPage,
  listCurrentAliases,
  aliasBatch,
  addSingleAlias,
  addSingleAliasUI,
  deleteAliases,
  dismissTOnlineCookieNotice,
  localPart,
  buildAlias,
  MAX_ALIASES_PER_ACCOUNT,
} = require("./t-online");
const {
  initCapsolver,
  submitAppleForgot,
  resetPasswordFromLink,
} = require("./apple-forgot");
const { delay, log } = require("./utils");
const { createProxyManager } = require("./proxy-manager");

// ════════════════════════════════════════════════════════════════════
// STICKY PROXY HELPER
// Convert proxy xoay → sticky bằng cách thêm -sid-XXXXXXXX-t-120 vào username
// Format xoay:  host:port:user-region-XX:pass
// Format sticky: host:port:user-region-XX-sid-abc12345-t-120:pass
// Mỗi lần gọi makeStickyProxy() tạo sid mới → IP mới nhưng giữ 120 phút
// ════════════════════════════════════════════════════════════════════
function makeStickyProxy(proxyAddr, durationMin = 120) {
  if (!proxyAddr) return proxyAddr;
  const parts = proxyAddr.split(":");
  if (parts.length !== 4) return proxyAddr; // không đúng format thì giữ nguyên
  const [host, port, user, pass] = parts;
  // Nếu đã có sid rồi thì thay sid mới
  const cleanUser = user.replace(/-sid-[a-z0-9]+-t-\d+/i, "");
  const sidChars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const sid = Array.from(
    { length: 8 },
    () => sidChars[Math.floor(Math.random() * sidChars.length)],
  ).join("");
  return `${host}:${port}:${cleanUser}-sid-${sid}-t-${durationMin}:${pass}`;
}

// ════════════════════════════════════════════════════════════════════
// TIME WINDOW — alias chỉ hoạt động được từ 4h–9h sáng (giờ server)
// ════════════════════════════════════════════════════════════════════
const ALIAS_HOUR_START = 4; // 4:00 sáng
const ALIAS_HOUR_END = 9; // trước 9:00 sáng

async function waitUntilAllowedHour() {
  while (true) {
    const now = new Date();
    const hour = now.getHours();
    if (hour >= ALIAS_HOUR_START && hour < ALIAS_HOUR_END) return; // OK, chạy tiếp

    // Tính thời gian còn lại đến 4h sáng
    const next = new Date(now);
    if (hour >= ALIAS_HOUR_END) next.setDate(next.getDate() + 1); // hôm sau
    next.setHours(ALIAS_HOUR_START, 0, 0, 0);
    const msLeft = next - now;
    const hLeft = Math.floor(msLeft / 3600000);
    const mLeft = Math.floor((msLeft % 3600000) / 60000);
    log.warn(
      `⏰ Ngoài khung giờ alias (${hour}h) — chờ đến ${ALIAS_HOUR_START}h sáng (~${hLeft}h${mLeft}m nữa)`,
    );
    // Sleep 5 phút rồi check lại
    await delay(5 * 60 * 1000);
  }
}

// ════════════════════════════════════════════════════════════════════
// ERROR HANDLERS
// ════════════════════════════════════════════════════════════════════
let handlersInstalled = false;
function installErrorHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("uncaughtException", (err) => {
    const msg = err.message || "";
    // Puppeteer internal: browser process đã đóng nhưng vẫn bị reference
    const isPuppeteerInternal =
      msg.includes("fullcmd") ||
      msg.includes("Cannot read properties of undefined") ||
      msg.includes("Target closed") ||
      msg.includes("Session closed");
    if (err.code === "ECONNRESET" || err.source === "socket") {
      log.warn("uncaughtException ECONNRESET, continuing");
    } else if (isPuppeteerInternal) {
      log.warn(
        `uncaughtException (Puppeteer internal, ignored): ${msg.slice(0, 80)}`,
      );
    } else {
      log.err(`Uncaught: ${msg}`);
      process.exit(1);
    }
  });
  process.on("unhandledRejection", (reason) => {
    if (reason?.code === "ECONNRESET") {
      log.warn("unhandledRejection ECONNRESET, continuing");
    } else {
      log.err(`Unhandled: ${reason}`);
    }
  });
}

// ════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════
const MAX_BATCH_LOOPS = 999; // chạy liên tục đến khi pool hết hoặc rate-limit

// ════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════
function tonlineWindow(config) {
  return {
    size: config.BROWSER.TONLINE_WINDOW_SIZE || config.BROWSER.WINDOW_SIZE,
    position:
      config.BROWSER.TONLINE_WINDOW_POSITION || config.BROWSER.WINDOW_POSITION,
  };
}

async function safeClose(browser, label) {
  if (!browser) return;
  try {
    await browser.close();
    log.info(`${label} closed`);
  } catch (e) {
    log.warn(`Close ${label} error: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// PROCESS ONE EMAIL — full Apple iForgot flow
// ════════════════════════════════════════════════════════════════════
// So sánh hint email từ Apple với alias T-Online của mình
// Hint dạng: k•••••@o•••••.eu → so char đầu local, char đầu domain, TLD
function checkHintEmail(hintEmail, aliasEmail) {
  if (!hintEmail || !aliasEmail) return true; // không lấy được → bỏ qua check

  const atH = hintEmail.indexOf("@");
  if (atH < 0) return true;
  const hintLocal = hintEmail.slice(0, atH);
  const hintDomain = hintEmail.slice(atH + 1);
  const dotH = hintDomain.lastIndexOf(".");
  if (dotH < 0) return true;

  const hintLocalFirst = (hintLocal[0] || "").toLowerCase();
  const hintDomainFirst = (hintDomain[0] || "").toLowerCase();
  const hintTld = hintDomain.slice(dotH + 1).toLowerCase();

  const atA = aliasEmail.indexOf("@");
  if (atA < 0) return false;
  const aliasLocal = aliasEmail.slice(0, atA);
  const aliasDomain = aliasEmail.slice(atA + 1);
  const dotA = aliasDomain.lastIndexOf(".");
  if (dotA < 0) return false;

  const aliasLocalFirst = (aliasLocal[0] || "").toLowerCase();
  const aliasDomainFirst = (aliasDomain[0] || "").toLowerCase();
  const aliasTld = aliasDomain.slice(dotA + 1).toLowerCase();

  return (
    hintLocalFirst === aliasLocalFirst &&
    hintDomainFirst === aliasDomainFirst &&
    hintTld === aliasTld
  );
}

async function processOneEmail(applePage, email, mainAccount, imap, fileIO) {
  // Alias T-Online tương ứng với email này (cùng local part, domain giữ nguyên từ pool)
  const emailDomain = email.split("@")[1] || "t-online.de";
  const aliasEmail = `${localPart(email)}@${emailDomain}`;

  try {
    // STEP 1: Submit Apple iForgot (CAPTCHA)
    log.divider(`Processing: ${email}`);
    const forgotResult = await submitAppleForgot(applePage, email);

    if (!forgotResult.ok) {
      log.err(`iForgot failed: ${forgotResult.reason}`);
      if (forgotResult.reason === "503_need_relaunch") {
        return { ok: false, reason: "503_need_relaunch", skipWrite: true };
      }
      if (forgotResult.reason === "capsolver_fatal") {
        return { ok: false, reason: "capsolver_fatal", skipWrite: true };
      }
      await fileIO.writeFailed(email, `iforgot_${forgotResult.reason}`);
      return { ok: false, reason: forgotResult.reason };
    }

    // Kiểm tra hint email — xác nhận Apple gửi về đúng alias
    const hintEmail = forgotResult.hintEmail;
    if (hintEmail) {
      const matched = checkHintEmail(hintEmail, aliasEmail);
      if (!matched) {
        log.err(
          `❌ Hint mismatch: Apple gửi về "${hintEmail}" ≠ alias "${aliasEmail}" → link ẩn thất bại`,
        );
        await fileIO.writeFailed(email, "hint_mismatch");
        return { ok: false, reason: "hint_mismatch" };
      }
      log.ok(`✅ Hint OK: "${hintEmail}" khớp alias "${aliasEmail}"`);
    } else {
      log.warn("Không lấy được hint email — bỏ qua kiểm tra hint");
    }

    // STEP 2: IMAP — lấy Apple reset link (1 lần duy nhất)
    log.info("Chờ Apple reset email...");
    await delay(5000);

    let resetData = null;
    try {
      resetData = await imap.getAppleResetLink(
        mainAccount.email,
        mainAccount.passimap,
      );
    } catch (err) {
      log.err(`IMAP failed: ${err.message}`);
    }

    if (!resetData) {
      log.err("📭 IMAP không tìm thấy link → fail");
      await fileIO.writeFailed(email, "imap_no_reset_link");
      return { ok: false, reason: "imap_fail" };
    }

    // STEP 3: Mở reset link → đổi mật khẩu
    const resetResult = await resetPasswordFromLink(
      applePage,
      resetData.resetLink,
    );

    if (!resetResult.ok) {
      log.err(`Reset failed: ${resetResult.reason}`);
      await fileIO.writeFailed(email, `reset_${resetResult.reason}`);
      return { ok: false, reason: resetResult.reason };
    }

    // STEP 4: Lưu kết quả
    await fileIO.writeSuccess(email, resetResult.newPassword);
    return { ok: true, password: resetResult.newPassword };
  } catch (err) {
    log.err(`Unexpected error: ${err.message}`);
    await fileIO.writeFailed(email, `error_${err.message.slice(0, 80)}`);
    return { ok: false, reason: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════
// PROCESS BATCH FOR ONE MAIN ACCOUNT
// ════════════════════════════════════════════════════════════════════
async function processBatchForMain(
  mainAccount,
  pool,
  proxyMgr,
  fileIO,
  imap,
  config,
) {
  log.divider(`MAIN: ${mainAccount.email}`);

  const batchSize = config.TONLINE?.BATCH_SIZE || 10;
  let totalSuccess = 0;
  let totalProcessed = 0;
  const allFailedEmails = [];
  let updatedPool = [...pool];
  let rateLimited = false;
  let aliasTimedOut = false;
  let switchAfterRotate = false; // true = sau khi rotate proxy thì đổi acc luôn (không retry cùng acc)
  let twoFactorBlocked = false; // true = T-Online yêu cầu 2FA khi xóa alias → đổi acc, move to done

  let tOnlineBrowser = null;
  let appleBrowser = null;

  // ── Proxy rotation state ──
  const EU_ROTATE_COUNTRIES = [
    "FR",
    "NL",
    "PL",
    "AT",
    "BE",
    "IT",
    "ES",
    "SE",
    "FI",
    "CZ",
  ];
  const tonlineProxy = config.TONLINE_PROXY?.enabled
    ? config.TONLINE_PROXY.address
    : null;
  let currentProxy =
    tonlineProxy || proxyMgr.getProxyForMain(mainAccount.email);
  const proxy = currentProxy; // alias để không đổi code login/launch bên dưới
  const usedProxyCountries = new Set();
  {
    const m = currentProxy?.match(/-region-([A-Z]{2})/);
    if (m) usedProxyCountries.add(m[1]);
  }

  function nextProxyAddress() {
    if (!currentProxy) return null;
    const m = currentProxy.match(/(.*-region-)([A-Z]{2})(.*)/);
    if (!m) return null;
    for (const country of EU_ROTATE_COUNTRIES) {
      if (!usedProxyCountries.has(country)) {
        usedProxyCountries.add(country);
        return m[1] + country + m[3];
      }
    }
    // Hết tất cả country → reset vòng lặp, bắt đầu lại từ đầu
    log.warn("🔄 Đã dùng hết EU countries → reset vòng lặp proxy region");
    usedProxyCountries.clear();
    const first = EU_ROTATE_COUNTRIES[0];
    usedProxyCountries.add(first);
    return m[1] + first + m[3];
  }

  try {
    // ── Launch T-Online browser ──
    tOnlineBrowser = await launchBrowser(
      config,
      !!proxy,
      proxy,
      tonlineWindow(config),
    );
    if (proxy) {
      const parts = proxy.split(":");
      const regionMatch = proxy.match(/-region-([A-Z]{2})/);
      const regionLabel = regionMatch ? ` [region: ${regionMatch[1]}]` : "";
      log.proxy(
        `T-Online browser using proxy: ${parts[0]}:${parts[1]}${regionLabel}`,
      );
    } else {
      log.info("T-Online browser: no proxy");
    }
    const tOnlinePages = await tOnlineBrowser.pages();
    let tOnlinePage = tOnlinePages[0] || (await tOnlineBrowser.newPage());

    // ── Check IP + Region cho T-Online browser ──
    if (proxy) {
      const parts = proxy.split(":");
      if (parts.length === 4) {
        await tOnlinePage.authenticate({
          username: parts[2],
          password: parts[3],
        });
      }
    }
    try {
      const ipData = await tOnlinePage.evaluate(async () => {
        const r = await fetch("https://ipinfo.io/json");
        return r.json();
      });
      log.proxy(
        `T-Online IP: ${ipData.ip} | Region: ${ipData.region || ipData.country} | City: ${ipData.city || "N/A"}`,
      );
    } catch (e) {
      log.warn(`T-Online IP check failed: ${e.message}`);
    }

    // ── Login T-Online ──
    const loginOk = await loginTOnline(
      tOnlineBrowser,
      tOnlinePage,
      mainAccount.email,
      mainAccount.password,
      mainAccount.totp,
      config,
    );
    if (!loginOk) {
      log.err("T-Online login failed");
      await safeClose(tOnlineBrowser, "T-Online");
      return {
        processedCount: 0,
        successCount: 0,
        failedEmails: [],
        remainingPool: updatedPool,
        fullyDone: false,
        rateLimited: false,
      };
    }

    // ── Clear inbox trước khi bắt đầu (xoá mail cũ tránh nhầm) ──
    try {
      const clearResult = await imap.clearInbox(
        mainAccount.email,
        mainAccount.passimap,
      );
      if (clearResult.ok) {
        log.ok(`Inbox cleared: ${clearResult.deleted} email(s) deleted`);
      }
    } catch (err) {
      log.warn(`Clear inbox error: ${err.message} — continuing`);
    }

    // Tìm tab email chính (đã login)
    const allPages = await tOnlineBrowser.pages();
    let tOnlineActivePage =
      allPages.find((p) => p.url().includes("email.t-online.de")) ||
      tOnlinePage;

    // ── Helper: rotate proxy country → relaunch T-Online browser ──
    async function rotateTOnlineBrowser() {
      const newProxyAddr = nextProxyAddress();
      if (!newProxyAddr) {
        log.err("🌍 Đã thử hết EU countries → switch main");
        return false;
      }
      log.warn(
        `🌍 Rotating T-Online proxy: ${newProxyAddr.match(/-region-([A-Z]{2})/)?.[1] || newProxyAddr}`,
      );
      await safeClose(tOnlineBrowser, "T-Online (rotate)");
      tOnlineBrowser = null;

      currentProxy = newProxyAddr;
      tOnlineBrowser = await launchBrowser(
        config,
        true,
        newProxyAddr,
        tonlineWindow(config),
      );
      const pages2 = await tOnlineBrowser.pages();
      let newPage = pages2[0] || (await tOnlineBrowser.newPage());
      const parts2 = newProxyAddr.split(":");
      if (parts2.length === 4) {
        await newPage.authenticate({
          username: parts2[2],
          password: parts2[3],
        });
      }
      log.proxy(`T-Online rotated → ${parts2[0]}:${parts2[1]} [${parts2[2]}]`);

      const loginOk2 = await loginTOnline(
        tOnlineBrowser,
        newPage,
        mainAccount.email,
        mainAccount.password,
        mainAccount.totp,
        config,
      );
      if (!loginOk2) {
        log.err("T-Online re-login failed after proxy rotation");
        return false;
      }

      const pages3 = await tOnlineBrowser.pages();
      tOnlineActivePage =
        pages3.find((p) => p.url().includes("email.t-online.de")) || newPage;
      await gotoAliasPage(tOnlineActivePage);
      log.ok("T-Online relaunched with new proxy, back on alias page");
      return true;
    }

    // ── Launch Apple browser (riêng, có proxy) ──
    const _appleProxyBase = config.APPLE_PROXY?.enabled
      ? config.APPLE_PROXY.address
      : null;
    const appleProxy =
      _appleProxyBase && config.APPLE_PROXY?.sticky
        ? makeStickyProxy(
            _appleProxyBase,
            config.APPLE_PROXY?.stickyMinutes || 120,
          )
        : _appleProxyBase;
    appleBrowser = await launchBrowser(config, !!appleProxy, appleProxy, {
      size: config.BROWSER.IG_WINDOW_SIZE || "1280,700",
      position: config.BROWSER.IG_WINDOW_POSITION || "1280,0",
    });
    let applePage =
      (await appleBrowser.pages())[0] || (await appleBrowser.newPage());

    // Authenticate proxy trước khi navigate
    if (appleProxy) {
      const parts = appleProxy.split(":");
      log.proxy(`Apple browser using proxy: ${parts[0]}:${parts[1]}`);
      if (parts.length === 4) {
        await applePage.authenticate({
          username: parts[2],
          password: parts[3],
        });
        log.proxy("Proxy auth set on Apple page");
      }
    }

    // ── Check IP + Region cho Apple browser ──
    try {
      const ipData = await applePage.evaluate(async () => {
        const r = await fetch("https://ipinfo.io/json");
        return r.json();
      });
      log.proxy(
        `Apple IP: ${ipData.ip} | Region: ${ipData.region || ipData.country} | City: ${ipData.city || "N/A"}`,
      );
    } catch (e) {
      log.warn(`Apple IP check failed: ${e.message}`);
    }

    // Auto-dismiss "Leave site?" / beforeunload dialogs
    applePage.on("dialog", async (dialog) => {
      log.info(`Auto-dismissing dialog: "${dialog.message().slice(0, 50)}"`);
      await dialog.accept().catch(() => {});
    });

    // Warm up — tạo trust trước khi vào iforgot
    log.info("Warming up Apple browser...");
    await applePage.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Ch-Ua":
        '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
    });
    await applePage.setViewport({
      width: 1280,
      height: 700,
      deviceScaleFactor: 1,
    });
    // Visit apple.com trước để lấy cookies tự nhiên
    await applePage
      .goto("https://www.apple.com/", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
    await delay(2000);
    await applePage
      .goto("https://iforgot.apple.com/", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
    await delay(2000);
    log.ok("Apple browser warmed up");

    // ── Batch loop — chạy liên tục đến khi hết pool ──
    for (let batchLoop = 1; batchLoop <= MAX_BATCH_LOOPS; batchLoop++) {
      if (updatedPool.length === 0) {
        log.warn("Pool empty — stopping");
        break;
      }

      // STEP 1: Alias
      log.divider(`STEP 1: ALIAS (loop ${batchLoop})`);
      await gotoAliasPage(tOnlineActivePage);
      await dismissTOnlineCookieNotice(tOnlineActivePage, 12000);
      const existing = await listCurrentAliases(tOnlineActivePage);
      log.info(
        `Current aliases: ${existing.length}/${MAX_ALIASES_PER_ACCOUNT}`,
      );

      // Check pending — mail đã alias từ lần chạy trước nhưng chưa xử lý
      const pendingEmails = await fileIO.readPending();
      const mainLower = mainAccount.email.trim().toLowerCase();
      const mainLocal = mainLower.split("@")[0];
      const pendingSet = new Set(pendingEmails.map((e) => e.toLowerCase()));

      // Lọc pending còn tồn tại trên account (chưa bị xóa)
      const existingFullSet = new Set(
        existing.map((a) => a.full.toLowerCase()),
      );
      const pendingStillExist = pendingEmails.filter((e) =>
        existingFullSet.has(e.toLowerCase()),
      );

      let emailsToProcess = [];
      aliasTimedOut = false;
      let aliasTimedOutReason = "";
      let consecutiveApi500 = 0; // API 500 + UI timeout liên tiếp
      let consecutiveAllApi500 = 0; // API toàn 500 (dù UI ra sao) — API đang hỏng
      let consecutiveInternalError = 0; // API toàn INTERNAL-ERROR (nhiều luồng tranh chấp)
      let aliasTimeoutCount = 0;
      let pendingThenRotate = false;

      if (pendingStillExist.length > 0 || pendingEmails.length > 0) {
        // Pending có email → reconcile: alias phải match pending

        // 1. Xóa alias không trong pending
        const toDeleteNow = [];
        for (const alias of existing) {
          const fullLower = alias.full.toLowerCase();
          const localLower = (alias.local || "").toLowerCase();
          if (fullLower === mainLower || localLower === mainLocal) continue;
          if (pendingSet.has(fullLower)) continue;
          toDeleteNow.push(alias.local);
        }
        if (toDeleteNow.length > 0) {
          log.info(`Deleting ${toDeleteNow.length} non-pending alias(es)...`);
          const delRes1 = await deleteAliases(
            tOnlineActivePage,
            toDeleteNow,
            mainAccount.email,
          );
          if (delRes1.twoFactorBlocked) {
            twoFactorBlocked = true;
            break;
          }
          await gotoAliasPage(tOnlineActivePage);
        }

        // 2. Check pending nào chưa có trong alias → add lại
        const currentAliases = await listCurrentAliases(tOnlineActivePage);
        const currentFullSet = new Set(
          currentAliases.map((a) => a.full.toLowerCase()),
        );
        const missingFromAlias = pendingEmails.filter(
          (e) => !currentFullSet.has(e.toLowerCase()),
        );

        if (missingFromAlias.length > 0) {
          log.info(
            `Re-aliasing ${missingFromAlias.length} pending email(s) missing from account...`,
          );
          for (const em of missingFromAlias) {
            const local = localPart(em);
            const emDomain = em.includes("@")
              ? em.split("@")[1].toLowerCase()
              : "t-online.de";
            try {
              const result = await addSingleAlias(
                tOnlineActivePage,
                local,
                emDomain,
              );
              if (result === true || result?.ok === true) {
                log.ok(`Re-aliased: ${em}`);
              } else {
                log.warn(
                  `Re-alias failed: ${em} (${result?.reason}) — removing from pending`,
                );
                await fileIO.removeFromPending(em);
                await fileIO.writeFailed(
                  em,
                  `realias_${result?.reason || "unknown"}`,
                );
              }
            } catch (err) {
              log.err(`Re-alias error: ${em} — ${err.message}`);
              await fileIO.removeFromPending(em);
              await fileIO.writeFailed(em, `realias_error`);
            }
          }
        }

        // 3. Đọc lại pending (có thể đã thay đổi) → process
        const updatedPending = await fileIO.readPending();
        emailsToProcess = updatedPending.length > 0 ? updatedPending : [];

        if (emailsToProcess.length > 0) {
          log.ok(`Processing ${emailsToProcess.length} pending email(s)`);
        } else {
          log.info("No pending left after reconcile");
        }
      } else {
        // Không có pending → xóa hết alias cũ (chỉ giữ mail chính)
        const toDelete = [];
        for (const alias of existing) {
          const fullLower = alias.full.toLowerCase();
          const localLower = (alias.local || "").toLowerCase();
          if (fullLower === mainLower || localLower === mainLocal) continue;
          toDelete.push(alias.local);
        }

        if (toDelete.length > 0) {
          log.info(`Deleting ${toDelete.length} stale alias(es)...`);
          const delRes2 = await deleteAliases(
            tOnlineActivePage,
            toDelete,
            mainAccount.email,
          );
          if (delRes2.twoFactorBlocked) {
            twoFactorBlocked = true;
            break;
          }
          await gotoAliasPage(tOnlineActivePage);
        }

        // Add new aliases — TỪNG CON MỘT, ghi pending ngay sau mỗi con
        const existingAfter = await listCurrentAliases(tOnlineActivePage);
        const existingLocals = new Set(
          existingAfter.map((a) => (a.local || "").toLowerCase()),
        );
        const slotsAvailable = MAX_ALIASES_PER_ACCOUNT - existingAfter.length;
        const wanted = Math.min(slotsAvailable, updatedPool.length);

        if (wanted <= 0) {
          log.warn("No alias slots available");
          break;
        }

        emailsToProcess = [];
        let addedCount = 0; // chỉ đếm alias thành công (không đếm failure)
        const fehlerRetryCounts = new Map(); // track Fehler retry per mail
        const apiRoundRetries = new Map(); // track api_500 round-robin retry per mail
        const MAX_API_ROUND_RETRIES = 5;
        let consecutiveAliasFail = 0; // bất kỳ alias fail liên tiếp (reset khi có 1 con thành công)
        const MAX_CONSECUTIVE_FAIL = 20;
        let consecutiveDialogFail = 0; // dialog add không mở được → 2FA block

        while (addedCount < wanted && updatedPool.length > 0) {
          const rawEmail = updatedPool[0]; // peek, chưa xóa
          const local = localPart(rawEmail);
          const rawDomain = rawEmail.includes("@")
            ? rawEmail.split("@")[1].toLowerCase()
            : "t-online.de";

          // Skip nếu đã tồn tại trên account
          if (existingLocals.has(local.toLowerCase())) {
            updatedPool.shift(); // xóa khỏi memory
            emailsToProcess.push(rawEmail);
            await fileIO.removeFromPool(rawEmail);
            await fileIO.addToPending(rawEmail);
            addedCount++; // slot này đã dùng, tính là thành công
            log.info(`Already aliased, moving to pending: ${rawEmail}`);
            continue;
          }

          try {
            const result = await addSingleAlias(
              tOnlineActivePage,
              local,
              rawDomain,
            );

            // Track API toàn 500 (dù UI ra sao) — chỉ khi data=undefined tất cả
            if (result?.allApi500) {
              consecutiveAllApi500++;
              if (consecutiveAllApi500 >= 6) {
                log.err(
                  `🔴 API liên tục 500 ${consecutiveAllApi500} lần → T-Online API hỏng, đổi main`,
                );
                aliasTimedOut = true;
                aliasTimedOutReason = `api500x${consecutiveAllApi500}`;
                break;
              }
            } else {
              consecutiveAllApi500 = 0;
            }

            if (result === true || result?.ok === true) {
              consecutiveApi500 = 0;
              consecutiveInternalError = 0;
              aliasTimeoutCount = 0; // acc đang add được → không đổi main vì timeout cũ
              consecutiveAliasFail = 0; // có con thành công → reset streak
              consecutiveDialogFail = 0;
              addedCount++;
              updatedPool.shift(); // xóa khỏi memory
              emailsToProcess.push(rawEmail);
              await fileIO.removeFromPool(rawEmail);
              await fileIO.addToPending(rawEmail);
              existingLocals.add(local.toLowerCase());
              log.ok(`Aliased + pending: ${rawEmail}`);
              await delay(1000); // nghỉ 1s sau mỗi alias thành công
              try {
                await gotoAliasPage(tOnlineActivePage); // F5 trang alias trước khi add con tiếp
              } catch (gotoErr) {
                // Alias đã thêm thành công, đừng để lỗi F5 gây ra writeFailed sai
                log.warn(
                  `⚠️ gotoAliasPage sau success thất bại: ${gotoErr.message.slice(0, 60)} — bỏ qua`,
                );
              }
              continue; // sang alias tiếp theo
            } else {
              const reason = result?.reason || "unknown";
              // Toàn INTERNAL-ERROR (nhiều luồng tranh chấp) → đếm, sau 3 lần đổi acc
              if (reason === "all_internal_error") {
                consecutiveInternalError++;
                updatedPool.shift();
                await fileIO.removeFromPool(rawEmail);
                await fileIO.writeRetry(rawEmail, "alias_internal_error");
                log.warn(
                  `INTERNAL-ERROR liên tiếp lần ${consecutiveInternalError}: ${rawEmail}`,
                );
                if (consecutiveInternalError >= 3) {
                  log.err(
                    "🔴 INTERNAL-ERROR 3 lần liên tiếp → làm pending, đổi main",
                  );
                  pendingThenRotate = true;
                  break;
                }
                consecutiveAliasFail++;
                if (consecutiveAliasFail >= MAX_CONSECUTIVE_FAIL) {
                  log.warn(
                    `⚠️ ${MAX_CONSECUTIVE_FAIL} lần alias fail liên tiếp → làm pending, rotate region, đổi acc`,
                  );
                  pendingThenRotate = true;
                  switchAfterRotate = true;
                  break;
                }
                continue;
              }
              consecutiveInternalError = 0; // reset nếu lỗi khác
              // API 500 liên tiếp + UI cũng timeout → session/server bad, dừng sớm
              if (reason === "api500_timeout") {
                consecutiveApi500++;
                aliasTimeoutCount++;
                updatedPool.shift();
                await fileIO.removeFromPool(rawEmail);
                await fileIO.writeFailed(rawEmail, "alias_api500_timeout");
                log.warn(
                  `API 500 + UI timeout (${consecutiveApi500} consecutive): ${rawEmail}`,
                );
                if (consecutiveApi500 >= 2) {
                  log.err(
                    "🔴 API 500 liên tiếp 2 lần → T-Online session bad, đổi main",
                  );
                  aliasTimedOut = true;
                  aliasTimedOutReason = "api500_session_bad";
                  break;
                }
                continue;
              }
              // Timeout thường
              if (reason.toLowerCase().includes("timeout")) {
                aliasTimeoutCount++;
                consecutiveApi500 = 0;
                log.warn(`Alias timeout lần ${aliasTimeoutCount}: ${rawEmail}`);

                if (aliasTimeoutCount >= 2) {
                  // Lần 2 → làm hết pending hiện tại, rotate proxy EU, retry email này
                  log.warn(
                    "⏱️ Timeout lần 2 → làm pending hiện tại, rotate proxy EU, retry email này",
                  );
                  pendingThenRotate = true;
                  break; // giữ email trong pool, break while-loop
                }

                // Lần 1 → fail email này, thử tiếp
                updatedPool.shift();
                await fileIO.removeFromPool(rawEmail);
                await fileIO.writeFailed(rawEmail, "alias_timeout");
                consecutiveAliasFail++;
                if (consecutiveAliasFail >= MAX_CONSECUTIVE_FAIL) {
                  log.warn(
                    `⚠️ ${MAX_CONSECUTIVE_FAIL} lần alias fail liên tiếp → làm pending, rotate region, đổi acc`,
                  );
                  pendingThenRotate = true;
                  switchAfterRotate = true;
                  break;
                }
                continue;
              }

              // "Fehler" modal đã bị dismiss bởi addSingleAlias → reload + retry
              if (reason === "fehler") {
                const fehlerKey = `__fehler_${local}`;
                const retryCount = (fehlerRetryCounts.get(fehlerKey) || 0) + 1;
                fehlerRetryCounts.set(fehlerKey, retryCount);

                if (retryCount >= 3) {
                  log.warn(
                    `❌ ${rawEmail} — Fehler ${retryCount}/3 times → skipping`,
                  );
                  updatedPool.shift();
                  await fileIO.removeFromPool(rawEmail);
                  await fileIO.writeFailed(rawEmail, `alias_fehler_limit`);
                } else {
                  log.info(
                    `⚠️ ${rawEmail} — Fehler (${retryCount}/3) → reload page + retry`,
                  );
                  // Giữ email trong pool (không shift), reload page
                  try {
                    await tOnlineActivePage.reload({
                      waitUntil: "networkidle2",
                      timeout: 30000,
                    });
                    log.info("Page reloaded after Fehler");
                    await delay(2000);
                    await gotoAliasPage(tOnlineActivePage);
                    log.info("Back on alias page — retrying");
                  } catch (reloadErr) {
                    log.warn(`Reload failed: ${reloadErr.message}`);
                    try {
                      await gotoAliasPage(tOnlineActivePage);
                    } catch {}
                  }
                  // while loop không tự tăng → tự retry cùng mail
                }
                consecutiveAliasFail++;
                if (consecutiveAliasFail >= MAX_CONSECUTIVE_FAIL) {
                  log.warn(
                    `⚠️ ${MAX_CONSECUTIVE_FAIL} lần alias fail liên tiếp → làm pending, rotate region, đổi acc`,
                  );
                  pendingThenRotate = true;
                  switchAfterRotate = true;
                  break;
                }
                continue;
              }

              // Check "Es ist ein Fehler aufgetreten" dialog còn sót → max aliases
              const hasMaxDialog = await tOnlineActivePage
                .evaluate(() => {
                  const spans = document.querySelectorAll(
                    ".messageBody span, .body .note span",
                  );
                  for (const s of spans) {
                    if (s.textContent.includes("Fehler aufgetreten"))
                      return true;
                  }
                  return false;
                })
                .catch(() => false);

              if (hasMaxDialog) {
                log.warn(
                  "⚠️ Max aliases error dialog → dừng add, xử lý pending rồi xóa → add tiếp",
                );
                // Dismiss dialog
                await tOnlineActivePage
                  .evaluate(() => {
                    const btns = document.querySelectorAll("button");
                    for (const b of btns) {
                      const txt = (b.textContent || "").trim();
                      if (
                        txt === "OK" ||
                        txt === "Schließen" ||
                        b.classList.contains("close")
                      ) {
                        b.click();
                        break;
                      }
                    }
                  })
                  .catch(() => {});
                await delay(1000);
                break; // break alias loop — batch loop continues (add tiếp sau cleanup)
              }

              // Max aliases → break alias loop, xử lý pending rồi xóa → add tiếp
              if (reason === "max_aliases") {
                log.warn(
                  "Max aliases reached → break alias loop, process pending then cleanup",
                );
                break;
              }

              // api_500 / api_network_error → round-robin: đẩy xuống cuối pool, thử alias khác
              if (reason === "api_500" || reason === "api_network_error") {
                const retryCount = (apiRoundRetries.get(rawEmail) || 0) + 1;
                apiRoundRetries.set(rawEmail, retryCount);
                consecutiveAliasFail++;
                if (consecutiveAliasFail >= MAX_CONSECUTIVE_FAIL) {
                  log.warn(
                    `⚠️ ${MAX_CONSECUTIVE_FAIL} lần alias fail liên tiếp → làm pending, rotate region, đổi acc`,
                  );
                  pendingThenRotate = true;
                  switchAfterRotate = true;
                  break;
                }
                if (retryCount < MAX_API_ROUND_RETRIES) {
                  log.warn(
                    `⚠️  api_500 (${retryCount}/${MAX_API_ROUND_RETRIES}) [fail streak: ${consecutiveAliasFail}/${MAX_CONSECUTIVE_FAIL}]: ${rawEmail} → đẩy xuống cuối, thử alias khác trước`,
                  );
                  updatedPool.push(updatedPool.shift());
                  await delay(800);
                  continue;
                }
                // Đã retry đủ lần → fallback UI
                log.warn(
                  `⚠️  api_500 x${retryCount}: ${rawEmail} → fallback UI`,
                );
                let uiResult;
                try {
                  uiResult = await addSingleAliasUI(
                    tOnlineActivePage,
                    local,
                    rawDomain,
                  );
                } catch (e) {
                  uiResult = { ok: false, reason: "exception" };
                }
                if (uiResult.ok) {
                  apiRoundRetries.delete(rawEmail);
                  consecutiveAliasFail = 0;
                  updatedPool.shift();
                  await fileIO.removeFromPool(rawEmail);
                  await fileIO.addToPending(rawEmail);
                  addedCount++;
                  existingLocals.add(local.toLowerCase());
                  consecutiveApi500 = 0;
                  log.ok(
                    `✅ Aliased via UI fallback (${addedCount}/${wanted}): ${rawEmail}`,
                  );
                  await delay(1000);
                  try {
                    await gotoAliasPage(tOnlineActivePage); // F5 trang alias trước khi add con tiếp
                  } catch (gotoErr) {
                    log.warn(
                      `⚠️ gotoAliasPage sau UI fallback success thất bại: ${gotoErr.message.slice(0, 60)} — bỏ qua`,
                    );
                  }
                  continue; // sang alias tiếp theo
                } else {
                  updatedPool.shift();
                  await fileIO.removeFromPool(rawEmail);
                  await fileIO.writeFailed(
                    rawEmail,
                    `alias_api500_ui_${uiResult.reason || "fail"}`,
                  );
                  log.warn(
                    `❌ UI fallback cũng fail: ${rawEmail} (${uiResult.reason}) → failed`,
                  );
                  consecutiveAliasFail++;
                  if (consecutiveAliasFail >= MAX_CONSECUTIVE_FAIL) {
                    log.warn(
                      `⚠️ ${MAX_CONSECUTIVE_FAIL} lần alias fail liên tiếp → làm pending, rotate region, đổi acc`,
                    );
                    pendingThenRotate = true;
                    switchAfterRotate = true;
                    break;
                  }
                }
                continue;
              }

              // Lỗi khác (format sai, taken...) → ghi failed, xóa khỏi pool
              consecutiveApi500 = 0; // lỗi xác định → không phải server bad
              updatedPool.shift();
              await fileIO.removeFromPool(rawEmail);
              await fileIO.writeFailed(rawEmail, `alias_${reason}`);
              log.warn(`Alias invalid: ${rawEmail} (${reason}) → failed`);

              // Dialog add không mở → T-Online yêu cầu 2FA → switch acc ngay sau 3 lần
              if (reason === "dialog_failed") {
                consecutiveDialogFail++;
                if (consecutiveDialogFail >= 2) {
                  log.warn(
                    `🔐 ${consecutiveDialogFail} lần dialog add không mở → T-Online yêu cầu 2FA → đổi acc`,
                  );
                  twoFactorBlocked = true;
                  aliasTimedOut = true;
                  aliasTimedOutReason = "2fa_add_dialog";
                  break;
                }
              } else {
                consecutiveDialogFail = 0;
              }

              consecutiveAliasFail++;
              if (consecutiveAliasFail >= MAX_CONSECUTIVE_FAIL) {
                log.warn(
                  `⚠️ ${MAX_CONSECUTIVE_FAIL} lần alias fail liên tiếp → làm pending, rotate region, đổi acc`,
                );
                pendingThenRotate = true;
                switchAfterRotate = true;
                break;
              }
            }
          } catch (err) {
            log.err(`Alias error: ${err.message}`);
            const errMsg = (err.message || "").toLowerCase();
            if (
              err.message?.includes("RATE_LIMIT") ||
              err.name === "AliasRateLimitError"
            ) {
              // Rate limit → KHÔNG xóa email, giữ nguyên trong pool
              rateLimited = true;
              break;
            }
            // Timeout thrown
            if (errMsg.includes("timeout") || err.name === "TimeoutError") {
              aliasTimeoutCount++;
              log.warn(
                `Alias timeout thrown lần ${aliasTimeoutCount}: ${rawEmail}`,
              );

              if (aliasTimeoutCount >= 2) {
                log.warn(
                  "⏱️ Timeout lần 2 (thrown) → làm pending hiện tại, rotate proxy EU, retry email này",
                );
                pendingThenRotate = true;
                break; // giữ email trong pool
              }

              updatedPool.shift();
              await fileIO.removeFromPool(rawEmail);
              await fileIO.writeFailed(rawEmail, "alias_timeout");
              continue;
            }

            // Check "Es ist ein Fehler aufgetreten" dialog → max aliases
            const hasMaxDialogCatch = await tOnlineActivePage
              .evaluate(() => {
                const spans = document.querySelectorAll(
                  ".messageBody span, .body .note span",
                );
                for (const s of spans) {
                  if (s.textContent.includes("Fehler aufgetreten")) return true;
                }
                return false;
              })
              .catch(() => false);

            if (hasMaxDialogCatch) {
              log.warn(
                "⚠️ Max aliases error dialog (catch) → dừng add, xử lý pending → add tiếp",
              );
              await tOnlineActivePage
                .evaluate(() => {
                  const btns = document.querySelectorAll("button");
                  for (const b of btns) {
                    const txt = (b.textContent || "").trim();
                    if (
                      txt === "OK" ||
                      txt === "Schließen" ||
                      b.classList.contains("close")
                    ) {
                      b.click();
                      break;
                    }
                  }
                })
                .catch(() => {});
              await delay(1000);
              break; // break alias loop — batch loop continues
            }

            // Execution context destroyed = page navigate đi (không phải browser dead)
            // → thử recover bằng gotoAliasPage, nếu được thì retry alias này
            if (errMsg.includes("execution context was destroyed")) {
              log.warn(
                "⚠️ Execution context destroyed (page navigated) → thử recover gotoAliasPage...",
              );
              try {
                await gotoAliasPage(tOnlineActivePage);
                log.ok("✅ Recover thành công → retry alias này");
                continue; // retry alias hiện tại (không shift pool)
              } catch (recoverErr) {
                log.err(
                  `🔴 Recover thất bại: ${recoverErr.message.slice(0, 60)} → dừng, giữ pool`,
                );
                aliasTimedOut = true;
                aliasTimedOutReason = "context_destroyed_no_recover";
                break;
              }
            }

            // Session/frame dead thật sự → KHÔNG ghi failed, giữ pool, dừng ngay
            const isFrameDead =
              errMsg.includes("main frame too early") ||
              errMsg.includes("target closed") ||
              errMsg.includes("session closed") ||
              errMsg.includes("protocol error") ||
              errMsg.includes("connection closed") ||
              errMsg.includes("detached frame");
            if (isFrameDead) {
              log.err(
                `🔴 Browser session dead (${err.message.slice(0, 60)}) → dừng, giữ pool`,
              );
              aliasTimedOut = true;
              aliasTimedOutReason = `session_dead: ${err.message.slice(0, 50)}`;
              break;
            }

            // Lỗi khác → ghi failed, xóa khỏi pool
            updatedPool.shift();
            await fileIO.removeFromPool(rawEmail);
            await fileIO.writeFailed(
              rawEmail,
              `alias_error_${err.message.slice(0, 50)}`,
            );
          }
        }

        // Timeout 2 lần nhưng chưa có pending nào → đổi main luôn
        if (aliasTimedOut && emailsToProcess.length === 0) {
          log.warn(
            "No pending to process after timeout → switching main account",
          );
          break;
        }

        if (!aliasTimedOut && emailsToProcess.length === 0) {
          log.warn("No aliases added");
          break;
        }
      }

      log.ok(`Processing ${emailsToProcess.length} email(s)`);

      // STEP 2: Process each email
      log.divider("STEP 2: APPLE iFORGOT");
      const loopFailedEmails = [];
      const loopSuccessEmails = [];

      for (let i = 0; i < emailsToProcess.length; i++) {
        const email = emailsToProcess[i];
        totalProcessed++;

        const result = await processOneEmail(
          applePage,
          email,
          mainAccount,
          imap,
          fileIO,
        );

        if (result.ok) {
          totalSuccess++;
          loopSuccessEmails.push(email);
          log.ok(`[${totalSuccess} total] ✅ ${email} → ${result.password}`);
        } else if (
          result.reason === "503_need_relaunch" ||
          result.reason === "captcha_no_image_relaunch"
        ) {
          // Đóng + mở lại Apple browser
          const relaunchReason =
            result.reason === "503_need_relaunch"
              ? "503"
              : "CAPTCHA image not found";
          log.warn(`${relaunchReason} detected — relaunching Apple browser...`);
          await safeClose(appleBrowser, "Apple browser (503)");
          await delay(5000);

          const _appleProxyBase2 = config.APPLE_PROXY?.enabled
            ? config.APPLE_PROXY.address
            : null;
          const appleProxy2 =
            _appleProxyBase2 && config.APPLE_PROXY?.sticky
              ? makeStickyProxy(
                  _appleProxyBase2,
                  config.APPLE_PROXY?.stickyMinutes || 120,
                ) // sid mới = IP mới
              : _appleProxyBase2;
          if (appleProxy2) {
            const mode = config.APPLE_PROXY?.sticky
              ? "sticky sid mới"
              : "rotate";
            log.proxy(
              `Apple relaunch proxy: ${appleProxy2.split(":").slice(0, 2).join(":")} (${mode})`,
            );
          }
          appleBrowser = await launchBrowser(
            config,
            !!appleProxy2,
            appleProxy2,
            {
              size: config.BROWSER.IG_WINDOW_SIZE || "640,720",
              position: config.BROWSER.IG_WINDOW_POSITION || "640,0",
            },
          );
          applePage =
            (await appleBrowser.pages())[0] || (await appleBrowser.newPage());
          await delay(2000); // chờ browser/page init xong trước khi dùng CDP
          if (appleProxy2 && appleProxy2.split(":").length === 4) {
            const pp = appleProxy2.split(":");
            await applePage.authenticate({ username: pp[2], password: pp[3] });
          }
          applePage.on("dialog", async (dialog) => {
            await dialog.accept().catch(() => {});
          });
          await applePage.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Ch-Ua":
              '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
          });
          await applePage.setViewport({
            width: 1280,
            height: 700,
            deviceScaleFactor: 1,
          });

          // Clear cookies/cache/storage trước khi retry
          await clearBrowserData(applePage);
          log.info("🧹 Browser data cleared");

          // Check IP sau relaunch
          try {
            const ipData = await applePage.evaluate(async () => {
              const r = await fetch("https://ipinfo.io/json");
              return r.json();
            });
            log.proxy(
              `Apple IP (relaunch): ${ipData.ip} | Region: ${ipData.region || ipData.country} | City: ${ipData.city || "N/A"}`,
            );
          } catch (_e) {}

          log.ok("Apple browser relaunched — retrying email...");

          // Retry cùng email
          i--;
          totalProcessed--;
          continue;
        } else if (result.reason === "capsolver_fatal") {
          // CapSolver key sai hoặc hết tiền → dừng toàn bộ
          log.err("⛔ CapSolver fatal error — stopping all processing");
          return {
            processedCount: totalProcessed,
            successCount: totalSuccess,
            failedEmails: allFailedEmails,
            remainingPool: updatedPool,
            fullyDone: false,
            rateLimited: false,
            fatalStop: true,
          };
        } else {
          loopFailedEmails.push(email);
          allFailedEmails.push(email);
          log.err(`[FAIL] ${email}: ${result.reason}`);
        }

        // Clear browser sau mỗi mail để tránh dính session/spam
        log.info("Clearing Apple browser data...");
        try {
          await clearBrowserData(applePage);
          await applePage
            .goto("about:blank", { timeout: 5000 })
            .catch(() => {});
          // Re-set trust headers
          await applePage.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Ch-Ua":
              '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
          });
        } catch (e) {
          log.warn(`Clear browser error: ${e.message}`);
        }

        if (i < emailsToProcess.length - 1) {
          await delay(2000);
        }
      }

      log.ok(
        `Loop ${batchLoop}: ${loopSuccessEmails.length} success, ${loopFailedEmails.length} failed`,
      );

      // STEP 3: Xóa tất cả alias đã xử lý (success + failed) → giải phóng slot cho batch tiếp
      const allProcessed = [...loopSuccessEmails, ...loopFailedEmails];
      if (allProcessed.length > 0) {
        log.divider(
          `STEP 3: CLEANUP — delete ${allProcessed.length} processed alias(es)`,
        );
        try {
          await gotoAliasPage(tOnlineActivePage);
          const processedLocals = allProcessed.map((e) => localPart(e));
          const delRes3 = await deleteAliases(
            tOnlineActivePage,
            processedLocals,
            mainAccount.email,
          );
          if (delRes3.twoFactorBlocked) {
            twoFactorBlocked = true;
          }
        } catch (e) {
          log.err(`Cleanup error: ${e.message}`);
        }
      }

      // Sau STEP3: rotate proxy, sau đó retry cùng acc hoặc đổi acc tùy nguyên nhân
      if (pendingThenRotate) {
        pendingThenRotate = false;
        const doSwitch = switchAfterRotate; // true = đổi acc sau rotate (consecutive fail)
        switchAfterRotate = false;

        // Không có proxy (đang dùng VPN trực tiếp) → skip rotate
        if (!currentProxy) {
          log.warn(
            "⏱️ Timeout nhưng không có proxy configured (VPN mode) → tiếp tục với browser hiện tại",
          );
          if (doSwitch) {
            aliasTimedOut = true;
            aliasTimedOutReason = "consecutive_fail_vpn_mode";
            break;
          }
          continue;
        }
        // rotateRegion: false → giữ nguyên proxy, không đổi region
        if (config.TONLINE_PROXY?.rotateRegion === false) {
          log.warn("⏱️ rotateRegion=false → bỏ qua xoay proxy region");
          if (doSwitch) {
            aliasTimedOut = true;
            aliasTimedOutReason = "consecutive_fail_rotate_disabled";
            break;
          }
          continue;
        }
        const rotated = await rotateTOnlineBrowser();
        if (!rotated) {
          // Hết EU country → fail email hiện tại + switch main
          if (updatedPool.length > 0) {
            const failEmail = updatedPool[0];
            updatedPool.shift();
            await fileIO.removeFromPool(failEmail);
            await fileIO.writeFailed(failEmail, "alias_timeout_no_proxy");
            log.err("🌍 Hết EU country → fail email hiện tại, đổi main");
          }
          aliasTimedOut = true;
          aliasTimedOutReason = "rotate_failed_no_country";
          break;
        }
        if (doSwitch) {
          // Consecutive alias fail → rotate region xong đổi acc luôn (acc này bị block)
          log.ok(
            "🌍 Proxy rotated → đổi acc (consecutive fail, acc bị block theo region)",
          );
          aliasTimedOut = true;
          aliasTimedOutReason = "consecutive_fail_after_rotate";
          break;
        }
        // Timeout thuần (không phải consecutive fail) → counter tự reset ở đầu batchLoop mới
        log.ok("🌍 Proxy rotated → retry email cũ với counter fresh");
        continue;
      }

      if (rateLimited) {
        log.warn("Main rate-limited → chuyển main khác");
        break;
      }

      if (aliasTimedOut) {
        log.warn(
          `⚠️ Alias stopped (${aliasTimedOutReason || "unknown"}) → done processing pending → chuyển main khác`,
        );
        break;
      }
    }
  } catch (e) {
    const proxyInfo = proxy
      ? ` (proxy: ${proxy.split(":").slice(0, 2).join(":")})`
      : " (no proxy)";
    log.err(`Batch error: ${e.message}${proxyInfo}`);
  } finally {
    await safeClose(appleBrowser, "Apple browser");
    await safeClose(tOnlineBrowser, "T-Online browser");
  }

  return {
    processedCount: totalProcessed,
    successCount: totalSuccess,
    failedEmails: allFailedEmails,
    remainingPool: updatedPool,
    fullyDone: totalSuccess >= (config.TONLINE?.BATCH_SIZE || 10),
    rateLimited,
    twoFactorBlocked,
    switchedAway: aliasTimedOut || rateLimited, // acc bị đổi do timeout/rate limit → move to done
  };
}

// ════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ════════════════════════════════════════════════════════════════════
async function runMain(config) {
  installErrorHandlers();

  console.log(`
╔═══════════════════════════════════════════════╗
║   Apple iForgot Password Reset Automation     ║
║   + T-Online Auto Alias / Cleanup             ║
║         IMAP: ${config.IMAP.host.padEnd(28)}║
║         Data: ${config.PATHS.MAIN_ACCOUNTS.padEnd(28)}║
╚═══════════════════════════════════════════════╝
  `);

  // Init CapSolver (enabled/disabled từ config)
  initCapsolver(config);

  const fileIO = createFileIO(config);
  const imap = createImapClient(config);
  const proxyMgr = createProxyManager(config);

  const mainAccounts = await fileIO.readMainAccounts();
  if (!mainAccounts.length) {
    log.err("No main accounts found");
    return;
  }

  let pool = await fileIO.readWorkingEmailPool();
  let totalSuccess = 0;
  let totalFailed = 0;

  for (const mainAccount of mainAccounts) {
    if (pool.length === 0) {
      log.err("Pool cạn — dừng");
      break;
    }

    const result = await processBatchForMain(
      mainAccount,
      pool,
      proxyMgr,
      fileIO,
      imap,
      config,
    );

    totalSuccess += result.successCount;
    totalFailed += result.failedEmails.length;
    pool = result.remainingPool;

    await fileIO.saveWorkingEmailPool(pool);

    log.divider(`SUMMARY — ${mainAccount.email}`);
    log.info(
      `Success: ${result.successCount}, Failed: ${result.failedEmails.length}, Pool: ${pool.length}`,
    );

    if (result.fatalStop) {
      log.err("⛔ Fatal error — stopping all instances");
      break;
    }

    // 2FA block → move to done (không recycle, acc này bị T-Online chặn)
    if (result.twoFactorBlocked) {
      log.warn(`🔐 2FA block — move ${mainAccount.email} → done`);
      await fileIO.moveMainAccountToDone(mainAccount.email);
      log.ok(`Main ${mainAccount.email} → done (2fa_block)`);
    } else {
      // Chuyển acc xuống cuối để chạy lại liên tục, không cần canh tay
      await fileIO.recycleMainAccount(mainAccount.email);
      log.ok(`Main ${mainAccount.email} → recycled to bottom`);
    }

    await delay(5000);
  }

  console.log(`
╔═══════════════════════════════════════════════╗
║              Processing Complete              ║
║  ✅ Successful: ${totalSuccess.toString().padEnd(29)}║
║  ❌ Failed:     ${totalFailed.toString().padEnd(29)}║
║  📦 Pool left:  ${pool.length.toString().padEnd(29)}║
╚═══════════════════════════════════════════════╝
  `);
}

module.exports = { runMain };
