import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import { readJSON, setSessionCookie } from '../_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']); return res.status(405).end('Method Not Allowed');
  }
  try {
    const { name, password } = await readJSON(req);
    const { rows } = await sql`select * from characters where name=${name} limit 1`;
    if (!rows.length) return res.status(401).json({ error: 'invalid credentials' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    setSessionCookie(res, { id: user.id, name: user.name });
    res.status(200).json({ ok: true, user: { id: user.id, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
