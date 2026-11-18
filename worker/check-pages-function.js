/* RotWatch one-off page check (Pages Function).
 *
 * POST /api/check  with JSON {"url": "https://example.com/page"}
 * GET  /api/check?url=https://example.com/page
 *
 * The handler fetches the page, records the status code and response
 * time, then checks the links found on the page: HEAD first, GET on
 * retry. It keeps nothing. No accounts, no storage, no cookies.
 *
 * The code uses only standard web APIs (fetch, Request, Response,
 * URL, AbortSignal), so the same logic runs on Cloudflare Workers
 * and under Node 20+ for a local smoke test. This file is the
 * Pages Functions entry point; the check logic is identical to
 * worker/check.js, only the entry form and route differ.
 */

const MAX_LINKS = 100;
const MAX_HTML_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const LINK_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 25000;
const CONCURRENCY = 10;
const USER_AGENT = "RotWatch/1.0 (+https://rotwatch-dwz.pages.dev)";

const ALLOWED_ORIGINS = new Set([
  "https://rotwatch-dwz.pages.dev",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function jsonResponse(status, data, origin) {
  const headers = { "Content-Type": "application/json" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function parseIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function ipv4Blocked(nums) {
  const [a, b] = nums;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && nums[2] === 100) return true;
  if (a === 203 && b === 0 && nums[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function hostBlocked(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  if (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const v4 = parseIPv4(host);
  if (v4) return ipv4Blocked(v4);
  // IPv6 literals arrive without brackets from URL.hostname.
  if (host === "::1") return true;
  if (host.startsWith("fe8") || host.startsWith("fe9") ||
      host.startsWith("fea") || host.startsWith("feb")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (host.startsWith("::ffff:")) {
    const mapped = parseIPv4(host.slice("::ffff:".length));
    if (mapped) return ipv4Blocked(mapped);
  }
  return false;
}

function validateTarget(raw) {
  if (typeof raw !== "string") return { error: "Send a URL as a string." };
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Send a URL to check." };
  if (trimmed.length > 2048) return { error: "That URL is too long." };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "That address does not look like a URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Only http:// and https:// addresses can be checked." };
  }
  if (!parsed.hostname) return { error: "That URL has no host name." };
  if (hostBlocked(parsed.hostname)) {
    return { error: "Private and local network addresses cannot be checked." };
  }
  return { url: parsed.toString() };
}

async function readCappedText(response, maxBytes) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - received;
      if (remaining <= 0) break;
      const chunk = value.subarray(0, remaining);
      received += chunk.length;
      text += decoder.decode(chunk, { stream: true });
      if (received >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the body is already gone */
    }
  }
  return text + decoder.decode();
}

async function cancelBody(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    /* nothing left to cancel */
  }
}

function extractLinks(html, baseUrl) {
  const found = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const raw = (match[1] !== undefined ? match[1] : match[2] || "").trim();
    if (!raw) continue;
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    let resolved;
    try {
      resolved = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }
    resolved.hash = "";
    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(key);
  }
  return found;
}

async function fetchOnce(url, method, timeoutMs) {
  const response = await fetch(url, {
    method,
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const status = response.status;
  await cancelBody(response);
  return status;
}

async function checkLink(url, deadline) {
  // Recompute the allowance before each attempt so the total budget
  // stays a real bound even when a batch starts near the deadline.
  const timeLeft = () =>
    Math.max(500, Math.min(LINK_TIMEOUT_MS, deadline - Date.now()));
  try {
    const headStatus = await fetchOnce(url, "HEAD", timeLeft());
    if (headStatus < 400) return { url, status: headStatus, ok: true };
    const getStatus = await fetchOnce(url, "GET", timeLeft());
    if (getStatus < 400) return { url, status: getStatus, ok: true };
    return { url, status: getStatus, ok: false };
  } catch (err) {
    // HEAD failed at the network level. Retry once with GET.
    try {
      const getStatus = await fetchOnce(url, "GET", timeLeft());
      if (getStatus < 400) return { url, status: getStatus, ok: true };
      return { url, status: getStatus, ok: false };
    } catch (retryErr) {
      return {
        url,
        status: null,
        ok: false,
        error: "request failed (" + (retryErr && retryErr.name ? retryErr.name : "error") + ")",
      };
    }
  }
}

async function checkLinksInBatches(urls, deadline) {
  const results = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    if (Date.now() >= deadline) break;
    const batch = urls.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map((u) => checkLink(u, deadline)));
    results.push(...settled);
  }
  return results;
}

async function runCheck(targetUrl) {
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;
  let response;
  try {
    response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      checkedUrl: targetUrl,
      finalUrl: targetUrl,
      status: null,
      ok: false,
      responseTimeMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error:
        "The page could not be fetched (" +
        (err && err.name ? err.name : "error") +
        ").",
      linksFound: 0,
      linksChecked: 0,
      brokenLinks: [],
      links: [],
    };
  }

  const responseTimeMs = Date.now() - startedAt;
  const finalUrl = response.url || targetUrl;
  const status = response.status;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  const base = {
    checkedUrl: targetUrl,
    finalUrl,
    status,
    ok: status >= 200 && status < 400,
    responseTimeMs,
    checkedAt: new Date().toISOString(),
  };

  if (!(status >= 200 && status < 300) || !contentType.includes("text/html")) {
    await cancelBody(response);
    return { ...base, linksFound: 0, linksChecked: 0, brokenLinks: [], links: [] };
  }

  const html = await readCappedText(response, MAX_HTML_BYTES);
  const found = extractLinks(html, finalUrl);
  const toCheck = found.slice(0, MAX_LINKS);
  const results = await checkLinksInBatches(toCheck, deadline);
  const broken = results.filter((r) => !r.ok);
  return {
    ...base,
    linksFound: found.length,
    linksChecked: results.length,
    truncated: results.length < toCheck.length,
    brokenLinks: broken,
    links: results,
  };
}

async function readTarget(request, url) {
  if (request.method === "GET") {
    return validateTarget(url.searchParams.get("url"));
  }
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return { error: "Send a JSON body like {\"url\": \"https://example.com\"}." };
    }
    return validateTarget(body && body.url);
  }
  return { error: "Use GET or POST." };
}

export async function onRequest({ request }) {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    const headers = {};
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
      headers["Vary"] = "Origin";
    }
    return new Response(null, { status: 204, headers });
  }

  if (url.pathname !== "/api/check") {
    return jsonResponse(404, { error: "Nothing lives here. Use POST /api/check." }, origin);
  }

  const target = await readTarget(request, url);
  if (target.error) {
    return jsonResponse(400, { error: target.error }, origin);
  }

  const result = await runCheck(target.url);
  return jsonResponse(200, result, origin);
}
