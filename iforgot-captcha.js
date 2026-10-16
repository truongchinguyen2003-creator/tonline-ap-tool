"use strict";

const { delay, randomDelay, log, generateRandomPassword } = require("./utils");
const readline = require("readline");

const MAX_CAPTCHA_RETRIES = 7;

// CapSolver + 2Captcha config — set từ runner qua initCapsolver()
let capsolverEnabled = false;
let capsolverApiKey = "";
let twoCaptchaEnabled = false;
let twoCaptchaApiKey = "";

function initCapsolver(config) {
  // CapSolver
  const cap = config?.CAPSOLVER || {};
  capsolverEnabled = cap.enabled === true;
  capsolverApiKey = cap.apiKey || "";
  if (capsolverEnabled && capsolverApiKey) {
    log.ok(`CapSolver ON (key: ${capsolverApiKey.slice(0, 8)}...)`);
  }

  // 2Captcha
  const tc = config?.TWOCAPTCHA || {};
  twoCaptchaEnabled = tc.enabled === true;
  twoCaptchaApiKey = tc.apiKey || "";
  if (twoCaptchaEnabled && twoCaptchaApiKey) {
    log.ok(`2Captcha ON (key: ${twoCaptchaApiKey.slice(0, 8)}...)`);
  }

  if (!capsolverEnabled && !twoCaptchaEnabled) {
    log.warn("No CAPTCHA solver configured → manual mode");
  }
}

// ════════════════════════════════════════════════════════════════════
// MANUAL INPUT
// ════════════════════════════════════════════════════════════════════
function askManual(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ════════════════════════════════════════════════════════════════════
// 2CAPTCHA
// ════════════════════════════════════════════════════════════════════
const TWOCAPTCHA_FATAL_ERRORS = new Set([
  "ERROR_WRONG_USER_KEY",
  "ERROR_KEY_DOES_NOT_EXIST",
  "ERROR_ZERO_BALANCE",
  "ERROR_IP_NOT_ALLOWED",
]);

async function solve2Captcha(base64Image) {
  // Submit task
  const body = new URLSearchParams({
    key: twoCaptchaApiKey,
    method: "base64",
    body: base64Image,
    json: "1",
  });
  const submitRes = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const submitData = await submitRes.json();
  if (submitData.status !== 1) {
    const err = new Error(`2Captcha submit: ${submitData.request}`);
    if (TWOCAPTCHA_FATAL_ERRORS.has(submitData.request)) err.fatal = true;
    throw err;
  }

  const taskId = submitData.request;

  // Poll result
  for (let i = 0; i < 24; i++) {
    await delay(3000);
    const res = await fetch(
      `https://2captcha.com/res.php?key=${twoCaptchaApiKey}&action=get&id=${taskId}&json=1`,
    );
    const data = await res.json();
    if (data.status === 1) return data.request; // solved text
    if (data.request === "ERROR_CAPTCHA_UNSOLVABLE") {
      throw new Error("2Captcha: unsolvable");
    }
    if (TWOCAPTCHA_FATAL_ERRORS.has(data.request)) {
      const err = new Error(`2Captcha fatal: ${data.request}`);
      err.fatal = true;
      throw err;
    }
    // CAPCHA_NOT_READY → keep polling
  }
  throw new Error("2Captcha timeout");
}

// ════════════════════════════════════════════════════════════════════
// CAPSOLVER
// ════════════════════════════════════════════════════════════════════
async function solveCaptcha(base64Image) {
  const res = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: capsolverApiKey,
      task: {
        type: "ImageToTextTask",
        body: base64Image,
        websiteURL: "https://iforgot.apple.com",
        case: true,
        module: "common",
      },
    }),
  });
  const data = await res.json();
  if (data.errorId !== 0) {
    throw new Error(`CapSolver error: ${data.errorDescription}`);
  }
  if (data.solution?.text) return data.solution.text;

  const taskId = data.taskId;
  for (let i = 0; i < 20; i++) {
    await delay(3000);
    const r = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: capsolverApiKey, taskId }),
    });
    const rd = await r.json();
    if (rd.status === "ready") return rd.solution.text;
    if (rd.status === "failed")
      throw new Error(`CapSolver failed: ${rd.errorDescription}`);
  }
  throw new Error("CapSolver timeout");
}

// ════════════════════════════════════════════════════════════════════
// HELPER: trích xuất hint email từ trang "email sent"
// Ví dụ: "k•••••@o•••••.eu" từ <label class="semi-bold">
// ════════════════════════════════════════════════════════════════════
async function extractHintEmail(page) {
  try {
    return await page.evaluate(() => {
      // Trường hợp chính: <p class="description"> chứa <label class="semi-bold">
      const label =
        document.querySelector("p.description label.semi-bold") ||
        document.querySelector("p.description label") ||
        document.querySelector(".description .semi-bold");
      if (label && label.textContent.trim()) return label.textContent.trim();

      // Fallback: tìm chuỗi có dạng x•••@y•••.zz trong toàn bộ trang
      const bodyText = document.body?.innerText || "";
      const m = bodyText.match(
        /[A-Za-z0-9][A-Za-z0-9•*\-_]*@[A-Za-z0-9][A-Za-z0-9•*\-_]*\.[A-Za-z•*]{2,}/,
      );
      if (m) return m[0];
      return null;
    });
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════
// STEP 1: iforgot CAPTCHA → send reset email
// ════════════════════════════════════════════════════════════════════
async function submitAppleForgot(page, email) {
  log.divider(`Apple iForgot: ${email}`);

  // Load page với retry khi 503 hoặc navigation fail (timeout / network error)
  const IFORGOT_URL =
    "https://iforgot.apple.com/password/verify/appleid?language=US-EN";
  for (let loadAttempt = 1; loadAttempt <= 3; loadAttempt++) {
    let navOk = false;
    try {
      await page.goto(IFORGOT_URL, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      navOk = true;
    } catch (e) {
      log.warn(
        `Navigation failed (attempt ${loadAttempt}/3): ${e.message.slice(0, 80)}`,
      );
    }
    await delay(2000);

    const bodyText = await page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "");

    const is503 =
      bodyText.includes("503") ||
      bodyText.includes("Service Temporarily Unavailable") ||
      bodyText.includes("Service Unavailable");

    if (is503) {
      log.warn(`503 Service Unavailable (attempt ${loadAttempt}/3)`);
    } else if (navOk) {
      // Page loaded OK — tiếp tục
      break;
    } else {
      // Navigation error — không load được
      log.warn(`Page not loaded (attempt ${loadAttempt}/3)`);
    }

    if (loadAttempt >= 3) {
      log.warn("3 load attempts failed → relaunch browser");
      return { ok: false, reason: "503_need_relaunch" };
    }

    // Clear cookies + cache rồi retry
    try {
      const client = await page.target().createCDPSession();
      await client.send("Network.clearBrowserCookies");
      await client.send("Network.clearBrowserCache");
    } catch {}
    await page.goto("about:blank", { timeout: 5000 }).catch(() => {});
    await delay(8000);
  }

  // Enter email
  log.info("Entering email...");
  const emailInput = await page.waitForSelector("input.iforgot-apple-id", {
    timeout: 15000,
  });
  await emailInput.click();
  await delay(500);
  await page.evaluate((val) => {
    const inp = document.querySelector("input.iforgot-apple-id");
    if (inp) {
      inp.focus();
      inp.value = val;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      inp.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }, email);
  await delay(1000);
  // Verify value
  const filledEmail = await page.evaluate(() => {
    const inp = document.querySelector("input.iforgot-apple-id");
    return inp ? inp.value : "";
  });
  log.info(`Email filled: "${filledEmail}"`);

  // CAPTCHA retry loop
  let consecutiveNoImage = 0;
  for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
    log.info(`[CAPTCHA attempt ${attempt}/${MAX_CAPTCHA_RETRIES}]`);

    // Nếu retry → reload toàn bộ page + nhập lại email
    if (attempt > 1) {
      log.info("Reloading page + re-entering email...");
      let reloadOk = false;
      for (let reloadTry = 1; reloadTry <= 3; reloadTry++) {
        try {
          await page.goto(IFORGOT_URL, {
            waitUntil: "networkidle2",
            timeout: 30000,
          });
          reloadOk = true;
          break;
        } catch (e) {
          log.warn(`Reload failed (${reloadTry}/3): ${e.message.slice(0, 60)}`);
          try {
            const client = await page.target().createCDPSession();
            await client.send("Network.clearBrowserCookies");
            await client.send("Network.clearBrowserCache");
          } catch {}
          await page.goto("about:blank", { timeout: 5000 }).catch(() => {});
          await delay(5000);
        }
      }
      if (!reloadOk) {
        log.warn("Reload failed 3 times → relaunch browser");
        return { ok: false, reason: "503_need_relaunch" };
      }
      await delay(2000);

      // Check 503
      const is503 = await page
        .evaluate(() => {
          const body = document.body?.innerText || "";
          return body.includes("503") || body.includes("Service Unavailable");
        })
        .catch(() => false);
      if (is503) {
        log.warn("503 on reload");
        return { ok: false, reason: "503_need_relaunch" };
      }

      // Nhập lại email
      const retryInput = await page
        .waitForSelector("input.iforgot-apple-id", { timeout: 10000 })
        .catch(() => null);
      if (!retryInput) {
        log.warn("Email input not found after reload");
        continue;
      }
      await retryInput.click();
      await delay(300);
      await page.evaluate((val) => {
        const inp = document.querySelector("input.iforgot-apple-id");
        if (inp) {
          inp.focus();
          inp.value = val;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true }));
        }
      }, email);
      await delay(1000);
    }

    // Wait for CAPTCHA image
    const captchaImg = await page
      .waitForSelector(
        "img[alt='Image challenge'], img[alt='Type the characters you see or hear']",
        { timeout: 10000 },
      )
      .catch(() => null);

    if (!captchaImg) {
      consecutiveNoImage++;
      log.warn(`CAPTCHA image not found (${consecutiveNoImage} consecutive)`);
      if (consecutiveNoImage >= 2 || attempt >= MAX_CAPTCHA_RETRIES) {
        log.warn("CAPTCHA image not found 2 lần liên tiếp → relaunch browser");
        return { ok: false, reason: "captcha_no_image_relaunch" };
      }
      continue;
    }
    consecutiveNoImage = 0; // reset khi tìm thấy image
    await delay(1500);

    // Screenshot CAPTCHA — gửi ảnh gốc (chỉ scale 2x, giữ nguyên màu)
    // CapSolver AI được train trên ảnh gốc → giữ nguyên cho accuracy tốt nhất
    const base64 = await page
      .evaluate(() => {
        const img = document.querySelector(
          "img[alt='Image challenge'], img[alt='Type the characters you see or hear']",
        );
        if (!img) return null;

        const canvas = document.createElement("canvas");
        const scale = 2;
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext("2d");

        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        return canvas.toDataURL("image/png").split(",")[1];
      })
      .catch(() => null);

    if (!base64) {
      log.warn("Failed to capture CAPTCHA image");
      if (attempt >= MAX_CAPTCHA_RETRIES)
        return { ok: false, reason: "captcha_process_fail" };
      continue;
    }
    log.info(
      `CAPTCHA captured: ${base64.length} chars (2x scaled, original colors)`,
    );

    // Solve CAPTCHA
    let captchaText;

    if (capsolverEnabled && capsolverApiKey) {
      // ── CapSolver ──
      try {
        captchaText = await solveCaptcha(base64);
      } catch (err) {
        log.warn(`CapSolver error: ${err.message}`);
        if (
          err.message.includes("invalid") ||
          err.message.includes("insufficient") ||
          err.message.includes("balance")
        ) {
          log.err("CapSolver API key invalid or balance empty — stopping");
          return { ok: false, reason: "capsolver_fatal" };
        }
        if (attempt >= MAX_CAPTCHA_RETRIES)
          return { ok: false, reason: "capsolver_fail" };
        continue;
      }
    } else if (twoCaptchaEnabled && twoCaptchaApiKey) {
      // ── 2Captcha ──
      try {
        captchaText = await solve2Captcha(base64);
      } catch (err) {
        log.warn(`2Captcha error: ${err.message}`);
        if (err.fatal) {
          log.err(`2Captcha fatal (${err.message}) — stopping`);
          return { ok: false, reason: "capsolver_fatal" };
        }
        if (attempt >= MAX_CAPTCHA_RETRIES)
          return { ok: false, reason: "twocaptcha_fail" };
        continue;
      }
    } else {
      // ── Manual mode ──
      captchaText = await askManual("⌨️  Nhập CAPTCHA: ");
      if (!captchaText) {
        if (attempt >= MAX_CAPTCHA_RETRIES)
          return { ok: false, reason: "manual_empty" };
        continue;
      }
    }
    log.ok(`CAPTCHA result: "${captchaText}"`);

    // Enter CAPTCHA
    const captchaInput = await page.waitForSelector("input.captcha-input", {
      timeout: 10000,
    });
    await captchaInput.click();
    await delay(300);
    await page.evaluate((val) => {
      const inp = document.querySelector("input.captcha-input");
      if (inp) {
        inp.focus();
        inp.value = val;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    }, captchaText);
    await delay(500);
    log.info(`CAPTCHA filled: "${captchaText}"`);

    // Click Continue
    log.info("Clicking Continue...");
    await page.evaluate(() => {
      const btn = document.querySelector("button.button-primary.nav-action");
      if (btn) btn.click();
    });

    // Chờ page chuyển — poll tối đa 15s
    log.info("Waiting for page transition...");
    let transitioned = false;
    for (let w = 0; w < 15; w++) {
      await delay(1000);
      const stillCaptcha = await page
        .evaluate(() => {
          return !!document.querySelector("input.captcha-input");
        })
        .catch(() => false);

      if (!stillCaptcha) {
        transitioned = true;
        log.ok("Page transitioned from CAPTCHA");
        break;
      }

      // Check nếu có error message trong khi chờ
      const err = await page
        .evaluate(() => {
          const el = document.querySelector(".form-message");
          return el ? el.textContent.trim() : "";
        })
        .catch(() => "");

      if (
        err.includes("characters") ||
        err.includes("enter the characters") ||
        err.includes("Please type")
      ) {
        log.warn(`CAPTCHA wrong: "${err}" — will reload page`);
        break; // break inner wait loop → outer loop sẽ reload page + nhập lại email
      }

      // "Your request could not be completed" → cũng break, outer loop reload
      if (
        err.includes("could not be completed") ||
        err.includes("Try again later")
      ) {
        log.warn(`Server error: "${err}" — will reload page`);
        break;
      }

      // "not valid or not supported" → fail ngay, không retry CAPTCHA
      if (err.includes("not valid") || err.includes("not supported")) {
        log.err(`Account not valid (form-message): "${err}"`);
        return { ok: false, reason: "account_not_valid" };
      }
    }

    if (!transitioned) {
      // Check body text cho "not valid" trước khi retry — tránh retry vô ích
      const bodyNotValid = await page
        .evaluate(() => document.body?.innerText || "")
        .catch(() => "");
      if (
        bodyNotValid.includes("not valid") ||
        bodyNotValid.includes("not supported")
      ) {
        log.err("Account not valid (detected from body during CAPTCHA)");
        return { ok: false, reason: "account_not_valid" };
      }
      // Vẫn còn trên trang CAPTCHA → CAPTCHA sai hoặc chưa chuyển
      if (attempt < MAX_CAPTCHA_RETRIES) continue;
      return { ok: false, reason: "captcha_wrong_or_stuck" };
    }

    // ── Page đã chuyển — detect trang mới ──
    await delay(2000); // chờ thêm cho page render xong

    // Helper: đọc subtitle hiện tại (check cả p.subtitle và span title)
    const getSubtitle = () =>
      page
        .evaluate(() => {
          const p = document.querySelector("p.subtitle");
          if (p && p.textContent.trim()) return p.textContent.trim();
          // Fallback: check span với class chứa "step-title"
          const span = document.querySelector(
            "span[class*='step-title'], span[id*='step-title']",
          );
          if (span && span.textContent.trim()) return span.textContent.trim();
          // Fallback: check h1
          const h1 = document.querySelector("h1");
          if (h1 && h1.textContent.trim()) return h1.textContent.trim();
          return "";
        })
        .catch(() => "");

    // Helper: click Continue/action button
    const clickContinue = () =>
      page.evaluate(() => {
        const btn =
          document.querySelector("button#action") ||
          document.querySelector("button.button-primary.nav-action") ||
          document.querySelector("button:not([disabled]).button-primary");
        if (btn) btn.click();
      });

    let subtitle = await getSubtitle();
    log.info(`Page subtitle: "${subtitle}"`);

    // Check "Apple Account is not valid or not supported" → fail ngay
    if (
      subtitle.toLowerCase().includes("not valid") ||
      subtitle.toLowerCase().includes("not supported")
    ) {
      log.err(`Account not valid: "${subtitle}"`);
      return { ok: false, reason: "account_not_valid" };
    }

    // Check "This account is locked" → fail ngay
    if (
      subtitle.toLowerCase().includes("account is locked") ||
      subtitle.toLowerCase().includes("locked")
    ) {
      log.err(`Account locked: "${subtitle}"`);
      return { ok: false, reason: "account_locked" };
    }

    // Check "Confirm your birthday" → fail ngay
    if (
      subtitle.toLowerCase().includes("confirm your birthday") ||
      subtitle.toLowerCase().includes("birthday")
    ) {
      log.err(`Birthday required: "${subtitle}"`);
      return { ok: false, reason: "birthday_required" };
    }

    // Check phone number required → fail ngay
    if (
      subtitle.toLowerCase().includes("phone number") ||
      subtitle.toLowerCase().includes("verify your identity") ||
      subtitle.toLowerCase().includes("trusted phone")
    ) {
      log.err(`Phone number required: "${subtitle}"`);
      return { ok: false, reason: "phone_number_required" };
    }

    // Check "Select what information you want to reset" → bấm Continue
    if (
      subtitle.toLowerCase().includes("select what information") ||
      subtitle.toLowerCase().includes("what you want to reset")
    ) {
      log.ok("'Select what information' page → clicking Continue...");
      await delay(1000);
      await clickContinue();
      // Chờ chuyển sang trang tiếp
      for (let w = 0; w < 15; w++) {
        await delay(1000);
        subtitle = await getSubtitle();
        if (!subtitle.toLowerCase().includes("select what information")) break;
      }
      log.info(`After select info → subtitle: "${subtitle}"`);
    }

    // Check "Choose how to unlock" page
    const hasUnlock =
      subtitle.toLowerCase().includes("unlock") ||
      subtitle.toLowerCase().includes("choose") ||
      subtitle.toLowerCase().includes("how you want");

    if (hasUnlock) {
      log.ok("CAPTCHA correct → unlock method page");
      await delay(1000);

      // Chọn radio "Get an email" nếu có (tránh chọn nhầm phone)
      await page.evaluate(() => {
        const radios = Array.from(
          document.querySelectorAll("input[type='radio'], [role='radio']"),
        );
        for (const r of radios) {
          const label = (
            r.labels?.[0]?.textContent ||
            r.getAttribute("aria-label") ||
            r.closest("label")?.textContent ||
            ""
          ).toLowerCase();
          if (label.includes("email") || label.includes("e-mail")) {
            r.click();
            return;
          }
        }
        // Fallback: click label text chứa "email"
        const labels = Array.from(document.querySelectorAll("label"));
        for (const l of labels) {
          if ((l.textContent || "").toLowerCase().includes("email")) {
            l.click();
            return;
          }
        }
      });
      await delay(800);

      // Click Continue
      log.info("Clicking Continue on unlock page...");
      await page.evaluate(() => {
        const btn =
          document.querySelector("button#action") ||
          document.querySelector("button:not([disabled]).button-primary");
        if (btn) btn.click();
      });

      // Chờ trang "Email Sent" load — poll tối đa 20s
      log.info("Waiting for Email Sent page...");
      let emailSentConfirmed = false;
      for (let w = 0; w < 20; w++) {
        await delay(1000);
        const st = await page
          .evaluate(() => {
            const p = document.querySelector("p.subtitle");
            return p
              ? p.textContent.trim()
              : document.body?.innerText?.slice(0, 200) || "";
          })
          .catch(() => "");

        if (
          st.includes("Email Sent") ||
          st.includes("email has been sent") ||
          st.includes("check your email") ||
          st.includes("We sent")
        ) {
          log.ok("Reset email sent successfully");
          emailSentConfirmed = true;
          const hintEmail = await extractHintEmail(page);
          if (hintEmail) log.info(`Recovery hint: ${hintEmail}`);
          return { ok: true, hintEmail };
        }

        // Vẫn còn trên unlock page → click Continue lần nữa
        const stillUnlock = await page
          .evaluate(() => {
            const p = document.querySelector("p.subtitle");
            const txt = (p?.textContent || "").toLowerCase();
            return (
              txt.includes("unlock") ||
              txt.includes("choose") ||
              txt.includes("how you want") ||
              txt.includes("select how")
            );
          })
          .catch(() => false);

        if (stillUnlock && w >= 2) {
          log.warn(`Still on unlock page (w=${w}) — clicking Continue again`);
          await page.evaluate(() => {
            const btn =
              document.querySelector("button#action") ||
              document.querySelector("button:not([disabled]).button-primary");
            if (btn) btn.click();
          });
        }
      }

      if (!emailSentConfirmed) {
        // Check body text lần cuối
        const bodyText = await page
          .evaluate(() => document.body?.innerText || "")
          .catch(() => "");
        if (
          bodyText.includes("Email Sent") ||
          bodyText.includes("email has been sent") ||
          bodyText.includes("We sent") ||
          bodyText.includes("reset")
        ) {
          log.ok("Reset email sent (detected from body)");
          const hintEmail2 = await extractHintEmail(page);
          if (hintEmail2) log.info(`Recovery hint: ${hintEmail2}`);
          return { ok: true, hintEmail: hintEmail2 };
        }
        log.warn(
          "Unlock page: Email Sent not confirmed after 20s — assuming sent",
        );
      }
      const hintEmailFallback = await extractHintEmail(page);
      if (hintEmailFallback) log.info(`Recovery hint: ${hintEmailFallback}`);
      return { ok: true, hintEmail: hintEmailFallback };
    }

    // Check "Email has been sent" trực tiếp (không qua unlock page)
    const pageText = await page
      .evaluate(() => {
        const p = document.querySelector("p.subtitle");
        return p ? p.textContent : "";
      })
      .catch(() => "");

    if (
      pageText.includes("Email Sent") ||
      pageText.includes("email has been sent") ||
      pageText.includes("Unlock")
    ) {
      log.ok("Reset email sent successfully");
      const hintEmailDirect = await extractHintEmail(page);
      if (hintEmailDirect) log.info(`Recovery hint: ${hintEmailDirect}`);
      return { ok: true, hintEmail: hintEmailDirect };
    }

    log.warn("Unknown page after clicking Continue");
    // Log actual page content for debugging
    const debugSubtitle = subtitle || "(no subtitle)";
    log.info(`Current subtitle: "${debugSubtitle}"`);

    // Check body text cho locked / not valid trước khi retry
    const bodyCheck = await page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "");
    if (
      bodyCheck.includes("account is locked") ||
      bodyCheck.includes("locked")
    ) {
      log.err("Account is locked (detected from body)");
      return { ok: false, reason: "account_locked" };
    }
    if (
      bodyCheck.includes("not valid") ||
      bodyCheck.includes("not supported")
    ) {
      log.err("Account not valid (detected from body)");
      return { ok: false, reason: "account_not_valid" };
    }

    if (attempt >= MAX_CAPTCHA_RETRIES) {
      return { ok: false, reason: "unknown_page" };
    }
  }

  return { ok: false, reason: "max_retries" };
}

async function refreshCaptcha(page) {
  try {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      for (const b of btns) {
        const txt = (b.textContent || "").trim().toLowerCase();
        if (
          txt.includes("new code") ||
          txt.includes("new captcha") ||
          txt.includes("refresh")
        ) {
          b.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) log.info("Refreshed CAPTCHA");
  } catch {}
  await delay(2000);
}

// ════════════════════════════════════════════════════════════════════
// STEP 2: Open reset link → change password
// ════════════════════════════════════════════════════════════════════
async function resetPasswordFromLink(page, resetLink) {
  log.divider("Apple Reset Password");
  log.info(`Opening: ${resetLink.slice(0, 80)}...`);

  // Retry goto 3 lần — SSL/network error thường do proxy hiccup
  let navOk = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(resetLink, { waitUntil: "networkidle2", timeout: 30000 });
      navOk = true;
      break;
    } catch (e) {
      log.warn(
        `Reset link load failed (${attempt}/3): ${e.message.slice(0, 80)}`,
      );
      if (attempt >= 3) break;
      try {
        const client = await page.target().createCDPSession();
        await client.send("Network.clearBrowserCookies");
        await client.send("Network.clearBrowserCache");
      } catch {}
      await page.goto("about:blank", { timeout: 5000 }).catch(() => {});
      await delay(5000);
    }
  }

  if (!navOk) {
    return { ok: false, reason: "reset_link_load_failed" };
  }

  await delay(3000);

  // Detect current page
  const pageState = await page.evaluate(() => {
    const subtitle = document.querySelector("p.subtitle");
    const text = subtitle ? subtitle.textContent.trim() : "";
    if (text.includes("Enter Password")) return "enter_password";
    if (text.includes("New Apple") && text.includes("Password"))
      return "new_password";
    return "unknown:" + text.slice(0, 60);
  });

  log.info(`Page state: ${pageState}`);

  // CASE 1: "Enter Password" → click "Forgot password?"
  if (pageState === "enter_password") {
    log.info("Case 1: Enter Password → clicking Forgot password...");

    // Click thật bằng Puppeteer (isTrusted=true)
    const forgotBtn = await page
      .waitForSelector("button.forgot-pwd, .forgot-pwd, a.forgot-pwd", {
        timeout: 10000,
      })
      .catch(() => null);
    if (!forgotBtn) {
      // Fallback: tìm bằng text
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"));
        for (const b of btns) {
          if (
            (b.textContent || "")
              .trim()
              .toLowerCase()
              .includes("forgot password")
          ) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) return { ok: false, reason: "forgot_pwd_btn_not_found" };
      log.info("Clicked via text fallback");
    } else {
      await forgotBtn.click();
      log.ok("Clicked Forgot password button");
    }

    // Poll tối đa 20s chờ trang "New Apple Account Password"
    log.info("Waiting for New Password page...");
    let hasNewPwd = false;
    for (let w = 0; w < 20; w++) {
      await delay(1000);
      hasNewPwd = await page
        .evaluate(() => {
          const subtitle = document.querySelector("p.subtitle");
          return subtitle
            ? subtitle.textContent.includes("New Apple") ||
                subtitle.textContent.includes("New Password")
            : false;
        })
        .catch(() => false);
      if (hasNewPwd) break;
    }

    if (!hasNewPwd) {
      return { ok: false, reason: "new_password_page_not_appeared" };
    }
    log.ok("Navigated to New Password page");
  }
  // CASE 2: Directly "New Apple Account Password"
  else if (pageState === "new_password") {
    log.ok("Case 2: Direct New Password page");
  } else {
    log.warn(`Unknown page state: ${pageState}`);
    return { ok: false, reason: `unknown_page: ${pageState}` };
  }

  // Fill + submit password — retry tối đa 3 lần nếu bị "Too many consecutive"
  const MAX_PWD_RETRY = 3;
  let finalPassword = null;

  for (let pwdAttempt = 1; pwdAttempt <= MAX_PWD_RETRY; pwdAttempt++) {
    const newPassword = generateRandomPassword(18);
    log.info(`Generated password (lần ${pwdAttempt}): ${newPassword}`);
    await delay(800);

    // Fill password field 1
    const pwd1 = await page
      .waitForSelector("input#password, input.pwd", { timeout: 10000 })
      .catch(() => null);
    if (!pwd1) return { ok: false, reason: "password_field_1_not_found" };
    await pwd1.click({ clickCount: 3 });
    await pwd1.type(newPassword, { delay: 50 });
    await delay(400);

    // Fill password field 2 (confirm)
    const pwd2Selector = await page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input[type="password"]'),
      );
      if (inputs.length >= 2) {
        const second = inputs[1];
        return second.id ? `#${second.id}` : null;
      }
      return null;
    });

    if (pwd2Selector) {
      const pwd2 = await page.$(pwd2Selector);
      if (pwd2) {
        await pwd2.click({ clickCount: 3 });
        await pwd2.type(newPassword, { delay: 50 });
      }
    } else {
      const filled = await page.evaluate((pw) => {
        const inputs = Array.from(
          document.querySelectorAll('input[type="password"]'),
        );
        if (inputs.length >= 2) {
          const inp = inputs[1];
          inp.focus();
          inp.value = pw;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }, newPassword);
      if (!filled) {
        return { ok: false, reason: "password_field_2_not_found" };
      }
    }

    await delay(800);

    // Kiểm tra lỗi validation "Too many consecutive" trước khi submit
    const validationErr = await page
      .evaluate(() => {
        const body = document.body.innerText || "";
        return (
          body.toLowerCase().includes("too many consecutive") ||
          body.toLowerCase().includes("consecutive identical")
        );
      })
      .catch(() => false);

    if (validationErr) {
      log.warn(
        `⚠️ Password validation error (lần ${pwdAttempt}): "Too many consecutive identical characters" → gen lại`,
      );
      // Clear fields bằng JS để chắc
      await page.evaluate(() => {
        document.querySelectorAll('input[type="password"]').forEach((inp) => {
          inp.focus();
          inp.value = "";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });
      await delay(500);
      continue; // gen password mới
    }

    // Click "Reset Password"
    log.info("Clicking Reset Password...");
    await page.evaluate(() => {
      const btn =
        document.querySelector("button#action") ||
        document.querySelector("button.button-primary:not([disabled])");
      if (btn) btn.click();
    });
    await delay(5000);

    // Check success
    const success = await page
      .evaluate(() => {
        const subtitle = document.querySelector("p.subtitle");
        const text = subtitle ? subtitle.textContent.trim() : "";
        return text.includes("Unlocked") || text.includes("Password Changed");
      })
      .catch(() => false);

    if (success) {
      log.ok(`Password changed successfully! New: ${newPassword}`);
      return { ok: true, newPassword };
    }

    // Kiểm tra lỗi consecutive sau khi submit (Apple validate server-side)
    const postSubmitErr = await page
      .evaluate(() => {
        const body = document.body.innerText || "";
        return (
          body.toLowerCase().includes("too many consecutive") ||
          body.toLowerCase().includes("consecutive identical")
        );
      })
      .catch(() => false);

    if (postSubmitErr) {
      log.warn(
        `⚠️ Post-submit validation error (lần ${pwdAttempt}): "Too many consecutive" → gen lại`,
      );
      await page.evaluate(() => {
        document.querySelectorAll('input[type="password"]').forEach((inp) => {
          inp.focus();
          inp.value = "";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });
      await delay(500);
      continue;
    }

    // Retry click nếu button bị disabled
    log.warn("Success page not detected, retrying click...");
    await page.evaluate(() => {
      const btn = document.querySelector("button#action");
      if (btn) {
        btn.removeAttribute("disabled");
        btn.click();
      }
    });
    await delay(5000);

    const success2 = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return text.includes("Unlocked") || text.includes("Password Changed");
      })
      .catch(() => false);

    if (success2) {
      log.ok(`Password changed successfully! New: ${newPassword}`);
      return { ok: true, newPassword };
    }

    // Không phải consecutive error và không success → dừng
    return { ok: false, reason: "reset_not_confirmed" };
  }

  return { ok: false, reason: "reset_not_confirmed_after_pwd_retry" };
}

module.exports = {
  initCapsolver,
  submitAppleForgot,
  resetPasswordFromLink,
  solveCaptcha,
};
