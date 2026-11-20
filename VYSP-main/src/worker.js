// Zimmer gallery: one Worker, static assets in /public, all state in one R2 bucket.
//
// R2 layout
//   site.json                          photo order, captions, site texts
//   photos/<id>/original.<jpg|png|webp> the untouched upload
//   photos/<id>/w800.<webp|jpg>         variant made in the admin's browser
//   photos/<id>/w2000.<webp|jpg>        variant made in the admin's browser
//   _system/login-fail/<hash>.json      failed-login counters (rate limiting)

const MAX_PHOTOS = 50;
const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
const MAX_VARIANT_BYTES = 12 * 1024 * 1024;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_NAME = "__Host-zimmer_session";
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const IMAGE_CACHE = "public, max-age=31536000, immutable";

const LIMITS = {
  name: 80,
  subtitle: 160,
  location: 100,
  description: 2500,
  amenities: 800,
  phone: 25,
  whatsapp: 25,
  caption: 200,
};

const DEFAULT_ADMIN_TOKEN = "admin123";

function getAdminToken(env) {
  if (typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.trim().length > 0) {
    return env.ADMIN_TOKEN.trim();
  }
  return DEFAULT_ADMIN_TOKEN;
}

const DEFAULT_TEXTS = {
  name: "סוויטה במושבה",
  subtitle: "",
  location: "",
  description: "",
  amenities: "",
  phone: "",
  whatsapp: "",
};

const ORIGINAL_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const VARIANT_TYPES = { "image/webp": "webp", "image/jpeg": "jpg" };
const VARIANTS = ["original", "w800", "w2000"];
const ID_RE = /^[a-z0-9]{20}$/;
const IMAGE_FILE_RE = /^(?:(w800|w2000)\.(webp|jpg)|original\.(jpg|png|webp))$/;

const MSG = {
  notConfigured: "קוד הגישה עדיין לא הוגדר. יש להגדיר אותו פעם אחת בלוח הבקרה של Cloudflare (ראו README).",
  badToken: "קוד הגישה שגוי.",
  needLogin: "פג תוקף ההתחברות. היכנסו שוב.",
  badOrigin: "הבקשה נחסמה מטעמי אבטחה. רעננו את הדף ונסו שוב.",
  badRequest: "הבקשה אינה תקינה. רעננו את הדף ונסו שוב.",
  badType: "סוג הקובץ אינו נתמך. אפשר להעלות JPEG,‏ PNG או WebP בלבד.",
  tooBig: "הקובץ גדול מדי. הגודל המרבי הוא 30MB לתמונה.",
  noLength: "לא ניתן לקבוע את גודל הקובץ. נסו שוב.",
  tooMany: `אפשר לשמור עד ${MAX_PHOTOS} תמונות. מחקו תמונה כדי להוסיף חדשה.`,
  missingFiles: "חלק מקובצי התמונה לא הגיעו לשרת. נסו להעלות אותה שוב.",
  notFound: "התמונה לא נמצאה. ייתכן שכבר נמחקה. רעננו את הדף.",
  orderChanged: "רשימת התמונות השתנתה בינתיים. רעננו את הדף ונסו שוב.",
  conflict: "השמירה נכשלה בגלל עדכון מקביל. נסו שוב.",
  server: "אירעה שגיאה בשרת. נסו שוב בעוד רגע.",
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err && err.stack ? err.stack : err);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return json({ error: MSG.server }, 500);
      return new Response("שגיאה זמנית. נסו שוב בעוד רגע.", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/" && (method === "GET" || method === "HEAD")) return renderHome(request, env);

  if (pathname === "/admin") {
    return Response.redirect(`${url.origin}/admin/`, 301);
  }

  if (pathname === "/admin/") {
    if (env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL("/admin/index.html", request.url), request));
    }
  }

  if (pathname.startsWith("/img/")) {
    if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    return serveImage(request, env, pathname);
  }

  if (pathname.startsWith("/api/")) return api(request, env, url);

  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;
  }

  return notFound();
}

/* ------------------------------------------------------------------ API */

async function api(request, env, url) {
  const method = request.method;
  const path = url.pathname.slice("/api".length);
  const configured = true;

  if (path === "/session" && method === "GET") {
    const authenticated = configured && (await hasSession(request, env));
    return json({ configured, authenticated });
  }

  if (path === "/site" && method === "GET") {
    const { site } = await readSite(env);
    return json(site, 200, { "cache-control": "no-store" });
  }

  // Everything below changes state.
  if (!sameOrigin(request, url)) return json({ error: MSG.badOrigin }, 403);

  if (path === "/login" && method === "POST") return login(request, env, configured);
  if (path === "/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }

  if (!configured) return json({ error: MSG.notConfigured }, 503);
  if (!(await hasSession(request, env))) return json({ error: MSG.needLogin }, 401);

  let m;
  if ((m = path.match(/^\/photos\/([a-z0-9]+)\/(original|w800|w2000)$/)) && method === "PUT") {
    return uploadFile(request, env, m[1], m[2]);
  }
  if (path === "/photos" && method === "POST") return commitPhoto(request, env);
  if ((m = path.match(/^\/photos\/([a-z0-9]+)$/))) {
    if (method === "PATCH") return updateCaption(request, env, m[1]);
    if (method === "DELETE") return deletePhoto(env, m[1]);
  }
  if (path === "/order" && method === "PUT") return saveOrder(request, env);
  if (path === "/texts" && method === "PUT") return saveTexts(request, env);

  return json({ error: MSG.badRequest }, 404);
}

function sameOrigin(request, url) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  return true;
}

/* --------------------------------------------------------------- Auth */

async function login(request, env, configured) {
  if (!configured) return json({ error: MSG.notConfigured }, 503);

  const ip = request.headers.get("cf-connecting-ip") || "local";
  const failKey = `_system/login-fail/${(await sha256Hex(ip)).slice(0, 32)}.json`;
  const now = Date.now();

  let record = null;
  const stored = await env.BUCKET.get(failKey);
  if (stored) {
    try { record = await stored.json(); } catch { record = null; }
  }
  if (record && record.lockedUntil && record.lockedUntil > now) {
    const minutes = Math.ceil((record.lockedUntil - now) / 60000);
    return json({ error: lockedMessage(minutes) }, 429, { "retry-after": String(Math.ceil((record.lockedUntil - now) / 1000)) });
  }

  const body = await readJson(request, 4096);
  const token = body && typeof body.token === "string" ? body.token.trim() : "";
  const expectedToken = getAdminToken(env);

  if (token && (await safeEqual(token, expectedToken))) {
    if (stored) await env.BUCKET.delete(failKey);
    const cookie = await makeSessionCookie(env);
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }

  // Failed attempt: count it.
  if (!record || now - record.first > LOGIN_WINDOW_MS) record = { count: 0, first: now };
  record.count += 1;
  let status = 401;
  let error = MSG.badToken;
  if (record.count >= LOGIN_MAX_FAILURES) {
    record.lockedUntil = now + LOGIN_LOCK_MS;
    status = 429;
    error = lockedMessage(Math.ceil(LOGIN_LOCK_MS / 60000));
  } else {
    const left = LOGIN_MAX_FAILURES - record.count;
    error = left === 1 ? `${MSG.badToken} נותר ניסיון אחד.` : `${MSG.badToken} נותרו ${left} ניסיונות.`;
  }
  await env.BUCKET.put(failKey, JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
  return json({ error }, status);
}

function lockedMessage(minutes) {
  const when = minutes <= 1 ? "בעוד דקה" : `בעוד ${minutes} דקות`;
  return `יותר מדי ניסיונות כושלים. מטעמי אבטחה הכניסה נחסמה זמנית. אפשר לנסות שוב ${when}.`;
}

async function sessionKey(env) {
  const token = getAdminToken(env);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`zimmer-session-v1:${token}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function makeSessionCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const key = await sessionKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${exp}`));
  const value = `${exp}.${b64url(new Uint8Array(sig))}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

async function hasSession(request, env) {
  const value = readCookie(request, COOKIE_NAME);
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const expText = value.slice(0, dot);
  if (!/^\d{9,11}$/.test(expText)) return false;
  const exp = Number(expText);
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now || exp > now + SESSION_SECONDS + 60) return false;
  let sig;
  try { sig = b64urlDecode(value.slice(dot + 1)); } catch { return false; }
  const key = await sessionKey(env);
  // crypto.subtle.verify compares the MAC in constant time.
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(`v1.${exp}`));
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  // Hash first so the comparison runs on equal-length inputs and leaks nothing about length.
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(ha, hb);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* ------------------------------------------------------------ Uploads */

async function uploadFile(request, env, id, variant) {
  if (!ID_RE.test(id)) return json({ error: MSG.badRequest }, 400);

  const isOriginal = variant === "original";
  const types = isOriginal ? ORIGINAL_TYPES : VARIANT_TYPES;
  const declared = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = types[declared];
  if (!ext) return json({ error: MSG.badType }, 415);

  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader ? Number(lengthHeader) : NaN;
  if (!Number.isFinite(length) || length <= 0) return json({ error: MSG.noLength }, 411);
  const max = isOriginal ? MAX_ORIGINAL_BYTES : MAX_VARIANT_BYTES;
  if (length > max) return json({ error: MSG.tooBig }, 413);
  if (!request.body) return json({ error: MSG.badRequest }, 400);

  // Read just enough of the stream to check the file signature, then pass the
  // untouched bytes straight through to R2 (no buffering, no re-encoding).
  const reader = request.body.getReader();
  const head = [];
  let headBytes = 0;
  while (headBytes < 16) {
    const { done, value } = await reader.read();
    if (done) break;
    head.push(value);
    headBytes += value.byteLength;
  }
  const sniffed = sniffImageType(concat(head, 16));
  if (sniffed !== declared) {
    reader.cancel().catch(() => {});
    return json({ error: MSG.badType }, 415);
  }

  const { readable, writable } = new FixedLengthStream(length);
  const pump = (async () => {
    const writer = writable.getWriter();
    try {
      for (const chunk of head) await writer.write(chunk);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    }
  })();

  const key = `photos/${id}/${variant}.${ext}`;
  try {
    await Promise.all([
      env.BUCKET.put(key, readable, {
        httpMetadata: { contentType: declared, cacheControl: IMAGE_CACHE },
      }),
      pump,
    ]);
  } catch (err) {
    console.error("upload failed", err);
    return json({ error: "ההעלאה נקטעה באמצע. בדקו את החיבור ונסו שוב." }, 400);
  }
  return json({ ok: true, key });
}

function sniffImageType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function concat(chunks, limit) {
  const out = new Uint8Array(Math.min(limit, chunks.reduce((n, c) => n + c.byteLength, 0)));
  let offset = 0;
  for (const c of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(c.byteLength, out.length - offset);
    out.set(c.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

async function commitPhoto(request, env) {
  const body = await readJson(request, 8192);
  if (!body) return json({ error: MSG.badRequest }, 400);
  const { id, width, height, originalType, variantType } = body;
  if (!ID_RE.test(String(id))) return json({ error: MSG.badRequest }, 400);
  const oExt = ORIGINAL_TYPES[originalType];
  const vExt = VARIANT_TYPES[variantType];
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!oExt || !vExt || !(w > 0 && w < 100000) || !(h > 0 && h < 100000)) return json({ error: MSG.badRequest }, 400);
  const caption = cleanText(body.caption, LIMITS.caption);

  const keys = [`photos/${id}/original.${oExt}`, `photos/${id}/w800.${vExt}`, `photos/${id}/w2000.${vExt}`];
  const heads = await Promise.all(keys.map((k) => env.BUCKET.head(k)));
  if (heads.some((h) => !h)) return json({ error: MSG.missingFiles }, 409);

  const photo = { id, w, h, o: oExt, v: vExt, caption, added: new Date().toISOString() };
  const result = await updateSite(env, (site) => {
    if (site.photos.some((p) => p.id === id)) return site;
    if (site.photos.length >= MAX_PHOTOS) throw new HttpError(409, MSG.tooMany);
    site.photos.push(photo);
    return site;
  });
  return json({ ok: true, photo, site: result });
}

async function updateCaption(request, env, id) {
  const body = await readJson(request, 4096);
  if (!body) return json({ error: MSG.badRequest }, 400);
  const caption = cleanText(body.caption, LIMITS.caption);
  const site = await updateSite(env, (s) => {
    const p = s.photos.find((x) => x.id === id);
    if (!p) throw new HttpError(404, MSG.notFound);
    p.caption = caption;
    return s;
  });
  return json({ ok: true, site });
}

async function deletePhoto(env, id) {
  if (!ID_RE.test(id)) return json({ error: MSG.badRequest }, 400);
  const site = await updateSite(env, (s) => {
    s.photos = s.photos.filter((p) => p.id !== id);
    return s;
  });
  const listed = await env.BUCKET.list({ prefix: `photos/${id}/` });
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
  return json({ ok: true, site });
}

async function saveOrder(request, env) {
  const body = await readJson(request, 16384);
  const ids = body && Array.isArray(body.ids) ? body.ids.map(String) : null;
  if (!ids) return json({ error: MSG.badRequest }, 400);
  const site = await updateSite(env, (s) => {
    const current = new Set(s.photos.map((p) => p.id));
    const incoming = new Set(ids);
    if (incoming.size !== ids.length || incoming.size !== current.size || ids.some((x) => !current.has(x))) {
      throw new HttpError(409, MSG.orderChanged);
    }
    const byId = new Map(s.photos.map((p) => [p.id, p]));
    s.photos = ids.map((x) => byId.get(x));
    return s;
  });
  return json({ ok: true, site });
}

async function saveTexts(request, env) {
  const body = await readJson(request, 16384);
  if (!body) return json({ error: MSG.badRequest }, 400);
  const texts = {
    name: cleanText(body.name, LIMITS.name),
    subtitle: cleanText(body.subtitle, LIMITS.subtitle),
    location: cleanText(body.location, LIMITS.location),
    description: cleanMultiline(body.description, LIMITS.description),
    amenities: cleanText(body.amenities, LIMITS.amenities),
    phone: cleanPhone(body.phone),
    whatsapp: cleanPhone(body.whatsapp),
  };
  if (!texts.name) return json({ error: "יש למלא את שם הצימר.", field: "name" }, 400);
  if (body.phone && !texts.phone) return json({ error: "מספר הטלפון אינו תקין. כתבו ספרות בלבד, למשל 050-1234567.", field: "phone" }, 400);
  if (body.whatsapp && !texts.whatsapp) return json({ error: "מספר הוואטסאפ אינו תקין. כתבו ספרות בלבד, למשל 050-1234567.", field: "whatsapp" }, 400);
  const site = await updateSite(env, (s) => {
    s.texts = texts;
    return s;
  });
  return json({ ok: true, site });
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  // Strip control characters, collapse whitespace.
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanMultiline(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

function cleanPhone(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v) return "";
  if (!/^\+?[\d\s\-().]{6,20}$/.test(v)) return "";
  const digits = v.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return "";
  return v;
}

/* --------------------------------------------------------- site.json */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeSite(raw) {
  const site = raw && typeof raw === "object" ? raw : {};
  const texts = { ...DEFAULT_TEXTS, ...(site.texts && typeof site.texts === "object" ? site.texts : {}) };
  if (!texts.name || texts.name === "שם הצימר") {
    texts.name = "סוויטה במושבה";
  }
  const photos = Array.isArray(site.photos)
    ? site.photos.filter((p) => p && ID_RE.test(String(p.id)) && p.w > 0 && p.h > 0)
    : [];
  return { version: 1, texts, photos };
}

async function readSite(env) {
  const obj = await env.BUCKET.get("site.json");
  if (!obj) return { site: normalizeSite(null), etag: null };
  let raw = null;
  try { raw = await obj.json(); } catch { raw = null; }
  return { site: normalizeSite(raw), etag: obj.etag };
}

// Read-modify-write with an etag precondition, so two quick saves (for example
// several uploads finishing together) cannot overwrite each other.
async function updateSite(env, mutate) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { site, etag } = await readSite(env);
    const next = mutate(structuredClone(site));
    next.updated = new Date().toISOString();
    const options = { httpMetadata: { contentType: "application/json; charset=utf-8" } };
    if (etag) options.onlyIf = { etagMatches: etag };
    const written = await env.BUCKET.put("site.json", JSON.stringify(next), options);
    if (written) return next;
    await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
  }
  throw new HttpError(409, MSG.conflict);
}

/* ------------------------------------------------------------- Images */

async function serveImage(request, env, pathname) {
  const parts = pathname.split("/"); // ["", "img", id, file]
  if (parts.length !== 4 || !ID_RE.test(parts[2]) || !IMAGE_FILE_RE.test(parts[3])) return notFound();
  const key = `photos/${parts[2]}/${parts[3]}`;

  const obj = request.method === "HEAD"
    ? await env.BUCKET.head(key)
    : await env.BUCKET.get(key, { onlyIf: request.headers });
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", IMAGE_CACHE);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  if (parts[3].startsWith("original")) headers.set("content-disposition", "inline");

  if (request.method === "HEAD") {
    headers.set("content-length", String(obj.size));
    return new Response(null, { headers });
  }
  // A failed If-None-Match precondition returns the object without a body.
  if (!("body" in obj) || !obj.body) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

/* --------------------------------------------------------------- Home */

async function renderHome(request, env) {
  const { site, etag } = await readSite(env);
  const tag = `W/"home-${etag || "empty"}-${HOME_VERSION}"`;
  const baseHeaders = {
    etag: tag,
    "cache-control": "no-cache",
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  const inm = request.headers.get("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(tag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }
  const html = homeHtml(site);
  return new Response(request.method === "HEAD" ? null : html, { headers: baseHeaders });
}

// Bump when the HTML template changes, so browsers drop their cached copy.
const HOME_VERSION = "9";

function telHref(phone) {
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return `tel:${d}`;
  if (d.startsWith("0")) return `tel:+972${d.slice(1)}`;
  return `tel:${d}`;
}

function waHref(number) {
  let d = number.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = `972${d.slice(1)}`;
  return `https://wa.me/${d}`;
}

function variantWidth(photo, target) {
  return Math.min(target, photo.w);
}

function imgSrc(photo, size) {
  return `/img/${photo.id}/${size}.${photo.v}`;
}

function homeHtml(site) {
  const t = site.texts;
  const name = t.name || DEFAULT_TEXTS.name;
  const phone = t.phone || "";
  const whatsapp = t.whatsapp || t.phone || "";
  const location = t.location || "";
  const description = t.description || "";
  const amenitiesRaw = t.amenities || "";
  const amenities = amenitiesRaw
    ? amenitiesRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
    : [];
  const total = site.photos.length;
  const hasContact = Boolean(phone || whatsapp);

  const items = site.photos.map((p, i) => {
    const w800 = variantWidth(p, 800);
    const w2000 = variantWidth(p, 2000);
    const lead = i === 0;
    const alt = p.caption || `${name}, תמונה ${i + 1} מתוך ${total}`;
    // Match the grid in site.css, including the plates that close the last row.
    const last = i === total - 1;
    const lone2 = last && i % 2 === 1;                                   // 2 columns: lone last tile spans the row
    const lone3 = last && i % 3 === 1;                                   // 3 columns: lone last tile spans the row
    const pair3 = (i === total - 2 && i % 3 === 1) || (last && i % 3 === 2); // 3 columns: trailing pair, half width each
    const sizes = lead
      ? "100vw"
      : `(min-width: 1280px) ${lone3 ? "100vw" : pair3 ? "50vw" : "33vw"}, (min-width: 720px) ${lone2 ? "100vw" : "50vw"}, 100vw`;
    return `<li class="item${lead ? " item--lead" : ""}">
<a class="frame" href="${imgSrc(p, "w2000")}" data-index="${i}" data-w="${w2000}" data-h="${Math.round(w2000 * p.h / p.w)}" aria-label="פתיחת תמונה ${i + 1} מתוך ${total} בתצוגה מלאה">
<img src="${imgSrc(p, "w800")}" srcset="${imgSrc(p, "w800")} ${w800}w, ${imgSrc(p, "w2000")} ${w2000}w" sizes="${sizes}" width="${p.w}" height="${p.h}" alt="${esc(alt)}" ${lead ? 'fetchpriority="high" loading="eager"' : 'loading="lazy"'} decoding="async">
</a>${p.caption ? `\n<p class="caption">${esc(p.caption)}</p>` : lead ? "" : `\n<p class="caption" aria-hidden="true"></p>`}
</li>`;
  }).join("\n");

  const gallery = total
    ? `<ul class="gallery${site.photos.some((p, i) => i > 0 && p.caption) ? "" : " gallery--bare"}" role="list">\n${items}\n</ul>`
    : `<p class="empty">התמונות יעלו בקרוב.</p>`;

  const contactLinks = [];
  if (whatsapp) contactLinks.push(`<a class="act act--solid" href="${esc(waHref(whatsapp))}" rel="noopener" target="_blank">וואטסאפ</a>`);
  if (phone) contactLinks.push(`<a class="act" href="${esc(telHref(phone))}">חיוג</a>`);

  const heroContact = hasContact
    ? `<div class="hero-contact">
${phone ? `<a class="hero-act hero-act--call" href="${esc(telHref(phone))}"><span class="hero-act-icon">📞</span><span dir="ltr">${esc(phone)}</span></a>` : ""}
${whatsapp ? `<a class="hero-act hero-act--wa" href="${esc(waHref(whatsapp))}" rel="noopener" target="_blank"><span class="hero-act-icon">💬</span><span>וואטסאפ</span></a>` : ""}
</div>`
    : "";

  const descParagraphs = description
    ? description.split("\n").map((p) => p.trim()).filter(Boolean)
    : [];

  const aboutSection = (descParagraphs.length > 0 || amenities.length > 0)
    ? `<section class="details-section" id="details" aria-labelledby="details-title">
<div class="details-inner">
<h2 class="section-title" id="details-title">אודות ופרטי האירוח</h2>
${descParagraphs.length ? `<div class="details-desc">${descParagraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` : ""}
${amenities.length ? `<div class="details-amenities"><h3 class="amenities-title">מה בסוויטה?</h3><ul class="amenities-tags" role="list">${amenities.map((a) => `<li><span class="amenity-check">✓</span> ${esc(a)}</li>`).join("")}</ul></div>` : ""}
</div>
</section>`
    : "";

  const sameNumber = Boolean(phone && whatsapp) && phone.replace(/\D/g, "") === whatsapp.replace(/\D/g, "");
  const contactEntries = `
${location ? `<div><dt>מיקום</dt><dd>${esc(location)}</dd></div>` : ""}
${sameNumber
    ? `<div><dt>טלפון / וואטסאפ</dt><dd><a href="${esc(telHref(phone))}" dir="ltr" translate="no">${esc(phone)}</a></dd><dd class="contact-ways"><a href="${esc(telHref(phone))}">חיוג</a><a href="${esc(waHref(whatsapp))}" rel="noopener" target="_blank">וואטסאפ</a></dd></div>`
    : `${phone ? `<div><dt>טלפון</dt><dd><a href="${esc(telHref(phone))}" dir="ltr" translate="no">${esc(phone)}</a></dd></div>` : ""}
${whatsapp ? `<div><dt>וואטסאפ</dt><dd><a href="${esc(waHref(whatsapp))}" rel="noopener" target="_blank" dir="ltr" translate="no">${esc(whatsapp)}</a></dd></div>` : ""}`
}`;

  const footer = (hasContact || location)
    ? `<footer class="contact" id="contact">
<h2 class="vh">יצירת קשר</h2>
<dl class="contact-list">
${contactEntries}
</dl>
</footer>`
    : `<footer class="contact contact--bare"></footer>`;

  const descriptionMeta = t.subtitle ? t.subtitle : `${name}: תמונות ופרטי יצירת קשר`;

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(name)}</title>
<meta name="description" content="${esc(descriptionMeta)}">
<meta name="theme-color" content="#ffffff">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(descriptionMeta)}">
<meta property="og:type" content="website">
${total ? `<meta property="og:image" content="${imgSrc(site.photos[0], "w2000")}">` : ""}
<link rel="preload" href="/fonts/assistant-hebrew-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/bellefair-hebrew-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css?v=${HOME_VERSION}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script src="/site.js?v=${HOME_VERSION}" defer></script>
</head>
<body class="${hasContact ? "has-bar" : ""}">
<a class="skip" href="#gallery">דילוג לתמונות</a>
<nav class="top-nav" aria-label="ניווט עליון">
<div class="nav-links">
${(descParagraphs.length > 0 || amenities.length > 0) ? `<a href="#details" class="nav-link">אודות</a>` : ""}
<a href="#gallery" class="nav-link">גלריה</a>
${(hasContact || location) ? `<a href="#contact" class="nav-link">יצירת קשר</a>` : ""}
</div>
<a href="/admin" class="admin-nav-link" title="כניסה למערכת ניהול" aria-label="כניסה למערכת ניהול">
<svg class="admin-nav-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
<span>ניהול</span>
</a>
</nav>
<header class="masthead">
<h1 class="name" translate="no">${esc(name)}</h1>
${location ? `<p class="location-tag">📍 ${esc(location)}</p>` : ""}
${t.subtitle ? `<p class="subtitle">${esc(t.subtitle)}</p>` : ""}
${heroContact}
</header>
${aboutSection}
<section class="gallery-wrapper" aria-labelledby="gallery-title">
<div class="gallery-head">
<h2 class="section-title" id="gallery-title">גלריית תמונות</h2>
</div>
<main id="gallery" tabindex="-1">
${gallery}
</main>
</section>
${footer}
${hasContact ? `<div class="bar" role="navigation" aria-label="יצירת קשר מהיר">${contactLinks.join("")}</div>` : ""}
<dialog class="viewer" aria-label="תצוגת תמונה">
<div class="viewer-top">
<p class="viewer-count" aria-live="polite"></p>
<button type="button" class="viewer-close" data-close>סגירה</button>
</div>
<figure class="viewer-stage">
<img class="viewer-img" alt="">
<figcaption class="viewer-caption"></figcaption>
</figure>
<div class="viewer-nav">
<button type="button" class="viewer-prev" data-step="-1">הקודמת</button>
<button type="button" class="viewer-next" data-step="1">הבאה</button>
</div>
</dialog>
</body>
</html>`;
}

/* ------------------------------------------------------------ Helpers */

function notFound() {
  return new Response(
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>הדף לא נמצא</title><link rel="stylesheet" href="/site.css?v=${HOME_VERSION}"></head><body><main class="notfound"><h1 class="name">הדף לא נמצא</h1><p><a href="/">חזרה לדף הבית</a></p></main></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" } },
  );
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function readJson(request, maxBytes) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
