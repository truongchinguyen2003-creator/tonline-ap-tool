"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const ask = (q) => new Promise((r) => rl.question(q, r));

// Màn 1: 2K (2560x1440) — 2x2 grid
// Màn 2: Full HD (1920x1080) — bắt đầu tại x=2560, 2x2 grid (2 cột × 2 hàng)
const LAYOUTS = {
  1: { ton: "0,0", apple: "640,0", monitor: "2K" },
  2: { ton: "1280,0", apple: "1920,0", monitor: "2K" },
  3: { ton: "0,720", apple: "640,720", monitor: "2K" },
  4: { ton: "1280,720", apple: "1920,720", monitor: "2K" },
  5: { ton: "2560,0", apple: "3200,0", monitor: "FHD" },
  6: { ton: "2560,540", apple: "3200,540", monitor: "FHD" },
  7: { ton: "3840,0", apple: "4480,0", monitor: "FHD" },
  8: { ton: "3840,540", apple: "4480,540", monitor: "FHD" },
};

function configContent(
  num,
  layout,
  appleProxy,
  tonlineProxy,
  capsolver,
  twoCaptcha,
) {
  return `const path = require("path");

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
    enabled: ${appleProxy ? "true" : "false"},
    address: "${appleProxy || ""}",
  },
  TONLINE_PROXY: {
    enabled: ${tonlineProxy ? "true" : "false"},
    address: "${tonlineProxy || ""}",
  },
  BROWSER: {
    HEADLESS: false,
    WINDOW_SIZE: "640,720",
    WINDOW_POSITION: "0,0",
    TONLINE_WINDOW_SIZE: "640,720",
    TONLINE_WINDOW_POSITION: "${layout.ton}",
    IG_WINDOW_SIZE: "640,720",
    IG_WINDOW_POSITION: "${layout.apple}",
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
    enabled: ${capsolver ? "true" : "false"},
    apiKey: "${capsolver || ""}",
  },
  TWOCAPTCHA: {
    enabled: ${twoCaptcha ? "true" : "false"},
    apiKey: "${twoCaptcha || ""}",
  },
  PATHS: {
    MAIN_ACCOUNTS:      path.join("data${num}", "main_accounts${num}.txt"),
    MAIN_ACCOUNTS_DONE: path.join("data${num}", "main_done${num}.txt"),
    WORKING_EMAILS:     path.join("data${num}", "working_emails${num}.txt"),
    PENDING:            path.join("data${num}", "pending${num}.txt"),
    OUTPUT_SUCCESS:     path.join("data${num}", "thanhcong${num}.txt"),
    OUTPUT_FAILED:      path.join("data${num}", "failed${num}.txt"),
    OUTPUT_RETRY:       path.join("data${num}", "retry${num}.txt"),
  },
};
`;
}

function mainContent(num) {
  return `"use strict";
const config = require("./configs/config${num}.js");
const { runMain } = require("./lib/runner");
runMain(config).catch((e) => console.error(\`Fatal: \${e.message}\`));
`;
}

// Detect existing instances
function getExistingInstances() {
  const existing = [];
  for (let i = 1; i <= 4; i++) {
    if (fs.existsSync(path.join(process.cwd(), `data${i}`))) {
      existing.push(i);
    }
  }
  return existing;
}

function createInstance(num, appleProxy, tonlineProxy, capsolver, twoCaptcha) {
  const layout = LAYOUTS[num];
  if (!layout) {
    console.log(`  ❌ Instance ${num} không hợp lệ (chỉ hỗ trợ 1-4)`);
    return false;
  }

  const dataDir = path.join(process.cwd(), `data${num}`);
  const configDir = path.join(process.cwd(), "configs");
  const configPath = path.join(configDir, `config${num}.js`);
  const mainPath = path.join(process.cwd(), `main${num}.js`);

  // Data folder
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`  + data${num}/  (thư mục mới)`);
  }

  // Data files — chỉ tạo nếu chưa có, KHÔNG ghi đè
  const dataFiles = [
    {
      name: `main_accounts${num}.txt`,
      content: `# Format: mail|pass|2fa|passimap\n`,
    },
    { name: `working_emails${num}.txt`, content: `# 1 email per line\n` },
    { name: `pending${num}.txt`, content: "" },
    { name: `thanhcong${num}.txt`, content: "" },
    { name: `failed${num}.txt`, content: "" },
    { name: `main_done${num}.txt`, content: "" },
  ];

  for (const f of dataFiles) {
    const fp = path.join(dataDir, f.name);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, f.content, "utf-8");
      console.log(`  + data${num}/${f.name}`);
    } else {
      console.log(`  ~ data${num}/${f.name}  (đã có, giữ nguyên)`);
    }
  }

  // Config dir
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  // Config — chỉ tạo nếu chưa có
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      configContent(
        num,
        layout,
        appleProxy,
        tonlineProxy,
        capsolver,
        twoCaptcha,
      ),
      "utf-8",
    );
    console.log(
      `  + configs/config${num}.js  [${layout.monitor}] T-Online: ${layout.ton} | Apple: ${layout.apple}`,
    );
  } else {
    console.log(
      `  ~ configs/config${num}.js  (đã có, giữ nguyên — chỉnh tay nếu cần)`,
    );
  }

  // Main file — chỉ tạo nếu chưa có
  if (!fs.existsSync(mainPath)) {
    fs.writeFileSync(mainPath, mainContent(num), "utf-8");
    console.log(`  + main${num}.js`);
  } else {
    console.log(`  ~ main${num}.js  (đã có, giữ nguyên)`);
  }

  return true;
}

// Defaults
const DEFAULT_APPLE_PROXY =
  "43.230.9.47:1000:xvasnthien01-region-DE:bbshygegxc";
const DEFAULT_TONLINE_PROXY = "";
const DEFAULT_CAPSOLVER = "";
const DEFAULT_TWOCAPTCHA = "70c2feeaabdfc45f038aba48c7568392";

async function main() {
  console.log(`
╔═══════════════════════════════════════════════╗
║     Apple iForgot Tool — Add Instance         ║
╚═══════════════════════════════════════════════╝`);

  const existing = getExistingInstances();
  const nextNum = existing.length === 0 ? 1 : Math.max(...existing) + 1;

  if (existing.length > 0) {
    console.log(
      `\n  Luồng hiện có: ${existing.map((n) => `luồng ${n}`).join(", ")}`,
    );
  } else {
    console.log(`\n  Chưa có luồng nào.`);
  }

  const numStr = await ask(`\n  Thêm luồng số mấy? [${nextNum}]: `);
  const num = parseInt(numStr) || nextNum;

  if (num < 1 || num > 8) {
    console.log(`  ❌ Chỉ hỗ trợ luồng 1-8 (1-4: màn 2K, 5-8: màn Full HD)`);
    rl.close();
    return;
  }

  if (existing.includes(num)) {
    const confirm = await ask(
      `  ⚠️  Luồng ${num} đã tồn tại. Tạo lại file còn thiếu? (y/N): `,
    );
    if (confirm.trim().toLowerCase() !== "y") {
      console.log(`  Hủy.`);
      rl.close();
      return;
    }
  }

  console.log(`\n  ── Luồng ${num} ──`);
  const ok = createInstance(
    num,
    DEFAULT_APPLE_PROXY,
    DEFAULT_TONLINE_PROXY,
    DEFAULT_CAPSOLVER,
    DEFAULT_TWOCAPTCHA,
  );

  if (ok) {
    // proxies.txt
    const proxyPath = path.join(process.cwd(), "proxies.txt");
    if (!fs.existsSync(proxyPath)) {
      fs.writeFileSync(proxyPath, "# host:port:user:pass\n", "utf-8");
      console.log(`  + proxies.txt`);
    }

    const layout = LAYOUTS[num];
    console.log(`
  ✅ Xong! Luồng ${num} đã sẵn sàng.

  Layout [${layout.monitor}]:
    T-Online browser: position ${layout.ton}
    Apple browser:    position ${layout.apple}

  Bước tiếp theo:
    data${num}/main_accounts${num}.txt  ← thêm T-Online accounts
    data${num}/working_emails${num}.txt ← thêm email pool

  Chạy:
    node main${num}.js
`);
  }

  rl.close();
}

main();
