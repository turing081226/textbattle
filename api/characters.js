import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { readJSON, setSessionCookie, getUserFromCookie } from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`select * from characters order by id desc limit 200`;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      // admin 전용
      const s = getUserFromCookie(req);
      if (!s || s.role !== 'admin') return res.status(403).json({ error: 'admin only' });

      const body = await readJSON(req);
      const schema = z.object({
        name: z.string().min(1).max(24),
        description: z.string().min(1).max(100),
        password: z.string().min(4).max(128),
        // 🔧 (신규) 선택 입력
        email: z.string().email().optional(),
        phone: z.string().min(7).max(32).optional()
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return res.status(400).json(parsed.error);

      const { name, description, password, email, phone } = parsed.data;
      const password_hash = await bcrypt.hash(password, 10);

      const { rows } = await sql`
        insert into characters(name, description, password_hash, email, phone)
        values (${name.trim()}, ${description.trim()}, ${password_hash}, ${email ?? null}, ${phone ?? null})
        returning *`;
      const user = rows[0];

      // 생성 직후 캐릭터로 세션 전환
      setSessionCookie(res, { role: 'character', id: user.id, name: user.name });
      return res.status(200).json(user);
    }

    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end('Method Not Allowed');
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
