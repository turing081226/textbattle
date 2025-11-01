import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = Number(url.searchParams.get('id') || '0');
    if (!id) return res.status(400).json({ error: 'id required' });

    const { rows: me } = await sql`select * from characters where id=${id} limit 1`;
    if (!me.length) return res.status(404).json({ error: 'not found' });

    const { rows: battles } = await sql`
      select b.*, ca.name as a_name, cb.name as b_name
      from battles b
      join characters ca on ca.id=b.a_id
      join characters cb on cb.id=b.b_id
      where b.a_id=${id} or b.b_id=${id}
      order by b.created_at desc
      limit 100`;
    res.status(200).json({ user: me[0], battles });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
