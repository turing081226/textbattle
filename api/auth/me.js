import { sql } from '@vercel/postgres';
import { getUserFromCookie } from '../_lib.js';

export default async function handler(req, res) {
  const me = getUserFromCookie(req);
  if (!me) return res.status(200).json({ user: null });

  const { rows } = await sql`select * from characters where id=${me.id} limit 1`;
  if (!rows.length) return res.status(200).json({ user: null });
  res.status(200).json({ user: rows[0] });
}
