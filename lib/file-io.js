"use strict";

const fs = require("fs").promises;
const path = require("path");
const { log } = require("./utils");

/**
 * Ghi file an toàn: write → tmp → rename (atomic trên Linux).
 * Khi mất điện giữa chừng: hoặc file cũ còn nguyên, hoặc file mới hoàn chỉnh.
 */
async function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  // Mở file handle để fsync được (writeFile không expose fd)
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(content, "utf-8");
    await fh.sync(); // flush data xuống disk trước khi rename
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

function createFileIO(config) {
  function getDonePath() {
    if (config.PATHS.MAIN_ACCOUNTS_DONE) return config.PATHS.MAIN_ACCOUNTS_DONE;
    const main = config.PATHS.MAIN_ACCOUNTS;
    const dir = path.dirname(main);
    const base = path.basename(main, path.extname(main));
    return path.join(dir, `${base}_done${path.extname(main)}`);
  }

  async function readMainAccounts() {
    const content = await fs.readFile(config.PATHS.MAIN_ACCOUNTS, "utf-8");
    const accounts = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("|"))
      .map((l) => {
        const [email = "", password = "", totp = "", passimap = ""] =
          l.split("|");
        return {
          email: email.trim(),
          password: password.trim(),
          totp: totp.trim(),
          passimap: passimap.trim(),
        };
      })
      .filter((a) => a.email && a.password);

    log.info(`Loaded ${accounts.length} main account(s)`);
    return accounts;
  }

  async function moveMainAccountToDone(mainEmail) {
    const mainPath = config.PATHS.MAIN_ACCOUNTS;
    const donePath = getDonePath();
    let lines = [];
    try {
      const content = await fs.readFile(mainPath, "utf-8");
      lines = content.split("\n");
    } catch {
      return;
    }

    const lowerEmail = mainEmail.trim().toLowerCase();
    const movedLines = [];
    const remainingLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        remainingLines.push(line);
        continue;
      }
      const firstCol = trimmed.split("|")[0]?.trim().toLowerCase();
      if (firstCol === lowerEmail) {
        movedLines.push(trimmed);
      } else {
        remainingLines.push(line);
      }
    }

    if (movedLines.length === 0) return;

    const doneEntry =
      movedLines
        .map((l) => `${l}|done_at=${new Date().toISOString()}`)
        .join("\n") + "\n";
    await fs.appendFile(donePath, doneEntry, "utf-8");
    await atomicWrite(mainPath, remainingLines.join("\n"));
    log.ok(`Moved main ${mainEmail} → ${donePath}`);
  }

  // Thay vì move sang done, chuyển acc xuống cuối main_accounts để chạy lại liên tục
  async function recycleMainAccount(mainEmail) {
    const mainPath = config.PATHS.MAIN_ACCOUNTS;
    let lines = [];
    try {
      const content = await fs.readFile(mainPath, "utf-8");
      lines = content.split("\n");
    } catch {
      return;
    }

    const lowerEmail = mainEmail.trim().toLowerCase();
    const movedLines = [];
    const remainingLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        remainingLines.push(line);
        continue;
      }
      const firstCol = trimmed.split("|")[0]?.trim().toLowerCase();
      if (firstCol === lowerEmail) {
        movedLines.push(trimmed);
      } else {
        remainingLines.push(line);
      }
    }

    if (movedLines.length === 0) return;

    // Ghi lại file: bỏ acc ra khỏi vị trí cũ, append xuống cuối
    const withoutAcc = remainingLines.join("\n").replace(/\n+$/, "");
    const recycled = movedLines.join("\n");
    const newContent = withoutAcc
      ? `${withoutAcc}\n${recycled}\n`
      : `${recycled}\n`;
    await atomicWrite(mainPath, newContent);
    log.ok(`♻️  Recycled main ${mainEmail} → bottom of ${mainPath}`);
  }

  async function readWorkingEmailPool() {
    try {
      const content = await fs.readFile(config.PATHS.WORKING_EMAILS, "utf-8");
      const emails = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("@"));
      log.info(`Loaded ${emails.length} working email(s) from pool`);
      return emails;
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async function saveWorkingEmailPool(pool) {
    const content = pool.length > 0 ? pool.join("\n") + "\n" : "";
    await atomicWrite(config.PATHS.WORKING_EMAILS, content);
    log.info(`Saved pool: ${pool.length} email(s) remaining`);
  }

  // Xóa 1 email khỏi pool ngay lập tức
  async function removeFromPool(email) {
    try {
      const content = await fs.readFile(config.PATHS.WORKING_EMAILS, "utf-8");
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const filtered = lines.filter(
        (l) =>
          l.toLowerCase() !== email.trim().toLowerCase() && !l.startsWith("#"),
      );
      const comments = content
        .split("\n")
        .filter((l) => l.trim().startsWith("#"));
      const result = [...comments, ...filtered];
      await atomicWrite(config.PATHS.WORKING_EMAILS, result.join("\n") + "\n");
    } catch {}
  }

  // Email bị INTERNAL-ERROR → ghi vào retry để dễ quăng lại pool
  async function writeRetry(email, reason) {
    const retryPath =
      config.PATHS.OUTPUT_RETRY ||
      path.join(path.dirname(config.PATHS.OUTPUT_SUCCESS), "retry.txt");
    const line = `${email}\n`;
    await fs.appendFile(retryPath, line, "utf-8");
    log.warn(`↩️  Retry: ${email} (${reason})`);
  }

  // Output: mail|newPassword
  async function writeSuccess(email, newPassword) {
    const line = `${email}|${newPassword}\n`;
    await fs.appendFile(config.PATHS.OUTPUT_SUCCESS, line, "utf-8");
    await removeFromPending(email);
    log.ok(`✅ Saved success: ${email}`);
  }

  async function writeFailed(email, reason) {
    const cleanReason = (reason || "")
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const line = `${email}|${cleanReason}\n`;
    await fs.appendFile(config.PATHS.OUTPUT_FAILED, line, "utf-8");
    await removeFromPending(email);
    log.err(`Failed: ${email} - ${cleanReason}`);
  }

  // ─────────────────────────────────────────────
  // PENDING — mail đã alias nhưng chưa xử lý
  // ─────────────────────────────────────────────
  function getPendingPath() {
    return (
      config.PATHS.PENDING ||
      path.join(path.dirname(config.PATHS.OUTPUT_SUCCESS), "pending.txt")
    );
  }

  async function readPending() {
    try {
      const content = await fs.readFile(getPendingPath(), "utf-8");
      return content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async function addToPending(emails) {
    const list = Array.isArray(emails) ? emails : [emails];
    if (list.length === 0) return;
    const lines = list.join("\n") + "\n";
    await fs.appendFile(getPendingPath(), lines, "utf-8");
    log.info(`Added ${list.length} email(s) to pending`);
  }

  async function removeFromPending(email) {
    try {
      const content = await fs.readFile(getPendingPath(), "utf-8");
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const filtered = lines.filter(
        (l) => l.toLowerCase() !== email.trim().toLowerCase(),
      );
      await atomicWrite(
        getPendingPath(),
        filtered.length > 0 ? filtered.join("\n") + "\n" : "",
      );
    } catch {}
  }

  async function clearPending() {
    try {
      await atomicWrite(getPendingPath(), "");
    } catch {}
  }

  async function readSuccessEmails() {
    try {
      const content = await fs.readFile(config.PATHS.OUTPUT_SUCCESS, "utf-8");
      return new Set(
        content
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.split("|")[0]?.trim().toLowerCase())
          .filter(Boolean),
      );
    } catch {
      return new Set();
    }
  }

  return {
    readMainAccounts,
    moveMainAccountToDone,
    recycleMainAccount,
    readWorkingEmailPool,
    saveWorkingEmailPool,
    removeFromPool,
    writeSuccess,
    writeFailed,
    writeRetry,
    readSuccessEmails,
    readPending,
    addToPending,
    removeFromPending,
    clearPending,
  };
}

module.exports = { createFileIO };
