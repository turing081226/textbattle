import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  try {
    const { rows } = await sql`
      select * from characters
      order by elo desc, wins desc
      limit 50`;
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
