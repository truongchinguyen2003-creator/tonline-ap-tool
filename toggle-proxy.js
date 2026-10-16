"use strict";

/**
 * toggle-proxy.js
 * Dùng: node toggle-proxy.js [TARGET] [COUNTRY] [true|false]
 *
 *   TARGET: tonline | apple | all (mặc định: all)
 *
 *   vd:  node toggle-proxy.js all FR true     → bật cả 2 proxy, đổi nước FR
 *        node toggle-proxy.js tonline FR false → tắt T-Online proxy, đổi nước FR
 *        node toggle-proxy.js apple DE true    → bật Apple proxy, đổi nước DE
 *        node toggle-proxy.js apple sticky     → toggle sticky mode Apple proxy
 *        node toggle-proxy.js FR               → toggle enabled cả 2, đổi nước FR
 *        node toggle-proxy.js                  → toggle enabled cả 2, giữ nguyên nước
 */

const fs = require("fs");
const path = require("path");

const CONFIGS_DIR = path.join(process.cwd(), "configs");

// Parse args linh hoạt
const TARGETS = ["tonline", "apple", "all"];
const BOOLEANS = ["true", "false"];

let targetArg = "all";
let countryArg = "";
let enabledArg = undefined; // "true" | "false" | undefined
let stickyArg = undefined; // "sticky" keyword

const rawArgs = process.argv.slice(2).map((a) => a.trim());
for (const a of rawArgs) {
  if (TARGETS.includes(a.toLowerCase())) targetArg = a.toLowerCase();
  else if (BOOLEANS.includes(a.toLowerCase())) enabledArg = a.toLowerCase();
  else if (a.toLowerCase() === "sticky") stickyArg = true;
  else if (/^[A-Z]{2}$/i.test(a)) countryArg = a.toUpperCase();
}

if (!fs.existsSync(CONFIGS_DIR)) {
  console.error(`❌ Không tìm thấy thư mục: ${CONFIGS_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(CONFIGS_DIR)
  .filter((f) => /^config\d+\.js$/.test(f))
  .sort();

if (files.length === 0) {
  console.error("❌ Không có file config nào trong configs/");
  process.exit(1);
}

console.log(`📂 Tìm thấy ${files.length} config: ${files.join(", ")}`);
console.log(
  `🎯 Target: ${targetArg} | Nước: ${countryArg || "(giữ nguyên)"} | Enabled: ${enabledArg ?? "(toggle)"} | Sticky: ${stickyArg ? "toggle" : "(giữ nguyên)"}\n`,
);

// ── Helper: toggle 1 proxy block ──────────────────────────────────────────
function toggleProxyBlock(content, blockName, newEnabled, country) {
  // Regex khớp cả block kể cả có sticky field
  const blockRe = new RegExp(`(${blockName}:\\s*\\{)([^}]*)\\}`, "s");
  const blockMatch = content.match(blockRe);
  if (!blockMatch) return { content, changed: false, info: "not found" };

  let block = blockMatch[2];

  // Toggle enabled
  const curEnabled = block.match(/enabled:\s*(true|false)/)?.[1];
  if (curEnabled === undefined)
    return { content, changed: false, info: "no enabled field" };
  const nextEnabled =
    newEnabled !== undefined ? newEnabled : curEnabled !== "true";
  block = block.replace(/(enabled:\s*)(true|false)/, `$1${nextEnabled}`);

  // Đổi nước
  let countryResult = "";
  if (country) {
    const addrMatch = block.match(/address:\s*"([^"]*)"/);
    if (addrMatch) {
      const oldAddr = addrMatch[1];
      const newAddr = oldAddr.replace(
        /-region-[A-Z]{2}/i,
        `-region-${country}`,
      );
      if (newAddr !== oldAddr) {
        block = block.replace(/(address:\s*")([^"]*)/, `$1${newAddr}`);
        countryResult = country;
      } else {
        countryResult = "(không đổi — không tìm thấy -region-XX)";
      }
    }
  }

  const newContent = content.replace(blockRe, `$1${block}}`);
  const info =
    `enabled: ${curEnabled} → ${nextEnabled}` +
    (country ? ` | nước → ${countryResult || "?"}` : "");
  return { content: newContent, changed: true, info };
}

// ── Helper: toggle sticky mode cho APPLE_PROXY ────────────────────────────
function toggleStickyBlock(content) {
  const curSticky = content.match(
    /(APPLE_PROXY:\s*\{[^}]*sticky:\s*)(true|false)/s,
  )?.[2];
  if (!curSticky) return { content, info: "no sticky field" };
  const nextSticky = curSticky !== "true";
  const newContent = content.replace(
    /(APPLE_PROXY:\s*\{[^}]*sticky:\s*)(true|false)/s,
    `$1${nextSticky}`,
  );
  return { content: newContent, info: `sticky: ${curSticky} → ${nextSticky}` };
}

// ── Xử lý từng file ───────────────────────────────────────────────────────
for (const file of files) {
  const filePath = path.join(CONFIGS_DIR, file);
  let content = fs.readFileSync(filePath, "utf-8");
  const lines = [];

  const doTonline = targetArg === "all" || targetArg === "tonline";
  const doApple = targetArg === "all" || targetArg === "apple";

  if (doTonline) {
    const r = toggleProxyBlock(
      content,
      "TONLINE_PROXY",
      enabledArg === "true" ? true : enabledArg === "false" ? false : undefined,
      countryArg,
    );
    content = r.content;
    lines.push(`  T-Online: ${r.info}`);
  }

  if (doApple) {
    const r = toggleProxyBlock(
      content,
      "APPLE_PROXY",
      enabledArg === "true" ? true : enabledArg === "false" ? false : undefined,
      countryArg,
    );
    content = r.content;
    lines.push(`  Apple:    ${r.info}`);

    if (stickyArg) {
      const s = toggleStickyBlock(content);
      content = s.content;
      lines.push(`  Sticky:   ${s.info}`);
    }
  }

  fs.writeFileSync(filePath, content, "utf-8");
  console.log(`✅ ${file}:\n${lines.join("\n")}`);
}

console.log("\nDone.");
