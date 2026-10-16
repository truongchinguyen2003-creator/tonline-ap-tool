"use strict";

const puppeteer = require("puppeteer");
const { fileExistsSync, log, delay, randomDelay } = require("./utils");

// ════════════════════════════════════════════════════════════════════
// USER AGENTS
// ════════════════════════════════════════════════════════════════════
const DESKTOP_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

const getRandomDesktopUA = () =>
  DESKTOP_USER_AGENTS[Math.floor(Math.random() * DESKTOP_USER_AGENTS.length)];

// ════════════════════════════════════════════════════════════════════
// CHROME PATH AUTO-DETECT
// ════════════════════════════════════════════════════════════════════
function getChromiumPath() {
  const paths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return paths.find(fileExistsSync);
}

// ════════════════════════════════════════════════════════════════════
// LAUNCH BROWSER
// ════════════════════════════════════════════════════════════════════
/**
 * @param {Object}   config
 * @param {boolean}  useProxy
 * @param {string}   proxy          host:port:user:pass
 * @param {Object}   windowOverride { size, position }
 * @param {string[]} extensions     Array of absolute paths to unpacked extensions
 */
async function launchBrowser(
  config,
  useProxy,
  proxy,
  windowOverride = null,
  extensions = [],
) {
  const userAgent = getRandomDesktopUA();
  const args = buildLaunchArgs(
    config,
    userAgent,
    useProxy,
    proxy,
    windowOverride,
    extensions,
  );

  let proxyCredentials = null;
  if (useProxy && proxy) {
    const parts = proxy.split(":");
    if (parts.length === 4) {
      proxyCredentials = { username: parts[2], password: parts[3] };
    }
  }

  const browser = await puppeteer.launch({
    headless: config.BROWSER.HEADLESS,
    executablePath: getChromiumPath(),
    args,
    ignoreHTTPSErrors: true,
    protocolTimeout: 120000, // 2 phút — tránh lỗi "Runtime.callFunctionOn timed out"
    ignoreDefaultArgs: [
      "--enable-automation",
      "--enable-blink-features=IdleDetection",
      // Nếu load extension → cần bỏ disable-extensions khỏi default args
      ...(extensions.length > 0 ? ["--disable-extensions"] : []),
    ],
  });

  // Apply evasions + proxy auth lên mọi page
  browser.on("targetcreated", async (target) => {
    const page = await target.page();
    if (!page) return;
    if (proxyCredentials) {
      await page.authenticate(proxyCredentials).catch(() => {});
    }
    await applyEvasions(page, userAgent).catch(() => {});
  });

  // Force window position via CDP (--window-position arg đôi khi không apply)
  if (windowOverride) {
    try {
      const [w, h] = (windowOverride.size || "1280,800")
        .split(",")
        .map((n) => parseInt(n.trim(), 10));
      const [x, y] = (windowOverride.position || "0,0")
        .split(",")
        .map((n) => parseInt(n.trim(), 10));

      const pages = await browser.pages();
      const firstPage = pages[0] || (await browser.newPage());
      const session = await firstPage.target().createCDPSession();
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: x, top: y, width: w, height: h, windowState: "normal" },
      });
      await session.detach().catch(() => {});
      log.info(`Window @ ${x},${y} ${w}x${h}`);
    } catch (e) {
      log.warn(`Set window bounds failed: ${e.message}`);
    }
  }

  if (extensions.length > 0) {
    log.info(`Loaded ${extensions.length} extension(s)`);
  }

  return browser;
}

function buildLaunchArgs(
  config,
  userAgent,
  useProxy,
  proxy,
  windowOverride = null,
  extensions = [],
) {
  const windowSize = windowOverride?.size || config.BROWSER.WINDOW_SIZE;
  const windowPosition =
    windowOverride?.position || config.BROWSER.WINDOW_POSITION;
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-automation",
    "--exclude-switches=enable-automation",
    "--disable-infobars",
    `--user-agent=${userAgent}`,
    "--accept-lang=en-US,en;q=0.9",
    "--lang=en-US",
    "--ignore-certificate-errors",
    "--disable-features=IsolateOrigins,site-per-process,TranslateUI",
    "--disable-web-security",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",
    "--disable-hang-monitor",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    "--password-store=basic",
    "--use-mock-keychain",
    `--window-size=${windowSize}`,
    `--window-position=${windowPosition}`,
  ];

  if (useProxy && proxy) {
    const parts = proxy.split(":");
    args.push(`--proxy-server=${parts[0]}:${parts[1]}`);
  }

  // ── Extension loading ──────────────────────────────────────────────
  if (extensions.length > 0) {
    const paths = extensions.join(",");
    args.push(`--load-extension=${paths}`);
    args.push(`--disable-extensions-except=${paths}`);
  }

  return args;
}

// ════════════════════════════════════════════════════════════════════
// EVASIONS
// ════════════════════════════════════════════════════════════════════
async function applyEvasions(page, userAgent) {
  await page.evaluateOnNewDocument((ua) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
        {
          name: "Chrome PDF Viewer",
          filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
        },
        { name: "Native Client", filename: "internal-nacl-plugin" },
      ],
    });

    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    Object.defineProperty(navigator, "userAgent", { get: () => ua });

    if (!window.chrome) {
      window.chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {},
      };
    }

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
      params.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(params);

    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return "Intel Inc.";
      if (parameter === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, parameter);
    };

    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx = this.getContext("2d");
      if (ctx) {
        const noise = Math.floor(Math.random() * 10);
        ctx.fillStyle = `rgba(255,255,255,${noise / 255})`;
        ctx.fillRect(0, 0, 1, 1);
      }
      return toDataURL.apply(this, args);
    };

    if (window.AudioContext) {
      const orig = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function (...args) {
        const data = orig.apply(this, args);
        for (let i = 0; i < data.length; i += 1000) {
          data[i] = data[i] + (Math.random() - 0.5) * 1e-7;
        }
        return data;
      };
    }

    if (navigator.getBattery) {
      navigator.getBattery = () =>
        Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 1,
        });
    }
  }, userAgent);
}

// ════════════════════════════════════════════════════════════════════
// REQUEST INTERCEPTION
// ════════════════════════════════════════════════════════════════════
async function blockUnneededResources(page, opts = {}) {
  const blockTypes = opts.blockTypes ?? ["image", "media", "font"];
  await page.setRequestInterception(true);

  page.on("request", (req) => {
    if (blockTypes.includes(req.resourceType())) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

async function unblockResources(page) {
  await page.setRequestInterception(false);
}

// ════════════════════════════════════════════════════════════════════
// ★ IP CHECK — fix timeout: tăng lên 30s, fallback URLs, retry
// ════════════════════════════════════════════════════════════════════
const IP_CHECK_URLS = [
  "https://api.ipify.org?format=json",
  "https://api.myip.com",
  "https://ifconfig.me/ip",
  "https://ipinfo.io/ip",
];

async function checkCurrentIP(page, opts = {}) {
  const timeout = opts.timeout ?? 30000;
  const retries = opts.retries ?? 2;

  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const url of IP_CHECK_URLS) {
      try {
        log.info(`Checking IP via ${url} (attempt ${attempt}/${retries})...`);
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        const ip = await page.evaluate(() => {
          const text = document.body.textContent.trim();
          // Thử parse JSON trước
          try {
            const obj = JSON.parse(text);
            return obj.ip || obj.query || null;
          } catch {
            // Plain text — chỉ lấy nếu match IP pattern
            const m = text.match(
              /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-fA-F0-9:]+\b/,
            );
            return m ? m[0] : text.substring(0, 50);
          }
        });
        if (ip) {
          log.ip(`Current IP: ${ip}`);
          return ip;
        }
      } catch (e) {
        log.warn(`IP check via ${url} failed: ${e.message}`);
      }
    }
    if (attempt < retries) {
      log.warn(`All IP services failed, retry in 2s...`);
      await delay(2000);
    }
  }

  log.warn("All IP check attempts failed — proxy may be down");
  return null;
}

/**
 * Strict IP check — throw nếu fail (dùng để verify proxy trước khi vào flow lâu).
 */
async function ensureProxyAlive(page, opts = {}) {
  const ip = await checkCurrentIP(page, opts);
  if (!ip) {
    throw new Error("Proxy appears to be dead — cannot reach any IP service");
  }
  return ip;
}

// ════════════════════════════════════════════════════════════════════
// SAFE NAVIGATION
// ════════════════════════════════════════════════════════════════════
async function safeGoto(page, url, opts = {}) {
  const merged = { waitUntil: "domcontentloaded", timeout: 30000, ...opts };
  try {
    await page.goto(url, merged);
  } catch (e) {
    const ignorable =
      e.message.includes("ERR_ABORTED") ||
      e.message.includes("net::ERR_") ||
      e.message.includes("Navigation timeout");
    if (!ignorable) throw e;
    log.warn(`safeGoto ignored: ${e.message}`);
  }
  await delay(500);
}

async function clearBrowserData(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send("Network.clearBrowserCookies");
    await client.send("Network.clearBrowserCache");
    await client.send("Storage.clearDataForOrigin", {
      origin: "https://iforgot.apple.com",
      storageTypes: "all",
    });
    await client.send("Storage.clearDataForOrigin", {
      origin: "https://appleid.apple.com",
      storageTypes: "all",
    });
  } catch (e) {
    log.warn(`Clear data error: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// HUMAN INTERACTIONS
// ════════════════════════════════════════════════════════════════════
async function humanClick(page, x, y) {
  const offsetX = Math.floor(Math.random() * 100) - 50;
  const offsetY = Math.floor(Math.random() * 100) - 50;
  await page.mouse.move(x + offsetX, y + offsetY, { steps: 10 });
  await randomDelay(80, 200);
  await page.mouse.move(x, y, { steps: 8 });
  await randomDelay(100, 250);
  await page.mouse.down();
  await randomDelay(50, 120);
  await page.mouse.up();
}

async function humanType(page, selector, text, baseDelay = 50) {
  await page.click(selector);
  await randomDelay(150, 350);
  for (const char of text) {
    await page.keyboard.type(char, {
      delay: baseDelay + Math.floor(Math.random() * 80),
    });
  }
}

// ════════════════════════════════════════════════════════════════════
// LOGIN FORM DETECTOR
// ════════════════════════════════════════════════════════════════════
async function hasLoginForm(page) {
  return page
    .evaluate(() => {
      const selectors = [
        'input[name="email"]',
        'input[name="username"]',
        'input[aria-label="Phone number, username, or email"]',
        'input[name="pass"]',
        'input[name="password"]',
        'input[aria-label="Password"]',
        'input[type="password"]',
      ];
      return selectors.some((s) => !!document.querySelector(s));
    })
    .catch(() => false);
}

module.exports = {
  launchBrowser,
  applyEvasions,
  blockUnneededResources,
  unblockResources,
  checkCurrentIP,
  ensureProxyAlive,
  safeGoto,
  clearBrowserData,
  humanClick,
  humanType,
  hasLoginForm,
  getRandomDesktopUA,
  MOBILE_USER_AGENT,
};
