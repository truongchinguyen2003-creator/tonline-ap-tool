"use strict";

const Imap = require("imap");
const { simpleParser } = require("mailparser");
const { delay, log } = require("./utils");

function createImapClient(config) {
  function connectImap(email, passimap) {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: email,
        password: passimap,
        host: config.IMAP.host,
        port: config.IMAP.port,
        tls: config.IMAP.tls,
        tlsOptions: config.IMAP.tlsOptions,
        connTimeout: config.IMAP.connTimeout || 20000,
        authTimeout: config.IMAP.authTimeout || 15000,
      });
      imap.once("ready", () => resolve(imap));
      imap.once("error", reject);
      imap.connect();
    });
  }

  function fetchInboxMessages(imap, count = 50) {
    return new Promise((resolve, reject) => {
      imap.openBox("INBOX", true, (err, box) => {
        if (err) return reject(err);
        if (!box.messages.total) return resolve([]);

        const total = box.messages.total;
        const start = Math.max(1, total - (count - 1));
        const f = imap.seq.fetch(`${start}:${total}`, {
          bodies: "",
          struct: true,
        });

        const promises = [];
        f.on("message", (msg) => {
          promises.push(
            new Promise((res) => {
              let buf = "";
              msg.on("body", (stream) => {
                stream.on("data", (c) => (buf += c.toString("utf8")));
              });
              msg.once("end", async () => {
                try {
                  res(await simpleParser(buf));
                } catch {
                  res(null);
                }
              });
            }),
          );
        });
        f.once("error", reject);
        f.once("end", async () =>
          resolve((await Promise.all(promises)).filter(Boolean)),
        );
      });
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // Clear toàn bộ mail trong INBOX
  // ════════════════════════════════════════════════════════════════════
  async function clearInbox(email, passimap) {
    log.mail(`Clearing inbox for ${email}...`);
    let imap = null;
    try {
      imap = await connectImap(email, passimap);

      const box = await new Promise((resolve, reject) => {
        imap.openBox("INBOX", false, (err, box) => {
          if (err) return reject(err);
          resolve(box);
        });
      });

      const total = box.messages.total;
      if (total === 0) {
        log.ok(`Inbox already empty`);
        imap.end();
        return { ok: true, deleted: 0 };
      }

      log.mail(`Found ${total} email(s) — deleting all...`);

      await new Promise((resolve, reject) => {
        imap.seq.addFlags(`1:${total}`, ["\\Deleted"], (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      await new Promise((resolve, reject) => {
        imap.expunge((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      log.ok(`Cleared ${total} email(s) from inbox`);
      imap.end();
      return { ok: true, deleted: total };
    } catch (err) {
      log.warn(`Clear inbox failed: ${err.message}`);
      if (imap)
        try {
          imap.destroy();
        } catch {}
      return { ok: false, error: err.message };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // findInMail — mỗi attempt có timeout riêng 25s
  // Nếu proxy bị ngắt mid-fetch, timeout sẽ kill IMAP và không treo
  // ════════════════════════════════════════════════════════════════════
  const ATTEMPT_TIMEOUT_MS = 60000; // 60s per attempt

  async function findInMail(searchFn, label) {
    const { MAX_RETRIES, RETRY_DELAY } = config.MAIL_RETRY;
    const searchStart = new Date();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log.mail(`${label} attempt ${attempt}/${MAX_RETRIES}`);
      let imap = null;

      try {
        const result = await Promise.race([
          // Main IMAP operation
          (async () => {
            imap = await connectImap(searchFn._email, searchFn._passimap);
            const messages = await fetchInboxMessages(imap);
            log.mail(`Found ${messages.length} emails`);
            const bufferTime = new Date(searchStart.getTime() - 30000);
            const found = searchFn(messages, bufferTime);
            imap.end();
            return found;
          })(),
          // Hard timeout — kill nếu proxy ngắt mid-fetch
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `IMAP attempt timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s`,
                  ),
                ), // 60s
              ATTEMPT_TIMEOUT_MS,
            ),
          ),
        ]);

        if (result) return result;
        log.warn(`Nothing matched yet (${label})`);
      } catch (err) {
        log.warn(`IMAP error: ${err.message}`);
        if (imap)
          try {
            imap.destroy();
          } catch {}
      }

      if (attempt < MAX_RETRIES) {
        log.info(`Wait ${RETRY_DELAY / 1000}s...`);
        await delay(RETRY_DELAY);
      }
    }
    throw new Error(`${label}: not found after ${MAX_RETRIES} retries`);
  }

  // ════════════════════════════════════════════════════════════════════
  // Apple Reset Link
  // ════════════════════════════════════════════════════════════════════
  async function getAppleResetLink(mainEmail, passimap) {
    log.mail(`Getting Apple reset link from ${config.IMAP.host}: ${mainEmail}`);

    const fn = (messages, bufferTime) => {
      const candidates = [];
      for (const m of messages) {
        if (!m) continue;
        const fromText = (m.from?.text || "").toLowerCase();
        const subject = (m.subject || "").toLowerCase();

        const isFromApple =
          fromText.includes("apple") ||
          fromText.includes("appleid") ||
          subject.includes("apple") ||
          subject.includes("reset your password") ||
          subject.includes("unlock");

        if (!isFromApple) continue;

        const date = new Date(m.date);
        if (date < bufferTime) continue;

        const content = (m.text || "") + " " + (m.html || "");

        const linkMatch = content.match(
          /https?:\/\/iforgot\.apple\.com\/verify\/email\?[^\s\]\)"<>']+/i,
        );

        if (linkMatch) {
          candidates.push({
            date,
            link: linkMatch[0],
            subject: m.subject,
          });
        }
      }

      candidates.sort((a, b) => b.date - a.date);
      if (candidates.length === 0) return null;
      log.ok(`Found Apple reset link (subject: ${candidates[0].subject})`);
      return { resetLink: candidates[0].link };
    };

    fn._email = mainEmail;
    fn._passimap = passimap;

    return findInMail(fn, "apple-reset-link");
  }

  return { getAppleResetLink, clearInbox };
}

module.exports = { createImapClient };
