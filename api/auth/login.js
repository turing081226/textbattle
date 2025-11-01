import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import { readJSON, setSessionCookie } from '../_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']); return res.status(405).end('Method Not Allowed');
  }
  try {
    const { name, password } = await readJSON(req);

    // 1) admin(users) 로그인 시도
    const u = await sql`select * from users where name=${name} limit 1`;
    if (u.rows.length) {
      const user = u.rows[0];
      const ok = await bcrypt.compare(password, user.password_hash || '');
      if (!ok) return res.status(401).json({ error: 'invalid credentials' });
      setSessionCookie(res, { role: user.role, name: user.name }); // admin은 id 불필요
      return res.status(200).json({ ok: true, role: user.role, user: { name: user.name } });
    }

    // 2) 일반 캐릭터 로그인 시도
    const c = await sql`select * from characters where name=${name} limit 1`;
    if (!c.rows.length) return res.status(401).json({ error: 'invalid credentials' });
    const ch = c.rows[0];
    const ok = await bcrypt.compare(password, ch.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    setSessionCookie(res, { role: 'character', id: ch.id, name: ch.name });
    res.status(200).json({ ok: true, role: 'character', user: { id: ch.id, name: ch.name } });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
