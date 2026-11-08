// Stateless signed cookies (HMAC-SHA256 via WebCrypto — same code on Node and Workers).
// The session only holds public profile fields; no osu! tokens are stored anywhere.

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function createSigner(secret) {
  const keyP = crypto.subtle.importKey('raw', enc.encode(`keyfeed-session:${secret || 'insecure-demo-key'}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

  async function sign(obj) {
    const body = b64u(enc.encode(JSON.stringify(obj)));
    const sig = await crypto.subtle.sign('HMAC', await keyP, enc.encode(body));
    return `${body}.${b64u(sig)}`;
  }

  async function verify(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    try {
      const ok = await crypto.subtle.verify('HMAC', await keyP, fromB64u(sig), enc.encode(body));
      if (!ok) return null;
      const obj = JSON.parse(new TextDecoder().decode(fromB64u(body)));
      if (obj.exp && Date.now() > obj.exp) return null;
      return obj;
    } catch {
      return null;
    }
  }

  return { sign, verify };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export const randomState = () => b64u(crypto.getRandomValues(new Uint8Array(18)));
