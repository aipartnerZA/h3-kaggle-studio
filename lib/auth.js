'use strict';

// Request guards from SPEC §7 (Origin, body cap, image magic bytes) and the
// exact user-facing validation strings from §8.2.

function checkOrigin(req, config) {
  const origin = req.headers && req.headers.origin;
  const allowed = new Set([
    ...(config.allowed_origins || []),
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  if (!origin || !allowed.has(origin)) {
    return { ok: false, status: 403, error: 'Origin check failed (same-origin only).' };
  }
  return { ok: true };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        settled = true;
        const e = new Error('Request body too large.');
        e.status = 413;
        reject(e);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

function imageFromBase64(value, n, config) {
  if (value == null || value === '') return { ok: true, image: null };
  let b64 = String(value);
  const comma = b64.indexOf(',');
  if (/^data:[^;]+;base64,/i.test(b64)) b64 = b64.slice(comma + 1);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return {
    ok: false, status: 422,
    error: `Slot ${n}: only JPG, PNG or WEBP images are accepted.`,
  };
  let buf;
  try { buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64'); } catch (e) {
    return { ok: false, status: 422, error: `Slot ${n}: only JPG, PNG or WEBP images are accepted.` };
  }
  if (!buf.length) return {
    ok: false, status: 422, error: `Slot ${n}: only JPG, PNG or WEBP images are accepted.`,
  };
  if (buf.length > config.image_max_bytes) {
    return {
      ok: false, status: 413,
      error: `Image for slot ${n} is ${(buf.length / 1048576).toFixed(1)} MB; the limit is 3 MB.`,
    };
  }
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
  else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) return {
    ok: false, status: 422,
    error: `Slot ${n}: only JPG, PNG or WEBP images are accepted.`,
  };
  return { ok: true, image: { bytes: buf, ext } };
}

function validateSlots(body, config) {
  const slots = body && body.slots;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > config.max_slots) {
    return { ok: false, status: 422, error: `Provide 1 to ${config.max_slots} slots.` };
  }
  const seen = new Set();
  const out = [];
  for (const raw of slots) {
    const n = Number(raw && raw.n);
    if (!Number.isInteger(n) || n < 1 || n > config.max_slots || seen.has(n)) {
      return { ok: false, status: 422, error: `Slot number ${String(raw && raw.n)} is invalid or duplicated.` };
    }
    seen.add(n);
    const prompt = String((raw && raw.prompt) || '').trim();
    if (!prompt) {
      return { ok: false, status: 422, error: `Prompt is required for slot ${n}.` };
    }
    if (prompt.length > config.prompt_max_chars) {
      return { ok: false, status: 422, error: `Prompt is too long for slot ${n} (max ${config.prompt_max_chars} characters).` };
    }
    const seconds = Number(raw && raw.seconds);
    if (!Number.isInteger(seconds) || seconds < config.seconds_min || seconds > config.seconds_max) {
      return { ok: false, status: 422, error: `Seconds must be a whole number from ${config.seconds_min} to ${config.seconds_max} for slot ${n}.` };
    }
    const img = imageFromBase64(raw && raw.image_base64, n, config);
    if (!img.ok) return img;
    out.push({
      n,
      id: `s${n}_scene`,
      prompt,
      seconds,
      seed: 813001 + n - 1,
      image: null,
      image_name: null,
      image_bytes: 0,
      _image: img.image,
    });
  }
  return { ok: true, slots: out };
}

// Log tails must never leak a token (SPEC §11).
function scrub(text) {
  return String(text || '').replace(/[A-Za-z0-9_-]{40,}/g, '…');
}

module.exports = { checkOrigin, readBody, imageFromBase64, validateSlots, scrub };
