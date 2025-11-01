import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { readJSON, setSessionCookie } from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`select * from characters order by id desc limit 200`;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const body = await readJSON(req);
      const schema = z.object({
        name: z.string().min(1).max(24),
        description: z.string().min(1).max(100)
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return res.status(400).json(parsed.error);
      const { name, description } = parsed.data;

      const passwordPlain = 'Neuron';  // 요구사항
      const password_hash = await bcrypt.hash(passwordPlain, 10);

      const { rows } = await sql`
        insert into characters(name, description, password_hash)
        values (${name.trim()}, ${description.trim()}, ${password_hash})
        returning *`;
      const user = rows[0];

      // 생성 즉시 로그인 전환 (Admin → 캐릭터 세션)
      setSessionCookie(res, { id: user.id, name: user.name });
      return res.status(200).json(user);
    }

    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end('Method Not Allowed');
  } catch (e) {
    // 유니크 위반 등
    res.status(500).json({ error: String(e) });
  }
}
