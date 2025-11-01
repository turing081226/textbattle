import { sql } from '@vercel/postgres';
import { z } from 'zod';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`select * from characters order by id desc limit 200`;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const schema = z.object({
        name: z.string().min(1).max(24),
        description: z.string().min(1).max(100)
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json(parsed.error);

      const { name, description } = parsed.data;
      const { rows } = await sql`
        insert into characters(name, description)
        values (${name.trim()}, ${description.trim()})
        returning *`;
      return res.status(200).json(rows[0]);
    }

    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end('Method Not Allowed');
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
