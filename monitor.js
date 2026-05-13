/**
 * ============================================================
 *  UPTIME MONITOR
 *  - Checks 3 websites + 1 API
 *  - Retries 3 times before alerting
 *  - Detects unexpected redirects
 *  - Detects slow responses (>10s)
 *  - Sends HTML email alert to multiple recipients
 *  - Runs via GitHub Actions (free tier) every 15 mins
 * ============================================================
 */

const axios      = require("axios");
const nodemailer = require("nodemailer");

// ─────────────────────────────────────────────
//  TARGETS
// ─────────────────────────────────────────────

const TARGETS = [
  {
    name: "StucRed Website",
    url: "https://stucred.com/",
    expectedDomain: "stucred.com",
    expectedStatus: 200,
    maxResponseTime: 10000,
  },
  {
    name: "Kreon",
    url: "https://kreon.in",
    expectedDomain: "kreon.in",
    expectedStatus: 200,
    maxResponseTime: 10000,
  },
  {
    name: "MDPD",
    url: "https://mdpd.in",
    expectedDomain: "mdpd.in",
    expectedStatus: 200,
    maxResponseTime: 10000,
  },
  {
    name: "StucRed College API",
    url: "https://api.services.stucred.com/college-admin/get_credits_of_stucred_college/IR-E-C-16626",
    expectedDomain: "api.services.stucred.com",
    expectedStatus: 200,
    maxResponseTime: 10000,
  },
];

// ─────────────────────────────────────────────
//  CONFIG — from GitHub Secrets
// ─────────────────────────────────────────────

const ALERT_EMAILS = (process.env.ALERT_EMAILS || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

const SMTP_CONFIG = {
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
};

const FROM_EMAIL  = `"Uptime Monitor" <${process.env.SMTP_USER}>`;
const RETRY_COUNT = 3;
const RETRY_DELAY = 5000; // 5s between retries

// ─────────────────────────────────────────────
//  FETCH — axios with full error detail
// ─────────────────────────────────────────────

// Maps axios error codes to readable status codes
const ERROR_CODE_MAP = {
  ECONNREFUSED:     "CONN_REFUSED",
  ENOTFOUND:        "DNS_FAILED",
  ETIMEDOUT:        "TIMEOUT",
  ECONNRESET:       "CONN_RESET",
  ECONNABORTED:     "TIMEOUT",
  ERR_BAD_RESPONSE: "BAD_RESPONSE",
};

async function fetchURL(url) {
  const startTime = Date.now();
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: null,   // never throw on status codes — we handle them
      headers: { "User-Agent": "UptimeMonitor/1.0" },
    });

    const responseTime = Date.now() - startTime;
    const finalUrl     = res.request?.res?.responseUrl || url;

    return {
      ok:           res.status >= 200 && res.status < 400,
      statusCode:   res.status,
      finalUrl,
      responseTime,
    };
  } catch (err) {
    const responseTime = Date.now() - startTime;
    const statusCode   = ERROR_CODE_MAP[err.code] || err.code || "ERROR";
    return {
      ok: false,
      statusCode,
      finalUrl: url,
      responseTime,
      error: err.message || "Unknown error",
    };
  }
}

// ─────────────────────────────────────────────
//  CHECK TARGET — with retries
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkTarget(target) {
  let lastResult;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    lastResult = await fetchURL(target.url);

    console.log(
      `[${target.name}] Attempt ${attempt}: ` +
      `Status=${lastResult.statusCode} | ` +
      `Time=${lastResult.responseTime}ms | ` +
      `URL=${lastResult.finalUrl}`
    );

    // Unexpected redirect check
    if (!lastResult.error && target.expectedDomain) {
      try {
        const finalHost = new URL(lastResult.finalUrl).hostname.replace(/^www\./, "");
        const expected  = target.expectedDomain.replace(/^www\./, "");
        if (!finalHost.endsWith(expected)) {
          lastResult.ok         = false;
          lastResult.statusCode = "REDIRECT";
          lastResult.error      = `Redirected to unexpected domain: ${finalHost}`;
        }
      } catch (_) {}
    }

    // Slow response check
    if (lastResult.ok && target.maxResponseTime && lastResult.responseTime > target.maxResponseTime) {
      lastResult.ok         = false;
      lastResult.statusCode = "SLOW";
      lastResult.error      = `Slow response: ${lastResult.responseTime}ms (limit: ${target.maxResponseTime}ms)`;
    }

    // Wrong status code check
    if (lastResult.ok && lastResult.statusCode !== target.expectedStatus) {
      lastResult.ok    = false;
      lastResult.error = `Expected status ${target.expectedStatus}, got ${lastResult.statusCode}`;
    }

    if (lastResult.ok) {
      console.log(`[${target.name}] ✅ OK`);
      return { success: true };
    }

    console.log(`[${target.name}] ❌ Failed — ${lastResult.error || lastResult.statusCode}`);

    if (attempt < RETRY_COUNT) {
      console.log(`[${target.name}] Retrying in ${RETRY_DELAY / 1000}s...`);
      await sleep(RETRY_DELAY);
    }
  }

  return {
    success:      false,
    name:         target.name,
    url:          target.url,
    statusCode:   lastResult.statusCode ?? "N/A",
    error:        lastResult.error ?? `Unexpected status: ${lastResult.statusCode}`,
    responseTime: lastResult.responseTime != null ? `${lastResult.responseTime}ms` : "N/A",
  };
}

// ─────────────────────────────────────────────
//  EMAIL ALERT
// ─────────────────────────────────────────────

// Color map for status codes in email
function statusColor(code) {
  if (typeof code === "number") return "#c0392b";
  const colors = {
    TIMEOUT:      "#e67e22",
    DNS_FAILED:   "#8e44ad",
    CONN_REFUSED: "#c0392b",
    CONN_RESET:   "#c0392b",
    REDIRECT:     "#2980b9",
    SLOW:         "#e67e22",
    BAD_RESPONSE: "#c0392b",
  };
  return colors[code] || "#c0392b";
}

async function sendAlert(failures) {
  const transporter = nodemailer.createTransport(SMTP_CONFIG);

  const rows = failures.map((f) => `
    <tr>
      <td style="padding:10px;border:1px solid #ddd;font-weight:bold;">${f.name}</td>
      <td style="padding:10px;border:1px solid #ddd;"><a href="${f.url}" style="color:#2980b9;">${f.url}</a></td>
      <td style="padding:10px;border:1px solid #ddd;color:${statusColor(f.statusCode)};font-weight:bold;">${f.statusCode}</td>
      <td style="padding:10px;border:1px solid #ddd;">${f.responseTime}</td>
      <td style="padding:10px;border:1px solid #ddd;color:#555;">${f.error}</td>
    </tr>`).join("");

  const html = `
    <div style="font-family:sans-serif;max-width:900px;margin:0 auto;">
      <h2 style="color:#c0392b;">🚨 Uptime Alert</h2>
      <p>The following ${failures.length > 1 ? "services are" : "service is"} down as of <strong>${new Date().toUTCString()}</strong>:</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="background:#f2f2f2;">
            <th style="padding:10px;border:1px solid #ddd;text-align:left;">Name</th>
            <th style="padding:10px;border:1px solid #ddd;text-align:left;">URL</th>
            <th style="padding:10px;border:1px solid #ddd;text-align:left;">Status Code</th>
            <th style="padding:10px;border:1px solid #ddd;text-align:left;">Response Time</th>
            <th style="padding:10px;border:1px solid #ddd;text-align:left;">Error</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <br/>
      <p style="color:#888;font-size:11px;">Monitored via GitHub Actions — runs every 15 minutes 24/7</p>
    </div>
  `;

  const plain = failures
    .map((f) => `• ${f.name} | ${f.url} | Status: ${f.statusCode} | Time: ${f.responseTime} | ${f.error}`)
    .join("\n");

  await transporter.sendMail({
    from:    FROM_EMAIL,
    to:      ALERT_EMAILS.join(", "),
    subject: `🚨 DOWN: ${failures.map((f) => f.name).join(", ")}`,
    text:    plain,
    html,
  });

  console.log(`✉️  Alert sent to: ${ALERT_EMAILS.join(", ")}`);
}

// ─────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────

async function runChecks() {
  console.log(`\n🔍 [${new Date().toISOString()}] Running uptime checks...\n`);

  const results  = await Promise.all(TARGETS.map(checkTarget));
  const failures = results.filter((r) => !r.success);

  console.log(`\n── Summary ──`);
  console.log(`✅ Passed: ${results.length - failures.length}/${results.length}`);
  console.log(`❌ Failed: ${failures.length}/${results.length}`);

  if (failures.length === 0) {
    console.log("\n✅ All systems operational.");
    return;
  }

  console.log(`\n📧 Sending alert email...`);
  try {
    await sendAlert(failures);
  } catch (err) {
    console.error("❌ Failed to send alert email:", err.message);
    process.exit(1);
  }
}

runChecks();
