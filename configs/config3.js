const path = require("path");

module.exports = {
  PROXY: {
    enabled: false,
    mode: "http_static",
    file: "./proxies.txt",
    random: true,
    rotateOnFail: true,
    address: "127.0.0.1:60001",
  },
  APPLE_PROXY: {
    enabled: true,
    address: "43.230.9.47:1000:baodinh1tketamin-region-PL:baodinh1tmdma",
    sticky: false, // ← true = sticky | false = rotate
    stickyMinutes: 120, // ← thời gian giữ IP
  },
  TONLINE_PROXY: {
    enabled: true,
    address: "43.230.9.47:1000:baodinh1tketamin-region-FR:baodinh1tmdma",
    rotateRegion: false, // ← true = rotate region | false = keep region
  },
  BROWSER: {
    HEADLESS: false,
    WINDOW_SIZE: "640,720",
    WINDOW_POSITION: "0,0",
    TONLINE_WINDOW_SIZE: "640,720",
    TONLINE_WINDOW_POSITION: "0,720",
    IG_WINDOW_SIZE: "640,720",
    IG_WINDOW_POSITION: "640,720",
  },
  IMAP: {
    host: "secureimap.t-online.de",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 30000,
    connTimeout: 20000,
  },
  MAIL_RETRY: { MAX_RETRIES: 5, RETRY_DELAY: 5000 },
  TONLINE: { BATCH_SIZE: 10, CLEAN_BEFORE_BATCH: false },
  TOTP: { apiUrl: "https://2fa.live/tok" },
  CAPSOLVER: {
    enabled: true,
    apiKey:
      "CAP-1FF7B8AA38122C12E4A08F49F9586DDEF3CBF6D4CEB757E308F376891C8154B2",
  },
  TWOCAPTCHA: {
    enabled: false,
    apiKey: "70c2feeaabdfc45f038aba48c7568392",
  },
  PATHS: {
    MAIN_ACCOUNTS: path.join("data3", "main_accounts3.txt"),
    MAIN_ACCOUNTS_DONE: path.join("data3", "main_done3.txt"),
    WORKING_EMAILS: path.join("data3", "working_emails3.txt"),
    PENDING: path.join("data3", "pending3.txt"),
    OUTPUT_SUCCESS: path.join("data3", "thanhcong3.txt"),
    OUTPUT_FAILED: path.join("data3", "failed3.txt"),
    OUTPUT_RETRY: path.join("data3", "retry3.txt"),
  },
};
