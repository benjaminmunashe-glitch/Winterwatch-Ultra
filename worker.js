// Winter Watch Ultra – AI relay (Cloudflare Worker)
// The Gemini key lives ONLY in the Worker's encrypted secret GEMINI_KEY.
// It is never in this file, the repo, or the page.
//
// The page sends   POST { system, user }
// The relay returns      { text, inTok, outTok, model }

const ALLOWED_ORIGINS = [
  "https://benjaminmunashe-glitch.github.io",
];
// Fixed here so visitors can't pick an expensive model.
// To change it without editing code, add a plain-text variable MODEL in the Worker's settings.
const DEFAULT_MODEL = "gemini-3.8-flash-lite";
const MAX_INPUT_CHARS = 120000;     // stops huge requests
const MAX_OUTPUT_TOKENS = 1500;
const PER_IP_PER_MINUTE = 8;        // best-effort limit per visitor

const hits = new Map(); // ip -> [timestamps] (per Worker instance, best effort)

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function reply(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return reply(405, { error: "POST only" }, origin);
    if (!env.GEMINI_KEY) return reply(500, { error: "Relay has no GEMINI_KEY secret set." }, origin);
    const MODEL = env.MODEL || DEFAULT_MODEL;

    // simple rate limit
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (recent.length >= PER_IP_PER_MINUTE) return reply(429, { error: "Too many questions – wait a minute and try again." }, origin);
    recent.push(now); hits.set(ip, recent);

    let body;
    try { body = await request.json(); } catch { return reply(400, { error: "Bad JSON" }, origin); }
    const system = String(body.system || "");
    const user = String(body.user || "");
    if (!user) return reply(400, { error: "Empty question" }, origin);
    if (system.length + user.length > MAX_INPUT_CHARS) return reply(413, { error: "Request too large" }, origin);

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return reply(r.status, { error: j.error?.message || "Gemini error" }, origin);

    return reply(200, {
      text: (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("") || "(no text)",
      inTok: j.usageMetadata?.promptTokenCount,
      outTok: j.usageMetadata?.candidatesTokenCount,
      model: MODEL,
    }, origin);
  },
};
