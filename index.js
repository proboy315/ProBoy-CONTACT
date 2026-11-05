const fs = require("fs");
const path = require("path");

const TO = "luciferkiller315@gmail.com";   // hamesha isi par mail aye gi
const FROM_EMAIL = "onboarding@resend.dev";
const TEMPLATE = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");

// ---- helpers ----
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const one = (v) => (Array.isArray(v) ? v[0] : v);
const line = (v, max) => String(one(v) ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
const text = (v, max) => String(one(v) ?? "").replace(/\r/g, "").trim().slice(0, max);

// ---- simple rate limit (best-effort, per serverless instance) ----
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5; // 1 minute me max 5 messages per IP
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // GET ?query  ya  POST (json / form) dono chalenge
  let data = { ...(req.query || {}) };
  if (req.method === "POST" && req.body) {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(body)); }
    }
    data = { ...data, ...body };
  }

  // Koi parameter nahi -> usage dikhao
  if (!data.name && !data.email && !data.message) {
    return res.status(200).json({
      service: "proboy-contact",
      usage: "/?from=SHAHAN&name=..&email=..&number=..&subject=..&message=..",
      required: ["name", "email", "number", "subject", "message"],
      optional: ["from"],
    });
  }

  const KEY = process.env.KEY;
  if (!KEY) return res.status(500).json({ success: false, error: "Server KEY missing" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ success: false, error: "Too many requests, try again in a minute" });

  const fromName = line(data.from, 40).replace(/[^\p{L}\p{N} ._-]/gu, "") || "PROBOY";
  const name = line(data.name, 80);
  const email = line(data.email, 120);
  const number = line(data.number, 30);
  const subject = line(data.subject, 150);
  const message = text(data.message, 3000);

  const missing = Object.entries({ name, email, number, subject, message })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return res.status(400).json({ success: false, error: "Missing: " + missing.join(", ") });
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    return res.status(400).json({ success: false, error: "Invalid email" });
  if (!/^[0-9+\-\s()]{7,30}$/.test(number))
    return res.status(400).json({ success: false, error: "Invalid number" });

  // WhatsApp link: 03xx... -> 923xx...
  let digits = number.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "92" + digits.slice(1);

  const vars = {
    name: esc(name),
    email: esc(email),
    number: esc(number),
    subject: esc(subject),
    message: esc(message).replace(/\n/g, "<br>"),
    mailto: esc(`mailto:${email}?subject=${encodeURIComponent("Re: " + subject)}`),
    wa: esc(`https://wa.me/${digits}`),
    tel: esc(`tel:+${digits}`),
    time: esc(new Date().toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) + " (PKT)"),
  };

  let html = TEMPLATE;
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, () => v);

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${FROM_EMAIL}>`,
        to: [TO],
        reply_to: email, // reply dabane par seedha visitor ko jayega
        subject: `[PROBOY Contact] ${subject}`,
        html,
      }),
    });
    const out = await r.json();
    if (!r.ok) return res.status(502).json({ success: false, error: out.message || "Resend error" });
    return res.status(200).json({ success: true, id: out.id });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Send failed" });
  }
};
