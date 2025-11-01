import { clearSessionCookie } from '../_lib.js';

export default async function handler(req, res) {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}
