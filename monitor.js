/**
 * ============================================================
 *  UPTIME MONITOR
 *  - Checks 3 websites + 1 API every 5 minutes
 *  - Retries 3 times before alerting
 *  - Detects unexpected redirects
 *  - Sends email alert to multiple recipients
 *  - Config via environment variables (GitHub Actions Secrets)
 * ============================================================
 */

const https = require("https");
const http  = require("http");
const nodemailer = require("nodemailer");

// ─────────────────────────────────────────────
//  TARGETS
// ─────────────────────────────────────────────

const TARGETS = [
  {
    name: "StucRed Website",
    url: "https://stucred.com/",
    expectedDomain: "stucred.com",
    maxResponseTime: 10000,
  },
  {
    name: "Kreon",
    url: "https://kreon.in",
    expectedDomain: "kreon.in",
    maxResponseTime: 10000,
  },
  {
    name: "MDPD",
    url: "https://mdpd.in",
    expectedDomain: "mdpd.in",
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
//  CONFIG — from GitHub Secrets (env vars)
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
const RETRY_DELAY = 5000;

// ─────────────────────────────────────────────
//  FETCH with redirect tracking + timing
// ─────────────────────────────────────────────

function fetchURL(url, redirectCount = 0, startTime = Date.now()) {
  return new Promise((resolve) => {
    const maxRedirects = 5;
    const lib = url.startsWith("https") ? https : http;

    const req = lib.get(url, { timeout: 10000 }, (res) => {
      const { statusCode, headers } = res;
      res.resume();

      const responseTime = Date.now() - startTime;

      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        if (redirectCount >= maxRedirects) {
          return resolve({ ok: false, statusCode, finalUrl: url, responseTime, error: "Too many redirects" });
        }
        const redirectUrl = new URL(headers.location, url).href;
        return fetchURL(redirectUrl, redirectCount + 1, startTime).then(resolve);
      }

      resolve({ ok: statusCode >= 200 && statusCode < 400, statusCode, finalUrl: url, responseTime });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusCode: null, finalUrl: url, responseTime: 10000, error: "Timeout (>10s)" });
    });

    req.on("error", (err) => {
      resolve({ ok: false, statusCode: null, finalUrl: url, responseTime: null, error: err.message });
    });
  });
}

// ─────────────────────────────────────────────
//  CHECK TARGET with retries
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkTarget(target) {
  let lastResult;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    lastResult = await fetchURL(target.url);
    console.log(`[${target.name}] Attempt ${attempt}: HTTP ${lastResult.statusCode ?? "ERR"} | ${lastResult.responseTime}ms | ${lastResult.finalUrl}`);

    const expectedStatus = target.expectedStatus ?? 200;

    // Unexpected redirect
    if (lastResult.ok && target.expectedDomain) {
      try {
        const finalHost = new URL(lastResult.finalUrl).hostname.replace(/^www\./, "");
        const expected  = target.expectedDomain.replace(/^www\./, "");
        if (!finalHost.endsWith(expected)) {
          lastResult.ok    = false;
          lastResult.error = `Redirected to unexpected domain: ${finalHost}`;
        }
      } catch (_) {}
    }

    // Slow response
    if (lastResult.ok && target.maxResponseTime && lastResult.responseTime > target.maxResponseTime) {
      lastResult.ok    = false;
      lastResult.error = `Slow response: ${lastResult.responseTime}ms (limit ${target.maxResponseTime}ms)`;
    }

    // Wrong status
    if (lastResult.ok && lastResult.statusCode !== expectedStatus) {
      lastResult.ok    = false;
      lastResult.error = `Unexpected status: ${lastResult.statusCode} (expected ${expectedStatus})`;
    }

    if (lastResult.ok) return { success: true };

    if (attempt < RETRY_COUNT) {
      console.log(`[${target.name}] Retrying in ${RETRY_DELAY / 1000}s...`);
      await sleep(RETRY_DELAY);
    }
  }

  return {
    success:      false,
    name:         target.name,
    url:          target.url,
    status:       lastResult.statusCode ?? "N/A",
    error:        lastResult.error ?? `HTTP ${lastResult.statusCode}`,
    responseTime: lastResult.responseTime != null ? `${lastResult.responseTime}ms` : "N/A",
  };
}

// ─────────────────────────────────────────────
//  EMAIL ALERT
// ─────────────────────────────────────────────

async function sendAlert(failures) {
  const transporter = nodemailer.createTransport(SMTP_CONFIG);

  const rows = failures.map((f) => `
    <tr>
      <td style="padding:8px;border:1px solid #ddd;font-weight:bold;">${f.name}</td>
      <td style="padding:8px;border:1px solid #ddd;"><a href="${f.url}">${f.url}</a></td>
      <td style="padding:8px;border:1px solid #ddd;color:#c0392b;">${f.status}</td>
      <td style="padding:8px;border:1px solid #ddd;">${f.responseTime}</td>
      <td style="padding:8px;border:1px solid #ddd;">${f.error}</td>
    </tr>`).join("");

  const html = `
    <h2 style="color:#c0392b;">🚨 Uptime Alert</h2>
    <p>The following ${failures.length > 1 ? "services are" : "service is"} down as of <strong>${new Date().toUTCString()}</strong>:</p>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;">
      <thead>
        <tr style="background:#f2f2f2;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Name</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">URL</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Status Code</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Response Time</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Error</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:11px;">Monitored via GitHub Actions — runs every 5 minutes 24/7</p>
  `;

  const plain = failures
    .map((f) => `• ${f.name} | ${f.url} | Status: ${f.status} | Time: ${f.responseTime} | ${f.error}`)
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

  if (failures.length === 0) {
    console.log("\n✅ All systems operational.");
    return;
  }

  console.log(`\n❌ ${failures.length} failure(s) detected. Sending alert email...`);
  try {
    await sendAlert(failures);
  } catch (err) {
    console.error("Failed to send alert email:", err.message);
    process.exit(1);
  }
}

runChecks();
