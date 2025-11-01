import { sql } from '@vercel/postgres';
import { getUserFromCookie } from '../_lib.js';

export default async function handler(req, res) {
  const s = getUserFromCookie(req);
  if (!s) return res.status(200).json({ user: null, role: null });

  if (s.role === 'admin') {
    return res.status(200).json({ user: { name: s.name }, role: 'admin' });
  }
  if (s.role === 'character' && s.id) {
    const { rows } = await sql`select * from characters where id=${s.id} limit 1`;
    if (!rows.length) return res.status(200).json({ user: null, role: null });
    return res.status(200).json({ user: rows[0], role: 'character' });
  }
  return res.status(200).json({ user: null, role: null });
}
