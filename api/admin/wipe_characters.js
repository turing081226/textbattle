import { db } from '@vercel/postgres';
import { getUserFromCookie, readJSON } from '../_lib.js';

export default async function handler(req, res) {
  // 관리자 세션 확인
  const s = getUserFromCookie(req);
  if (!s || s.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'admin only' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const body = await readJSON(req);
    if (String(body?.confirm) !== 'YES') {
      return res.status(400).json({ ok: false, error: 'Provide { "confirm": "YES" } to proceed' });
    }

    const client = await db.connect();
    try {
      await client.sql`BEGIN`;
      // characters를 TRUNCATE하면 FK로 연결된 battles도 함께 정리(CASCADE)
      await client.sql`TRUNCATE TABLE characters RESTART IDENTITY CASCADE`;
      await client.sql`COMMIT`;
    } catch (e) {
      try { await client.sql`ROLLBACK`; } catch {}
      throw e;
    } finally {
      client.release();
    }

    return res.status(200).json({ ok: true, message: 'All characters deleted (and cascaded battles cleared).' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
