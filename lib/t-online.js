"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { delay, randomDelay, randInt, log } = require("./utils");

// ════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════
const ACCOUNT_DETAILS_URL = "https://email.t-online.de/pr?a=accountdetails";
const MAX_ALIASES_PER_ACCOUNT = 10;
// Số lần fail liên tiếp tối đa trước khi tuyên bố rate-limit / acc bị block alias
const RATE_LIMIT_THRESHOLD = 5;
const IG_ROTATE_EVERY_N_ACCOUNTS = 5;
// ════════════════════════════════════════════════════════════════════
// CUSTOM ERROR
// ════════════════════════════════════════════════════════════════════
class AliasRateLimitError extends Error {
  constructor(consecutiveFails) {
    super(
      `Alias rate-limited / blocked after ${consecutiveFails} consecutive failures`,
    );
    this.name = "AliasRateLimitError";
    this.consecutiveFails = consecutiveFails;
  }
}

// ════════════════════════════════════════════════════════════════════
// 2FA TOKEN — tự tính TOTP locally, không cần API
// ════════════════════════════════════════════════════════════════════
function base32Decode(base32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of base32.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "")) {
    const idx = chars.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function get2FAToken(secret) {
  const cleanSecret = (secret || "").replace(/\s+/g, "");
  if (!cleanSecret) throw new Error("2FA secret is empty");
  const key = base32Decode(cleanSecret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, "0");
}

// ════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════
async function typeHumanT(page, selector, text, baseDelay = 60) {
  await page.click(selector);
  await randomDelay(150, 350);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, selector);
  await randomDelay(120, 250);
  for (const ch of text) {
    await page.keyboard.type(ch, {
      delay: baseDelay + Math.floor(Math.random() * 60),
    });
  }
}

function waitForNewPage(browser, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for new tab")),
      timeout,
    );
    browser.once("targetcreated", async (target) => {
      clearTimeout(timer);
      try {
        const p = await target.page();
        resolve(p);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function localPart(email) {
  return String(email || "")
    .split("@")[0]
    .trim();
}

function buildAlias(local, domain = "t-online.de") {
  return `${local}@${domain}`;
}

// ════════════════════════════════════════════════════════════════════
// LOGIN T-ONLINE
// ════════════════════════════════════════════════════════════════════
async function loginTOnline(
  browser,
  page,
  mainEmail,
  mainPass,
  totpSecret,
  config,
) {
  log.divider(`T-Online Login: ${mainEmail}`);

  // Reset cached stkn token on new login (token is per-session)
  _cachedStkn = null;

  try {
    const client = await page.target().createCDPSession();
    await client.send("Network.clearBrowserCookies");
    await client.send("Network.clearBrowserCache");
  } catch {}

  await page.goto("https://www.t-online.de/", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await delay(2000);
  await dismissTOnlineConsent(page).catch(() => {});

  // ============================================================
  // 1. Lấy OAuth URL từ nút E-Mail Login
  // ============================================================

  let oauthUrl = null;

  try {
    oauthUrl = await page.evaluate(() => {
      const el =
        document.querySelector("[data-testid='EMail.LoginButton']") ||
        document.querySelector("[data-testid='Email.LoginButton']");

      if (!el) return null;

      // Nếu element là <a>
      if (el.href) return el.href;

      // Một số version có URL nằm trong attribute
      for (const attr of ["href", "data-href", "data-url", "data-login-url"]) {
        const value = el.getAttribute?.(attr);

        if (value && /^https?:\/\//i.test(value)) {
          return value;
        }
      }

      return null;
    });
  } catch (e) {
    log.warn(`Cannot read OAuth URL: ${e.message}`);
  }

  // ============================================================
  // 2. Nếu lấy được OAuth URL -> mở trực tiếp
  // ============================================================

  let loginPage = null;

  if (
    oauthUrl &&
    (oauthUrl.includes("accounts.login.idm.telekom.com") ||
      oauthUrl.includes("login.idm.telekom.com"))
  ) {
    log.ok("Telekom OAuth URL detected");
    log.info(`OAuth URL: ${oauthUrl.slice(0, 180)}...`);

    loginPage = await browser.newPage();

    // Proxy authentication nếu đang dùng proxy
    if (config?.PROXY?.enabled && config?.PROXY?.address) {
      const parts = config.PROXY.address.split(":");

      if (parts.length === 4) {
        await loginPage
          .authenticate({
            username: parts[2],
            password: parts[3],
          })
          .catch(() => {});
      }
    }

    await loginPage
      .goto(oauthUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch(() => {});

    await delay(2000);
  } else {
    // ==========================================================
    // 3. Fallback: click nút và bắt page mới
    // ==========================================================

    log.warn("OAuth URL not available directly — clicking E-Mail Login");

    const pagesBefore = await browser.pages();
    const pageSetBefore = new Set(pagesBefore);

    await page.bringToFront().catch(() => {});

    await page.evaluate(() => {
      const el =
        document.querySelector("[data-testid='EMail.LoginButton']") ||
        document.querySelector("[data-testid='Email.LoginButton']");

      el?.click();
    });

    log.info("Clicked E-Mail Login");

    const timeout = Date.now() + 15000;

    while (Date.now() < timeout) {
      const pages = await browser.pages();

      // Ưu tiên page OAuth
      loginPage = pages.find((p) => {
        const url = p.url();

        return (
          url.includes("accounts.login.idm.telekom.com") ||
          url.includes("login.idm.telekom.com")
        );
      });

      if (loginPage) {
        break;
      }

      // Có page mới nhưng URL chưa cập nhật
      const newPage = pages.find((p) => !pageSetBefore.has(p));

      if (newPage) {
        await delay(1000);

        const url = newPage.url();

        if (
          url.includes("accounts.login.idm.telekom.com") ||
          url.includes("login.idm.telekom.com")
        ) {
          loginPage = newPage;
          break;
        }
      }

      // Có thể navigation xảy ra trên tab hiện tại
      const currentUrl = page.url();

      if (
        currentUrl.includes("accounts.login.idm.telekom.com") ||
        currentUrl.includes("login.idm.telekom.com")
      ) {
        loginPage = page;
        break;
      }

      await delay(500);
    }
  }

  // ============================================================
  // 4. Không được phép fallback mù về homepage
  // ============================================================

  if (!loginPage) {
    const pages = await browser.pages();

    const urls = pages.map((p) => p.url()).join(" | ");

    throw new Error(`Cannot find Telekom OAuth login page. All tabs: ${urls}`);
  }

  try {
    await loginPage.bringToFront();
  } catch {}

  await delay(1500);

  // ============================================================
  // Helper: tìm input visible
  // ============================================================

  async function findVisibleInput(selectors, timeout = 30000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      for (const selector of selectors) {
        try {
          const handle = await loginPage.$(selector);

          if (!handle) continue;

          const visible = await handle.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);

            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              !el.disabled
            );
          });

          if (visible) {
            return selector;
          }
        } catch {}
      }

      await delay(300);
    }

    return null;
  }

  // ============================================================
  // 6. EMAIL
  // ============================================================

  const emailSelector = await findVisibleInput([
    "input[type='email']",
    "input[autocomplete='username']",
    "input[autocomplete='email']",
    "input[name='email']",
    "input[name='username']",
    "input[name='identifier']",
    "input[id*='email' i]",
    "input[id*='username' i]",
    "input[placeholder*='E-Mail' i]",
    "input[placeholder*='Email' i]",
  ]);

  if (!emailSelector) {
    throw new Error(`Telekom email input not found. URL: ${loginPage.url()}`);
  }

  log.info(`Email selector: ${emailSelector}`);

  await typeIntoStableInput(loginPage, emailSelector, mainEmail, "email");

  await delay(500);

  // ============================================================
  // 7. Submit email
  // ============================================================

  const submitEmail = await loginPage.evaluate(() => {
    const buttons = [
      ...document.querySelectorAll("button"),
      ...document.querySelectorAll("input[type='submit']"),
      ...document.querySelectorAll("[role='button']"),
    ];

    const keywords = [
      "weiter",
      "continue",
      "next",
      "anmelden",
      "login",
      "sign in",
      "fortfahren",
    ];

    for (const el of buttons) {
      const text = (el.innerText || el.textContent || el.value || "")
        .trim()
        .toLowerCase();

      if (
        keywords.some((keyword) => text === keyword || text.includes(keyword))
      ) {
        const rect = el.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          el.click();
          return true;
        }
      }
    }

    const form = document.querySelector("form");

    if (form) {
      form.requestSubmit?.();
      return true;
    }

    return false;
  });

  if (!submitEmail) {
    await loginPage.focus(emailSelector).catch(() => {});

    await loginPage.keyboard.press("Enter").catch(() => {});
  }

  log.info("Submitted Telekom email");

  await delay(4000);

  // ============================================================
  // 8. PASSWORD
  // ============================================================

  const passwordSelector = await findVisibleInput(
    [
      "input[type='password']",
      "input[autocomplete='current-password']",
      "input[autocomplete='password']",
      "input[name='password']",
      "input[name='passwd']",
      "input[id*='password' i]",
    ],
    45000,
  );

  if (!passwordSelector) {
    throw new Error(
      `Telekom password input not found. URL: ${loginPage.url()}`,
    );
  }

  log.info(`Password selector: ${passwordSelector}`);

  await typeIntoStableInput(loginPage, passwordSelector, mainPass, "password");

  await delay(500);

  // ============================================================
  // 9. Submit password
  // ============================================================

  const submitPassword = await loginPage.evaluate(() => {
    const buttons = [
      ...document.querySelectorAll("button"),
      ...document.querySelectorAll("input[type='submit']"),
      ...document.querySelectorAll("[role='button']"),
    ];

    const keywords = [
      "weiter",
      "continue",
      "next",
      "anmelden",
      "login",
      "sign in",
      "fortfahren",
    ];

    for (const el of buttons) {
      const text = (el.innerText || el.textContent || el.value || "")
        .trim()
        .toLowerCase();

      if (
        keywords.some((keyword) => text === keyword || text.includes(keyword))
      ) {
        const rect = el.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          el.click();
          return true;
        }
      }
    }

    const form = document.querySelector("form");

    if (form) {
      form.requestSubmit?.();
      return true;
    }

    return false;
  });

  if (!submitPassword) {
    await loginPage.focus(passwordSelector).catch(() => {});

    await loginPage.keyboard.press("Enter").catch(() => {});
  }

  log.ok("Submitted Telekom password");

  await delay(4000);

  // ============================================================
  // 10. 2FA
  // ============================================================

  await handle2FAIfNeeded(loginPage, totpSecret, config);

  // ============================================================
  // 11. OAuth 2FA xong -> popup login tự đóng
  //     Quay về TAB CHÍNH và mở mailbox trực tiếp
  // ============================================================

  log.info("2FA submitted — waiting for OAuth popup to close...");

  // Đợi popup OAuth thực sự đóng (poll đến 20s)
  const popupCloseStart = Date.now();
  while (Date.now() - popupCloseStart < 20000) {
    try {
      if (loginPage.isClosed()) break;
    } catch {
      break; // isClosed() throw = đã đóng
    }
    await delay(500);
  }
  // Nếu vẫn chưa đóng → đợi thêm 3s rồi tiếp tục
  try {
    if (!loginPage.isClosed()) {
      log.warn("OAuth popup chưa đóng sau 20s — tiếp tục anyway");
      await delay(3000);
    }
  } catch {}

  // Tab chính chính là `page`
  const mainPage = page;

  try {
    await mainPage.bringToFront();
  } catch {}

  // ============================================================
  // Mở trực tiếp mailbox — retry nếu bị redirect về www
  // ============================================================

  log.info("Opening T-Online mailbox...");

  for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
    await mainPage
      .goto("https://email.t-online.de/pr", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch((e) => {
        log.warn(`Mailbox navigation attempt ${navAttempt}: ${e.message}`);
      });

    await delay(4000);
    console.log(`MAILBOX URL (attempt ${navAttempt}):`, mainPage.url());

    if (mainPage.url().includes("email.t-online.de")) break;

    log.warn(
      `Bị redirect về ${mainPage.url().slice(0, 60)} → retry (${navAttempt}/3)`,
    );
    await delay(3000);
  }

  // ============================================================
  // 12. Để logic bên dưới bắt email page
  // ============================================================

  let activePage = mainPage;

  const startWait = Date.now();

  while (Date.now() - startWait < 30000) {
    const allPages = await browser.pages();

    const emailPage = allPages.find((p) => {
      const url = p.url();

      return (
        url.includes("email.t-online.de/pr") ||
        url.includes("email.t-online.de/em") ||
        url.includes("email.t-online.de/?folder=") ||
        url.includes("email.t-online.de")
      );
    });

    if (emailPage) {
      activePage = emailPage;

      log.ok(`Email page found: ${activePage.url().slice(0, 120)}`);

      break;
    }

    await delay(1000);
  }

  // ============================================================
  // 13. Verify
  // ============================================================

  if (!activePage.url().includes("email.t-online.de")) {
    const urls = (await browser.pages()).map((p) => p.url()).join(" | ");

    throw new Error(`T-Online mailbox not opened. All tabs: ${urls}`);
  }

  try {
    await activePage.bringToFront();
  } catch {}

  log.ok(`Active page: ${activePage.url().slice(0, 120)}`);

  await delay(2000);

  return activePage;
}

/**
 * Type vào input ổn định: focus → clear → type → verify → retry nếu rỗng.
 * Fallback set value qua evaluate nếu type fail 3 lần.
 */
async function typeIntoStableInput(page, selector, value, label) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log.info(`type ${label} (attempt ${attempt}/${MAX_ATTEMPTS})`);

    // 1. Đợi input visible
    try {
      await page.waitForSelector(selector, {
        visible: true,
        timeout: 15000,
      });
    } catch (e) {
      throw new Error(`${label} input not visible: ${e.message}`);
    }

    // 2. Đợi input thật sự interactable (không bị overlay đè)
    await page
      .waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          // Check overlay đè
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const top = document.elementFromPoint(cx, cy);
          if (!top) return false;
          // Top element phải là input hoặc nằm trong input (label wrapper)
          return top === el || el.contains(top) || top.contains(el);
        },
        { timeout: 8000 },
        selector,
      )
      .catch(() => {});

    // 3. Click vào input để focus (3 lần để select all nếu có giá trị cũ)
    try {
      await page.click(selector, { clickCount: 3 });
    } catch (e) {
      log.warn(`click ${label} fail: ${e.message}`);
    }
    await delay(150);

    // 4. Clear value cũ (key Backspace + clear via evaluate)
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, selector);
    await delay(100);

    // 5. Type với delay (human-like, đảm bảo từng phím)
    try {
      await page.type(selector, value, { delay: 80 });
    } catch (e) {
      log.warn(`type ${label} threw: ${e.message}`);
    }
    await delay(300);

    // 6. Verify giá trị đã vào
    const actual = await page.$eval(selector, (el) => el.value).catch(() => "");

    if (actual === value) {
      log.ok(`${label} entered OK (length=${actual.length})`);
      return true;
    }

    log.warn(
      `${label} value mismatch: expected="${value.slice(0, 3)}..." got="${actual.slice(0, 10)}" len=${actual.length}`,
    );

    if (attempt < MAX_ATTEMPTS) {
      // Bring to front lần nữa (focus có thể bị mất)
      try {
        await page.bringToFront();
      } catch {}
      await delay(800);
    }
  }

  // Fallback cuối: set value qua evaluate + dispatch events
  log.warn(`${label} type retry exhausted, fallback set value via evaluate`);
  const fallbackOk = await page
    .evaluate(
      (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        // React/Angular cần native setter để trigger update
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return el.value === val;
      },
      selector,
      value,
    )
    .catch(() => false);

  if (!fallbackOk) {
    throw new Error(`Cannot type ${label} into ${selector}`);
  }
  log.ok(`${label} entered via fallback`);
  return true;
}

/**
 * Dismiss T-Online consent banner (nếu có).
 * Banner thường có nút "Akzeptieren" / "Alle akzeptieren" / "Zustimmen".
 */
async function dismissTOnlineConsent(page) {
  return await page
    .evaluate(() => {
      const TEXTS = [
        "Akzeptieren",
        "Alle akzeptieren",
        "Alle Cookies akzeptieren",
        "Zustimmen",
        "Accept all",
        "Accept All",
        "Einverstanden",
      ];
      const candidates = [
        ...document.querySelectorAll("button"),
        ...document.querySelectorAll('[role="button"]'),
        ...document.querySelectorAll("a"),
      ];
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || "").trim();
        if (!TEXTS.some((t) => txt === t || txt.includes(t))) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        el.click();
        return txt;
      }
      // Iframe consent (TCF)
      const iframe = document.querySelector(
        'iframe[id*="sp_message"], iframe[id*="consent"], iframe[title*="onsent" i]',
      );
      if (iframe) return "iframe-detected";
      return null;
    })
    .catch(() => null);
}

/**
 * Dismiss T-Online Sourcepoint cookie dialog (#notice với "Allem zustimmen").
 * Dialog này hay xuất hiện ~8s sau khi vào /pr?a=accountdetails và che mất form add mail.
 * Có thể nằm trong iframe hoặc main page.
 */
async function dismissTOnlineCookieNotice(page, maxWaitMs = 8000) {
  log.info("Waiting for cookie notice (max 8s)...");
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    // Try main page trước
    const mainResult = await page
      .evaluate(() => {
        // Method 1: button class sp_choice_type_11 (accept all)
        let btn = document.querySelector("button.sp_choice_type_11");
        if (btn) {
          btn.click();
          return "main:sp_choice_type_11";
        }
        // Method 2: aria-label / title "Allem zustimmen"
        btn =
          document.querySelector('button[aria-label="Allem zustimmen"]') ||
          document.querySelector('button[title="Allem zustimmen"]');
        if (btn) {
          btn.click();
          return "main:Allem zustimmen";
        }
        // Method 3: text content
        for (const b of document.querySelectorAll("button")) {
          const txt = (b.innerText || b.textContent || "").trim();
          if (
            txt === "Allem zustimmen" ||
            txt === "Accept all" ||
            txt === "Akzeptieren"
          ) {
            b.click();
            return "main:" + txt;
          }
        }
        return null;
      })
      .catch(() => null);

    if (mainResult) {
      log.ok(`Cookie notice clicked (${mainResult})`);
      await delay(2500);
      return true;
    }

    // Try iframes (Sourcepoint thường render trong iframe)
    for (const frame of page.frames()) {
      const url = frame.url() || "";
      const name = frame.name() || "";
      // Heuristic: iframe của Sourcepoint hoặc privacy-mgmt
      if (
        !url.includes("privacy") &&
        !url.includes("sourcepoint") &&
        !url.includes("consent") &&
        !name.includes("sp_message")
      ) {
        // Vẫn thử nếu là iframe nhỏ — không skip cứng
      }
      try {
        const result = await frame
          .evaluate(() => {
            let btn = document.querySelector("button.sp_choice_type_11");
            if (btn) {
              btn.click();
              return "iframe:sp_choice_type_11";
            }
            btn =
              document.querySelector('button[aria-label="Allem zustimmen"]') ||
              document.querySelector('button[title="Allem zustimmen"]');
            if (btn) {
              btn.click();
              return "iframe:Allem zustimmen";
            }
            for (const b of document.querySelectorAll("button")) {
              const txt = (b.innerText || b.textContent || "").trim();
              if (txt === "Allem zustimmen") {
                b.click();
                return "iframe:" + txt;
              }
            }
            return null;
          })
          .catch(() => null);
        if (result) {
          log.ok(`Cookie notice clicked in iframe (${result})`);
          await delay(2500);
          return true;
        }
      } catch (_) {}
    }

    await delay(1000);
  }

  log.warn("Cookie notice không xuất hiện hoặc đã bị dismiss trước");
  return false;
}

async function handle2FAIfNeeded(page, totpSecret, config) {
  const need2FA = await page
    .evaluate(() => {
      const h1 = Array.from(document.querySelectorAll("h1")).find((h) =>
        h.textContent.includes("Bestätigungscode aus App"),
      );
      const totpInput = document.querySelector('input[name="totp"]');
      return !!(h1 || totpInput);
    })
    .catch(() => false);

  if (!need2FA) {
    log.info("No 2FA challenge");
    return;
  }

  log.warn("2FA challenge detected");
  if (!totpSecret) throw new Error("2FA required but no TOTP secret provided");

  const token = get2FAToken(totpSecret);
  log.ok(`Got 2FA token: ${token}`);

  await page.waitForSelector('input[name="totp"]', {
    visible: true,
    timeout: 10000,
  });
  await typeHumanT(page, 'input[name="totp"]', token);
  await delay(500);

  await page.evaluate(() => {
    const btn = document.querySelector('button[name="next"]');
    btn?.click();
  });
  log.ok("Submitted 2FA token");
  await delay(5000);
}

// ════════════════════════════════════════════════════════════════════
// NAVIGATE TO ALIAS PAGE
// ════════════════════════════════════════════════════════════════════
async function gotoAliasPage(page) {
  log.info("Navigating to alias management page");
  await page.goto(ACCOUNT_DETAILS_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await delay(2000);

  // Retry click + wait tối đa 3 lần nếu container không xuất hiện
  let containerLoaded = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const clicked = await page.evaluate(() => {
      for (const a of document.querySelectorAll("a")) {
        if (a.textContent && a.textContent.includes("Zusätzliche Adressen")) {
          a.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      log.ok(`Clicked 'Zusätzliche Adressen' (attempt ${attempt})`);
    } else {
      log.warn(
        `Could not find 'Zusätzliche Adressen' link (attempt ${attempt})`,
      );
    }

    try {
      await page.waitForSelector("#additionalaliasesNormalContainer", {
        timeout: attempt === 1 ? 8000 : 5000,
      });
      log.ok("Alias container loaded");
      containerLoaded = true;
      break;
    } catch {
      if (attempt < 3) {
        log.warn(
          `Alias container not loaded (attempt ${attempt}/3) — retrying click`,
        );
        await delay(1500);
      } else {
        log.warn("Alias container did not appear after 3 attempts");
      }
    }
  }

  await delay(containerLoaded ? 1500 : 500);
}

// ════════════════════════════════════════════════════════════════════
// LIST CURRENT ALIASES
// ════════════════════════════════════════════════════════════════════
async function listCurrentAliases(page) {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll(
        "#email-address-additionalaliases-table tr.listTableRow",
      ),
    );
    return rows.map((r) => {
      const local = r.getAttribute("data-alias-row") || "";
      const domain = r.getAttribute("data-domainpart-row") || "";
      return { local, domain, full: `${local}${domain}` };
    });
  });
}

// ════════════════════════════════════════════════════════════════════
// RECONCILE — ★ KHÔNG XÓA alias fail-but-exist, ghi ra file riêng
// ════════════════════════════════════════════════════════════════════
async function reconcileAliases(
  page,
  successSet,
  failedSet,
  is681Set,
  captchaSet,
  mainEmail,
) {
  log.divider("RECONCILE ALIASES with history");

  await gotoAliasPage(page);
  await dismissTOnlineCookieNotice(page, 12000);
  const existing = await listCurrentAliases(page);
  log.info(`Found ${existing.length} alias(es) on account`);

  if (existing.length === 0) {
    return { kept: [], deleted: [], orphans: [], failedButExist: [] };
  }

  const mainLower = (mainEmail || "").trim().toLowerCase();
  const mainLocalLower = mainLower.split("@")[0];

  const kept = [];
  const toDelete = [];
  const orphans = [];
  const failedButExist = [];
  let skippedMain = 0;

  for (const alias of existing) {
    const fullLower = alias.full.toLowerCase();
    const localLower = (alias.local || "").toLowerCase();

    // SKIP mail chính
    if (
      mainLower &&
      (fullLower === mainLower || localLower === mainLocalLower)
    ) {
      log.warn(`⛔ SKIP MAIN: ${alias.full} (mail chính, không xóa)`);
      skippedMain++;
      continue;
    }

    // Priority: success > 681 > captcha > fail-but-exist > orphan
    if (successSet.has(fullLower)) {
      kept.push(alias);
      log.ok(`KEEP: ${alias.full} (already success)`);
    } else if (is681Set && is681Set.has(fullLower)) {
      kept.push(alias);
      log.ok(`KEEP: ${alias.full} (681 — treat as success)`);
    } else if (captchaSet && captchaSet.has(fullLower)) {
      kept.push(alias);
      log.ok(`KEEP: ${alias.full} (captcha — treat as success)`);
    } else if (failedSet.has(fullLower)) {
      // ★ Alias tồn tại trên account nhưng script báo fail
      //   → KEEP (không xóa), ghi vào file riêng để review thủ công
      kept.push(alias);
      failedButExist.push(alias.full);
      log.warn(`KEEP (fail but exists on account): ${alias.full}`);
    } else {
      orphans.push(alias.full);
      log.info(`ORPHAN: ${alias.full} (not yet processed)`);
    }
  }

  // ★ Ghi các alias fail-but-exist ra file riêng
  if (failedButExist.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const header = `# ${timestamp} | main: ${mainEmail} | count: ${failedButExist.length}\n`;
    const lines = failedButExist.join("\n") + "\n";
    try {
      fs.appendFileSync("mail_alias_fail.txt", header + lines + "\n", "utf8");
      log.ok(
        `Ghi ${failedButExist.length} alias fail-but-exist vào mail_alias_fail.txt`,
      );
    } catch (e) {
      log.warn(`Không ghi được mail_alias_fail.txt: ${e.message}`);
    }
  }

  log.info(
    `Reconcile: ${kept.length} kept, ${toDelete.length} to delete, ${orphans.length} orphans, ${failedButExist.length} fail-but-exist, ${skippedMain} skipped main`,
  );

  const deleted = [];
  for (let i = 0; i < toDelete.length; i++) {
    const alias = toDelete[i];
    log.info(`[Reconcile delete ${i + 1}/${toDelete.length}] ${alias.local}`);

    if (i > 0) {
      await gotoAliasPage(page);
    }

    const r = await deleteSingleAlias(page, alias.local);
    if (r.ok) {
      deleted.push(alias);
    } else {
      log.warn(`Failed to delete ${alias.local}: ${r.reason}`);
    }
    await delay(1500);
  }

  await gotoAliasPage(page);

  log.ok(
    `Reconcile done: ${kept.length} kept, ${deleted.length} deleted, ${orphans.length} orphans, ${failedButExist.length} fail-but-exist`,
  );
  return { kept, deleted, orphans, failedButExist };
}

// ════════════════════════════════════════════════════════════════════
// ADD SINGLE ALIAS
// ════════════════════════════════════════════════════════════════════
// ── Cache security token (x-dtag-stkn) cho API calls ──
let _cachedStkn = null;

async function extractSecurityToken(page) {
  if (_cachedStkn) return _cachedStkn;

  // Cách 1: Tìm trong JS globals của LISA
  const fromJS = await page
    .evaluate(() => {
      // LISA framework thường lưu token ở các chỗ này
      if (typeof window.LISA !== "undefined") {
        if (window.LISA.stkn) return window.LISA.stkn;
        if (window.LISA.securityToken) return window.LISA.securityToken;
        if (window.LISA.config?.stkn) return window.LISA.config.stkn;
      }
      if (window.stkn) return window.stkn;
      if (window.securityToken) return window.securityToken;
      // Tìm trong meta tags
      const meta = document.querySelector('meta[name="stkn"]');
      if (meta) return meta.content;
      // Tìm trong data attributes
      if (document.body.dataset.stkn) return document.body.dataset.stkn;
      // Tìm trong hidden inputs
      const input = document.querySelector(
        'input[name="stkn"], input[name="securityToken"]',
      );
      if (input) return input.value;
      return null;
    })
    .catch(() => null);

  if (fromJS) {
    _cachedStkn = fromJS;
    log.info(`Got stkn from JS: ${fromJS.substring(0, 8)}...`);
    return fromJS;
  }

  // Cách 2: Intercept request khi click prüfen 1 lần để bắt header
  log.info("Extracting stkn by intercepting XHR...");
  let capturedToken = null;

  const requestHandler = (req) => {
    const headers = req.headers();
    if (headers["x-dtag-stkn"]) {
      capturedToken = headers["x-dtag-stkn"];
    }
  };
  page.on("request", requestHandler);

  // Mở dialog, gõ test, click prüfen 1 lần để trigger XHR
  const opened = await page.evaluate(() => {
    const link = document.querySelector(".add-alias-address-link-header");
    if (!link) return false;
    link.click();
    return true;
  });

  if (opened) {
    try {
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("h1.screenreader")).some(
            (h) => h.textContent.trim() === "Neue E-Mail-Adresse",
          ),
        { timeout: 8000 },
      );
      await delay(1000);

      const inputSelector =
        'scale-text-field#emailAddress input[name="emailAddress"]';
      await page
        .waitForSelector(inputSelector, { visible: true, timeout: 5000 })
        .catch(() => {});
      await page.click(inputSelector).catch(() => {});
      await page.keyboard.type("test123token", { delay: 30 });
      await delay(500);

      // Click prüfen để trigger XHR
      const btnSelector =
        'button.mediumBtn[data-l_mouse_cl="Newalias::checkEmailAddress"]';
      try {
        await page.click(btnSelector);
      } catch {}
      await delay(2000);
    } catch {}

    // Đóng dialog
    await closeAliasDialog(page);
    await delay(1000);
  }

  page.off("request", requestHandler);

  if (capturedToken) {
    _cachedStkn = capturedToken;
    log.info(
      `Got stkn from intercepted request: ${capturedToken.substring(0, 8)}...`,
    );
    return capturedToken;
  }

  // Cách 3: Tìm trong cookie
  const cookies = await page.cookies();
  const stknCookie = cookies.find(
    (c) => c.name === "stkn" || c.name === "x-dtag-stkn",
  );
  if (stknCookie) {
    _cachedStkn = stknCookie.value;
    log.info(`Got stkn from cookie: ${stknCookie.value.substring(0, 8)}...`);
    return stknCookie.value;
  }

  log.warn("Could not extract x-dtag-stkn token");
  return null;
}

// ── Add alias via API — 1 attempt duy nhất (retry do aliasBatch round-robin) ──
async function addSingleAlias(page, aliasLocal, domain = "t-online.de") {
  log.info(`Adding alias: ${aliasLocal}@${domain}`);

  const stkn = await extractSecurityToken(page);
  if (!stkn) {
    log.warn("No stkn token — falling back to UI method");
    return addSingleAliasUI(page, aliasLocal, domain);
  }

  const apiResult = await page.evaluate(
    async (alias, domain, token) => {
      try {
        const body = `alias=${encodeURIComponent(alias)}&domain=${encodeURIComponent(domain)}`;
        const resp = await fetch("/pr/srv/service.settings/addalias", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "x-dtag-stkn": token,
          },
          body,
        });
        const status = resp.status;
        let data = null;
        try {
          data = await resp.json();
        } catch {}
        return { status, data };
      } catch (err) {
        return { status: 0, error: err.message };
      }
    },
    aliasLocal,
    domain,
    stkn,
  );

  log.info(
    `API response: status=${apiResult.status} data=${JSON.stringify(apiResult.data || apiResult.error)}`,
  );

  // Success
  if (apiResult.status === 200 && apiResult.data?.p?.isAliasAdded === true) {
    log.ok(`✅ Alias added via API: ${aliasLocal}@${domain}`);
    return { ok: true };
  }

  // Definitive failures — không retry
  if (apiResult.data?.p) {
    const p = apiResult.data.p;
    if (p.isAliasExisting || p.isInvalidAlias || p.isMaxAliasReached) {
      const reason = p.isAliasExisting
        ? "already_exists"
        : p.isInvalidAlias
          ? "invalid"
          : "max_aliases";
      log.warn(`API rejected: ${reason}`);
      return { ok: false, reason };
    }
  }
  if (
    apiResult.data?.c === 400 &&
    apiResult.data?.p === 400 &&
    typeof apiResult.data?.m === "string"
  ) {
    const m = apiResult.data.m.toLowerCase();
    if (m.includes("alias in use"))
      return { ok: false, reason: "already_exists" };
    if (m.includes("is invalid")) return { ok: false, reason: "invalid" };
    if (m.includes("blacklisted")) return { ok: false, reason: "blacklisted" };
  }
  if (apiResult.data?.c === "LIMIT-MULTI-ALIAS") {
    log.warn("API rejected: max aliases reached (LIMIT-MULTI-ALIAS)");
    return { ok: false, reason: "max_aliases" };
  }
  if (apiResult.status === 401 || apiResult.status === 403) {
    log.warn("Token expired → invalidating cache, fallback UI");
    _cachedStkn = null;
    return addSingleAliasUI(page, aliasLocal, domain);
  }

  // 500 / network error → báo lên để aliasBatch round-robin
  if (apiResult.status === 500) {
    return { ok: false, reason: "api_500" };
  }
  return { ok: false, reason: "api_network_error" };
}

// ── Fallback: add alias via UI (prüfen + Speichern) ──
async function addSingleAliasUI(page, aliasLocal, domain = "t-online.de") {
  log.info(`Adding alias via UI: ${aliasLocal}@${domain}`);

  const opened = await page.evaluate(() => {
    const link = document.querySelector(".add-alias-address-link-header");
    if (!link) return false;
    link.click();
    return true;
  });

  if (!opened) {
    log.warn("Cannot find 'Neue E-Mail-Adresse anlegen' link");
    return { ok: false, reason: "no_button" };
  }

  try {
    await page.waitForFunction(
      () => {
        const h1s = document.querySelectorAll("h1.screenreader");
        return Array.from(h1s).some(
          (h) => h.textContent.trim() === "Neue E-Mail-Adresse",
        );
      },
      { timeout: 10000 },
    );
    log.ok("Add-alias dialog opened");
  } catch {
    log.warn("Add-alias dialog did not open");
    return { ok: false, reason: "dialog_failed" };
  }
  await delay(1000);

  const inputSelector =
    'scale-text-field#emailAddress input[name="emailAddress"]';
  try {
    await page.waitForSelector(inputSelector, {
      visible: true,
      timeout: 8000,
    });
  } catch {
    log.warn("Email input not visible, trying anyway");
  }

  // Clear input bằng Ctrl+A → Backspace (web component ko clear bằng value="")
  await page.click(inputSelector).catch(() => {});
  await delay(200);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await delay(100);
  await page.keyboard.press("Backspace");
  await delay(200);

  // Double-check clear bằng JS
  await page.evaluate((sel) => {
    const inp = document.querySelector(sel);
    if (inp) {
      inp.value = "";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, inputSelector);
  await delay(200);

  for (const ch of aliasLocal) {
    await page.keyboard.type(ch, {
      delay: 60 + Math.floor(Math.random() * 60),
    });
  }
  await page.evaluate((sel) => {
    const inp = document.querySelector(sel);
    if (inp) {
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, inputSelector);
  await delay(400);

  // ── Chọn domain trong dropdown nếu không phải t-online.de ──
  if (domain !== "t-online.de") {
    const domainSet = await page.evaluate((targetDomain) => {
      // T-Online dùng scale-select hoặc select thường
      const scaleSelect = document.querySelector(
        'scale-select[name="domain"], scale-select[id*="domain"]',
      );
      if (scaleSelect) {
        const inner =
          scaleSelect.shadowRoot?.querySelector("select") ||
          scaleSelect.querySelector("select");
        if (inner) {
          inner.value = targetDomain;
          inner.dispatchEvent(new Event("change", { bubbles: true }));
          return "scale-select";
        }
      }
      const sel = document.querySelector(
        'select[name="domain"], select[id*="domain"], #emailDomain',
      );
      if (sel) {
        sel.value = targetDomain;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return "select";
      }
      return null;
    }, domain);

    if (domainSet) {
      log.info(`Domain dropdown set to ${domain} via ${domainSet}`);
    } else {
      log.warn(
        `Could not find domain dropdown — will try anyway with ${domain}`,
      );
    }
    await delay(400);
  }

  await delay(400);

  // ── Helper: detect & dismiss "Fehler" error modal ──
  async function dismissFehlerModal() {
    const hasFehler = await page
      .evaluate(() => {
        const modals = document.querySelectorAll("scale-modal[opened]");
        for (const modal of modals) {
          const dlg = modal.querySelector(".errorDialog");
          if (!dlg) continue;
          const text = dlg.innerText || "";
          if (/Fehler|ein Fehler aufgetreten/i.test(text)) return true;
        }
        const dlg = document.querySelector(".errorDialog");
        if (!dlg || dlg.offsetWidth === 0) return false;
        const text = dlg.innerText || "";
        return /Fehler|ein Fehler aufgetreten/i.test(text);
      })
      .catch(() => false);

    if (!hasFehler) return false;

    const okSelector =
      '.errorDialog scale-button[data-iid="middle-dialogbutton"]';
    try {
      await page.click(okSelector);
      log.info("Clicked OK on Fehler modal (page.click)");
    } catch {
      try {
        await page.click(".errorDialog #closeBtn");
        log.info("Clicked closeBtn on Fehler modal");
      } catch {
        await page
          .evaluate(() => {
            const dlg = document.querySelector(".errorDialog");
            if (!dlg) return;
            const ok = dlg.querySelector(
              'scale-button[data-iid="middle-dialogbutton"]',
            );
            if (ok) {
              ok.click();
              return;
            }
            const close = dlg.querySelector("#closeBtn");
            if (close) close.click();
          })
          .catch(() => {});
        log.info("Clicked Fehler modal via evaluate fallback");
      }
    }
    await delay(1000);
    return true;
  }

  // ── Spam-click "prüfen" tới khi Speichern sáng ──
  const MAX_CHECK_CLICKS = 5;
  const CHECK_CLICK_DELAY = 1200;
  let validationResult = "unknown";

  for (let clickAttempt = 1; clickAttempt <= MAX_CHECK_CLICKS; clickAttempt++) {
    const btnSelector =
      'button.mediumBtn[data-l_mouse_cl="Newalias::checkEmailAddress"]';
    const btnExists = await page.$(btnSelector);

    if (!btnExists) {
      if (clickAttempt === 1) {
        log.warn("Cannot find 'E-Mail-Adresse prüfen' button");
        await closeAliasDialog(page);
        return { ok: false, reason: "no_check_button" };
      }
      break;
    }

    try {
      await page.click(btnSelector);
    } catch (e) {
      await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (btn) btn.click();
      }, btnSelector);
    }

    log.info(`Clicked 'prüfen' (${clickAttempt}/${MAX_CHECK_CLICKS})`);
    await delay(CHECK_CLICK_DELAY);

    const hasFehler = await dismissFehlerModal();
    if (hasFehler) {
      log.warn(`"Fehler" modal after prüfen click ${clickAttempt} — dismissed`);
      await delay(1000);
      await closeAliasDialog(page);
      return { ok: false, reason: "fehler" };
    }

    const speichernState = await page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll("scale-button"));
        const save = btns.find(
          (b) => b.getAttribute("label") === "Speichern" && b.offsetParent,
        );
        if (!save) return "no_btn";
        const cls = save.className || "";
        return cls.includes("disabled") ? "disabled" : "enabled";
      })
      .catch(() => "error");

    if (speichernState === "enabled") {
      log.ok(`Speichern enabled after ${clickAttempt} click(s)`);
      validationResult = "valid";
      break;
    }

    if (clickAttempt >= 3) {
      const hasError = await page
        .evaluate(() => {
          const errorIcon = document.querySelector(
            "#emailAddressValidationSuccessIconContainer .execution_done_negative",
          );
          if (errorIcon && errorIcon.offsetParent !== null) return true;
          const dlg = document.querySelector(
            ".prefs-inboxsettings-address-addalias-dialog",
          );
          if (!dlg) return false;
          const text = dlg.innerText || "";
          return /bereits|schon vergeben|nicht verfügbar|ungültig|already|invalid|taken/i.test(
            text,
          );
        })
        .catch(() => false);

      if (hasError) {
        log.warn(`Email invalid/taken detected after ${clickAttempt} clicks`);
        validationResult = "invalid";
        break;
      }
    }
  }

  if (validationResult === "unknown") {
    log.info("Max clicks reached — waiting 5s for final API response...");
    await delay(5000);

    const hasFehlerFinal = await dismissFehlerModal();
    if (hasFehlerFinal) {
      log.warn(`"Fehler" modal after final wait — dismissed`);
      await closeAliasDialog(page);
      return { ok: false, reason: "fehler" };
    }

    const finalState = await page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll("scale-button"));
        const save = btns.find(
          (b) => b.getAttribute("label") === "Speichern" && b.offsetParent,
        );
        if (!save) return "no_btn";
        const cls = save.className || "";
        return cls.includes("disabled") ? "disabled" : "enabled";
      })
      .catch(() => "error");

    if (finalState === "enabled") {
      log.ok("Speichern enabled after final wait");
      validationResult = "valid";
    } else {
      log.warn(
        `Speichern still ${finalState} after ${MAX_CHECK_CLICKS} clicks`,
      );
      validationResult = "timeout";
    }
  }

  log.info(`Validation result: ${validationResult}`);

  if (validationResult !== "valid" && validationResult !== "valid_no_btn") {
    const errorText = await page
      .evaluate(() => {
        const dlg = document.querySelector(
          ".prefs-inboxsettings-address-addalias-dialog",
        );
        if (!dlg) return "";
        const text = dlg.innerText || "";
        const errMatches = text.match(
          /(bereits|schon vergeben|nicht verfügbar|ungültig|already|invalid|taken)/gi,
        );
        return errMatches ? errMatches.join(", ") : text.substring(0, 200);
      })
      .catch(() => "");
    if (errorText) {
      log.warn(`Dialog text: ${errorText.substring(0, 150)}`);
    }
    log.warn(`Alias '${aliasLocal}' invalid (${validationResult})`);
    await closeAliasDialog(page);
    return { ok: false, reason: validationResult };
  }

  // ── Click Speichern ──
  await delay(500);
  const saveClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("scale-button"));
    const save = btns.find(
      (b) =>
        b.getAttribute("label") === "Speichern" &&
        b.getAttribute("data-iid") === "right-dialogbutton" &&
        !b.className.includes("disabled"),
    );
    if (!save) return false;
    save.click();
    const inner = save.shadowRoot?.querySelector("button");
    if (inner) inner.click();
    return true;
  });

  if (!saveClicked) {
    log.warn("Cannot click Speichern");
    await closeAliasDialog(page);
    return { ok: false, reason: "save_click_failed" };
  }
  log.ok("Clicked Speichern");

  await delay(2000);
  const fehlerAfterSave = await dismissFehlerModal();
  if (fehlerAfterSave) {
    log.warn(`"Fehler" modal after Speichern — dismissed`);
    await closeAliasDialog(page);
    return { ok: false, reason: "fehler" };
  }

  try {
    await page.waitForFunction(
      () => {
        const h1s = Array.from(document.querySelectorAll("h1.screenreader"));
        const hasAddDialog = h1s.some((h) => {
          if (h.textContent.trim() !== "Neue E-Mail-Adresse") return false;
          const dlg = h.closest(".masterdialog");
          return dlg && dlg.offsetParent !== null;
        });
        return !hasAddDialog;
      },
      { timeout: 10000 },
    );
    log.ok(`Alias added: ${aliasLocal}@${domain}`);
  } catch {
    log.warn("Add dialog did not close — assuming success");
  }
  await delay(1500);
  return { ok: true };
}

async function closeAliasDialog(page) {
  await page
    .evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll(".masterdialog"));
      for (const d of dialogs) {
        const h1 = d.querySelector("h1.screenreader");
        if (h1 && h1.textContent.trim() === "Neue E-Mail-Adresse") {
          const closeBtn = d.querySelector("#closeBtn");
          if (closeBtn) {
            closeBtn.click();
            return;
          }
          const cancel = Array.from(d.querySelectorAll("scale-button")).find(
            (b) => b.getAttribute("label") === "Abbrechen",
          );
          cancel?.click();
        }
      }
    })
    .catch(() => {});
  await delay(1000);
}

// ════════════════════════════════════════════════════════════════════
// ★ ALIAS BATCH — throw AliasRateLimitError nếu fail liên tiếp >= 5
// ════════════════════════════════════════════════════════════════════
async function aliasBatch(page, pool, target = MAX_ALIASES_PER_ACCOUNT) {
  log.divider(`ALIAS BATCH — target ${target}`);

  const existing = await listCurrentAliases(page);
  log.info(`Currently ${existing.length} alias(es) on account`);

  const slotsAvailable = Math.max(0, MAX_ALIASES_PER_ACCOUNT - existing.length);
  const wanted = Math.min(target, slotsAvailable);
  if (wanted <= 0) {
    log.warn("No alias slots available");
    return { added: [], pool, stopReason: "no_slots" };
  }
  log.info(
    `Will try to add up to ${wanted} alias(es) (pool: ${pool.length}, rate-limit threshold: ${RATE_LIMIT_THRESHOLD})`,
  );

  const added = [];
  let attempts = 0;
  let consecutiveFails = 0;
  const existingLocals = new Set(existing.map((e) => e.local.toLowerCase()));
  const skipLocals = new Set();
  const fehlerRetries = new Map(); // local → số lần gặp Fehler modal
  const MAX_FEHLER_RETRIES = 3; // max retry cho mỗi mail gặp Fehler
  const apiRetries = new Map(); // local → số lần bị api_500/api_network_error
  const MAX_API_ROUND_RETRIES = 5; // max vòng round-robin trước khi fallback UI
  let stopReason = "target_reached";

  while (added.length < wanted && pool.length > 0) {
    attempts++;
    const candidate = pool.shift();
    const local = localPart(candidate).toLowerCase();
    const candidateDomain = candidate.includes("@")
      ? candidate.split("@")[1].toLowerCase()
      : "t-online.de";
    if (!local) {
      log.warn(`Skip empty candidate at attempt ${attempts}`);
      continue;
    }
    if (existingLocals.has(local) || skipLocals.has(local)) {
      log.warn(`Skip duplicate/invalid: ${local}`);
      continue;
    }

    log.info(
      `[Alias attempt ${attempts}] ${candidate} (added: ${added.length}/${wanted}, fails: ${consecutiveFails}/${RATE_LIMIT_THRESHOLD})`,
    );

    let result;
    try {
      result = await addSingleAlias(page, local, candidateDomain);
    } catch (e) {
      log.err(`Add alias error: ${e.message}`);
      result = { ok: false, reason: "exception" };
    }

    if (result.ok) {
      added.push(buildAlias(local, candidateDomain));
      existingLocals.add(local);
      consecutiveFails = 0;
      fehlerRetries.delete(local); // clear nếu có
      log.ok(
        `✅ Added (${added.length}/${wanted}): ${local}@${candidateDomain}`,
      );
    } else if (result.reason === "fehler") {
      // ── Fehler modal: reload page + vào lại alias + retry mail này ──
      const retryCount = (fehlerRetries.get(local) || 0) + 1;
      fehlerRetries.set(local, retryCount);

      if (retryCount >= MAX_FEHLER_RETRIES) {
        log.warn(
          `❌ ${local} — Fehler ${retryCount}/${MAX_FEHLER_RETRIES} times → skipping`,
        );
        skipLocals.add(local);
        consecutiveFails++;
      } else {
        log.info(
          `⚠️ ${local} — Fehler (${retryCount}/${MAX_FEHLER_RETRIES}) → reload + retry`,
        );
        // Push mail lại đầu pool để thử lại
        pool.unshift(candidate);

        // Reload page + vào lại alias section
        try {
          await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
          log.info("Page reloaded");
          await delay(2000);
          await gotoAliasPage(page);
          log.info("Back on alias page");
        } catch (reloadErr) {
          log.warn(`Reload/navigate failed: ${reloadErr.message}`);
          try {
            await gotoAliasPage(page);
          } catch {}
        }
        // Không tăng consecutiveFails — fehler là lỗi server, không phải mail invalid
      }

      // Check nếu fail liên tiếp quá threshold
      if (consecutiveFails >= RATE_LIMIT_THRESHOLD) {
        log.err(
          `❌ ${consecutiveFails} consecutive fails — main account likely rate-limited or blocked`,
        );
        log.info(`Returning ${added.length} alias đã add để runner xử lý`);
        return { added, pool, stopReason: "rate_limited" };
      }
    } else if (
      result.reason === "api_500" ||
      result.reason === "api_network_error"
    ) {
      // Round-robin: đẩy alias xuống cuối pool, thử alias khác trước
      const retryCount = (apiRetries.get(local) || 0) + 1;
      apiRetries.set(local, retryCount);
      if (retryCount < MAX_API_ROUND_RETRIES) {
        log.warn(
          `⚠️  ${local} api_500 (${retryCount}/${MAX_API_ROUND_RETRIES}) → đẩy xuống cuối, thử alias khác trước`,
        );
        pool.push(candidate); // đẩy xuống cuối queue
        // Không tăng consecutiveFails, không thêm vào skipLocals
      } else {
        // Đã thử đủ vòng → fallback UI
        log.warn(`⚠️  ${local} api_500 x${retryCount} → fallback UI`);
        let uiResult;
        try {
          uiResult = await addSingleAliasUI(page, local, candidateDomain);
        } catch (e) {
          uiResult = { ok: false, reason: "exception" };
        }
        if (uiResult.ok) {
          added.push(buildAlias(local, candidateDomain));
          existingLocals.add(local);
          consecutiveFails = 0;
          apiRetries.delete(local);
          log.ok(
            `✅ Added via UI fallback (${added.length}/${wanted}): ${local}@${candidateDomain}`,
          );
        } else {
          skipLocals.add(local);
          consecutiveFails++;
          log.warn(
            `❌ UI fallback cũng fail: ${local} (${uiResult.reason}) — consecutive fails: ${consecutiveFails}/${RATE_LIMIT_THRESHOLD}`,
          );
        }
      }
    } else {
      skipLocals.add(local);
      consecutiveFails++;
      log.warn(
        `❌ Skipped: ${local} (${result.reason}) — consecutive fails: ${consecutiveFails}/${RATE_LIMIT_THRESHOLD}`,
      );

      try {
        const stillOnAliasPage = await page
          .evaluate(
            () => !!document.querySelector("#additionalaliasesNormalContainer"),
          )
          .catch(() => false);
        if (!stillOnAliasPage) {
          log.info("Not on alias page anymore — re-navigating");
          await gotoAliasPage(page);
        }
      } catch {}

      // ★ Nếu fail liên tiếp đạt threshold → return để runner đổi main
      if (consecutiveFails >= RATE_LIMIT_THRESHOLD) {
        log.err(
          `❌ ${consecutiveFails} consecutive fails — main account likely rate-limited or blocked`,
        );
        log.info(`Returning ${added.length} alias đã add để runner xử lý`);
        return {
          added,
          pool,
          stopReason: "rate_limited",
        };
      }
    }

    await delay(1500);
  }

  if (added.length >= wanted) {
    stopReason = "target_reached";
  } else if (pool.length === 0) {
    stopReason = "pool_empty";
  }

  log.ok(
    `Alias batch done: ${added.length}/${wanted} added (${attempts} attempts, stop: ${stopReason})`,
  );

  return { added, pool, stopReason };
}

// ════════════════════════════════════════════════════════════════════
// DELETE ALIAS
// ════════════════════════════════════════════════════════════════════
async function deleteSingleAlias(page, aliasLocal) {
  log.info(`Deleting alias: ${aliasLocal}`);

  const clicked = await page.evaluate((alias) => {
    const link = document.querySelector(
      `a.action-delete[data-alias="${alias}"]`,
    );
    if (!link) return false;
    link.click();
    return true;
  }, aliasLocal);

  if (!clicked) {
    log.warn(`Delete link not found for ${aliasLocal}`);
    return { ok: false, reason: "not_found" };
  }
  await delay(1200);

  try {
    await page.waitForSelector(
      ".prefs-inboxsettings-address-deletealias-dialog",
      { timeout: 7000 },
    );
  } catch {
    log.warn("First delete-confirm dialog did not appear");
    await closeAllDialogs(page);
    return { ok: false, reason: "no_confirm_dialog" };
  }
  await delay(600);

  const confirmed = await page.evaluate(() => {
    const dlg = document.querySelector(
      ".prefs-inboxsettings-address-deletealias-dialog",
    );
    if (!dlg) return false;
    const btn = dlg.querySelector(
      'scale-button[data-iid="right-dialogbutton"]',
    );
    if (!btn) return false;
    btn.click();
    const inner = btn.shadowRoot?.querySelector("button");
    if (inner) inner.click();
    return true;
  });

  if (!confirmed) {
    log.warn("Cannot click Löschen in dialog 1");
    await closeAllDialogs(page);
    return { ok: false, reason: "confirm_click_failed" };
  }
  log.info("Clicked Löschen in dialog 1");
  await delay(1200);

  let hasDialog2 = false;
  try {
    await page.waitForSelector(".lockAliasDialog", { timeout: 7000 });
    hasDialog2 = true;
  } catch {
    log.info("No second confirmation dialog");
  }

  if (hasDialog2) {
    await delay(600);

    const jaClicked = await page.evaluate(() => {
      const dlg = document.querySelector(".lockAliasDialog");
      if (!dlg) return false;
      const btn =
        dlg.querySelector('scale-button[aria-label="Ja"]') ||
        dlg.querySelector('scale-button[data-iid="right-dialogbutton"]');
      if (!btn) return false;
      btn.click();
      const inner = btn.shadowRoot?.querySelector("button");
      if (inner) inner.click();
      return true;
    });

    if (!jaClicked) {
      log.warn("Cannot click 'Ja' in dialog 2");
      await closeAllDialogs(page);
      return { ok: false, reason: "ja_click_failed" };
    }
    log.info("Clicked Ja in dialog 2");
    await delay(800);
  }

  await delay(2000);
  log.ok(`Deleted: ${aliasLocal}@t-online.de`);
  return { ok: true };
}

async function closeAllDialogs(page) {
  await page
    .evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll(".masterdialog"));
      for (const d of dialogs) {
        if (d.offsetParent === null) continue;
        const closeBtn = d.querySelector("#closeBtn");
        if (closeBtn && closeBtn.offsetParent !== null) {
          closeBtn.click();
          continue;
        }
        const abbrechen = Array.from(d.querySelectorAll("scale-button")).find(
          (b) => b.getAttribute("label") === "Abbrechen",
        );
        if (abbrechen) {
          abbrechen.click();
          continue;
        }
      }
    })
    .catch(() => {});
  await delay(800);
}

async function deleteAliases(page, aliasLocals, mainEmail) {
  log.divider(`DELETE ALIASES — ${aliasLocals.length} item(s)`);

  // ★ Filter ra mail chính TRƯỚC khi xóa — xóa nhầm là bay tài khoản
  const mainLower = (mainEmail || "").trim().toLowerCase();
  const mainLocalLower = mainLower.split("@")[0];

  const safeList = [];
  let skippedMain = 0;
  for (const raw of aliasLocals) {
    const local = localPart(raw).toLowerCase();
    const fullLower = raw.toLowerCase();
    if (mainLower && (fullLower === mainLower || local === mainLocalLower)) {
      log.warn(`⛔ SKIP MAIN khi delete: ${raw} (mail chính, không xóa)`);
      skippedMain++;
      continue;
    }
    safeList.push(raw);
  }

  if (skippedMain > 0) {
    log.info(`Bỏ ${skippedMain} mail chính khỏi danh sách xóa`);
  }

  if (safeList.length === 0) {
    log.info("Nothing to delete");
    return { deleted: [], failed: [], skippedMain };
  }

  await gotoAliasPage(page);

  const results = { deleted: [], failed: [], skippedMain };

  // Pass 1: xóa tuần tự, KHÔNG reload giữa các lần — page cập nhật AJAX
  for (let i = 0; i < safeList.length; i++) {
    const local = localPart(safeList[i]);
    if (!local) continue;

    log.info(`[Delete ${i + 1}/${safeList.length}] ${local}`);
    const r = await deleteSingleAlias(page, local);
    if (r.ok) {
      results.deleted.push(local);
    } else {
      results.failed.push({ local, reason: r.reason });
    }
    await delay(800);
  }

  // Pass 2: reload 1 lần để verify, retry những cái còn sót
  log.info("Verifying deletions (1 reload)...");
  await gotoAliasPage(page);

  const remaining = await listCurrentAliases(page);
  const targetSet = new Set(safeList.map((e) => localPart(e).toLowerCase()));
  const stillExist = remaining.filter((a) => {
    const l = (a.local || "").toLowerCase();
    return targetSet.has(l) && l !== mainLocalLower;
  });

  if (stillExist.length > 0) {
    log.warn(`${stillExist.length} alias(es) still exist — retrying`);
    let noConfirmCount = 0;
    for (const alias of stillExist) {
      const r = await deleteSingleAlias(page, alias.local);
      if (r.ok) {
        results.deleted.push(alias.local);
        results.failed = results.failed.filter((f) => f.local !== alias.local);
      } else {
        log.warn(`Retry delete failed: ${alias.local} (${r.reason})`);
        if (r.reason === "no_confirm_dialog") noConfirmCount++;
      }
      await delay(800);
    }

    // Nếu >= 2 alias liên tiếp bị no_confirm_dialog → T-Online yêu cầu 2FA → block
    if (noConfirmCount >= 2) {
      log.warn(
        `🔐 ${noConfirmCount} lần no_confirm_dialog → T-Online yêu cầu 2FA, đổi acc`,
      );
      results.twoFactorBlocked = true;
    }
  }

  // Cũng kiểm tra pass 1 nếu không có pass 2
  if (!results.twoFactorBlocked) {
    const noConfirmPass1 = results.failed.filter(
      (f) => f.reason === "no_confirm_dialog",
    ).length;
    if (noConfirmPass1 >= 2) {
      log.warn(
        `🔐 ${noConfirmPass1} lần no_confirm_dialog (pass 1) → T-Online yêu cầu 2FA, đổi acc`,
      );
      results.twoFactorBlocked = true;
    }
  }

  log.ok(
    `Delete done: ${results.deleted.length} deleted, ${results.failed.length} failed, ${skippedMain} skipped main`,
  );
  return results;
}

module.exports = {
  loginTOnline,
  gotoAliasPage,
  listCurrentAliases,
  reconcileAliases,
  aliasBatch,
  addSingleAlias,
  addSingleAliasUI,
  deleteAliases,
  deleteSingleAlias,
  closeAllDialogs,
  dismissTOnlineCookieNotice,
  get2FAToken,
  localPart,
  buildAlias,
  AliasRateLimitError,
  MAX_ALIASES_PER_ACCOUNT,
  RATE_LIMIT_THRESHOLD,
};
