import jwt from 'jsonwebtoken';

export async function readJSON(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function setSessionCookie(res, payload) {
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
  const isLocal = (typeof window === 'undefined') && (process.env.VERCEL === '1' ? false : true);
  const secure = isLocal ? '' : 'Secure; ';
  res.setHeader('Set-Cookie',
    `session=${token}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=${7*24*3600}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

export function getUserFromCookie(req) {
  try {
    const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('session='));
    if (!cookie) return null;
    const token = decodeURIComponent(cookie.split('=')[1]);
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch { return null; }
}

export function secondsUntil(ts) {
  const diff = Math.ceil((ts - Date.now()) / 1000);
  return diff > 0 ? diff : 0;
}
