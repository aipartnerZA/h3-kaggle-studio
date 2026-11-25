'use strict';

// Minimal multipart/form-data reader, enough for one file field (`kaggle.json`).
// No streaming, no dependencies: the body cap in lib/auth.js already bounds the size.

function parseBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  return m ? (m[1] || m[2] || '').trim() : null;
}

// Returns [{ name, filename, contentType, data:Buffer }] or throws.
function parseMultipart(buf, contentType) {
  const boundary = parseBoundary(contentType);
  if (!boundary) throw new Error('no_boundary');

  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) throw new Error('no_parts');

  while (pos >= 0) {
    pos += delim.length;
    // "--" after a delimiter means the end of the body.
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    if (buf.slice(pos, pos + 2).toString() === '\r\n') pos += 2;
    else if (buf[pos] === 0x0a) pos += 1;

    const next = buf.indexOf(delim, pos);
    if (next < 0) break;
    const chunk = buf.slice(pos, next);
    const headEnd = chunk.indexOf('\r\n\r\n');
    const headEndAlt = chunk.indexOf('\n\n');
    const split = headEnd >= 0 ? headEnd : headEndAlt;
    if (split < 0) { pos = next; continue; }
    const sepLen = headEnd >= 0 ? 4 : 2;
    const headers = chunk.slice(0, split).toString('utf8');
    let data = chunk.slice(split + sepLen);
    // strip the trailing CRLF that belongs to the delimiter
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.slice(0, data.length - 2);
    } else if (data.length >= 1 && data[data.length - 1] === 0x0a) {
      data = data.slice(0, data.length - 1);
    }

    const nameM = /name="([^"]*)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : '',
      contentType: typeM ? typeM[1].trim() : '',
      data,
    });
    pos = next;
  }
  return parts;
}

// The first part that looks like the uploaded file.
function firstFile(parts) {
  return parts.find((p) => p.filename) || parts.find((p) => p.name === 'file') || parts[0] || null;
}

module.exports = { parseMultipart, firstFile, parseBoundary };
