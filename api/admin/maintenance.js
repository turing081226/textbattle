import { sql, db } from '@vercel/postgres';
import { getUserFromCookie, readJSON } from '../_lib.js';

// 간단한 응답 헬퍼
function ok(res, data = {}) { res.status(200).json({ ok: true, ...data }); }
function bad(res, msg) { res.status(400).json({ ok: false, error: msg }); }
function forbid(res) { res.status(403).json({ ok: false, error: 'admin only' }); }
function err(res, e) { res.status(500).json({ ok: false, error: String(e) }); }

export default async function handler(req, res) {
  // 관리자만 수행 가능
  const s = getUserFromCookie(req);
  if (!s || s.role !== 'admin') return forbid(res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return bad(res, 'Use POST with JSON body: { action, confirm? }');
  }

  try {
    const body = await readJSON(req);
    const action = String(body?.action || '');
    const confirm = String(body?.confirm || '');

    // 위험 작업일수록 확인 문구 요구
    const needConfirm = (a) => ['wipeAll', 'dropAll', 'resetRatings'].includes(a);
    if (needConfirm(action) && confirm !== 'YES') {
      return bad(res, `Dangerous operation. Provide { "confirm": "YES" }`);
    }

    // 선택: 백업용 suffix
    const suffix = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 12); // yyyymmddHHMM

    switch (action) {
      case 'status': {
        const { rows: c } = await sql`select count(*)::int as n from characters`;
        const { rows: b } = await sql`select count(*)::int as n from battles`;
        return ok(res, { characters: c[0].n, battles: b[0].n });
      }

      case 'backup': {
        // 백업 테이블 생성(이미 있으면 실패하니 날짜 suffix로 생성)
        await sql`CREATE TABLE ${sql.raw(`characters_backup_${suffix}`)} AS TABLE characters`;
        await sql`CREATE TABLE ${sql.raw(`battles_backup_${suffix}`)}    AS TABLE battles`;
        return ok(res, { backups: [`characters_backup_${suffix}`, `battles_backup_${suffix}`] });
      }

      case 'clearBattles': {
        const { rowCount } = await sql`DELETE FROM battles`;
        return ok(res, { deleted_battles: rowCount });
      }

      case 'resetRatings': {
        const client = await db.connect();
        try {
          await client.sql`BEGIN`;
          await client.sql`UPDATE characters SET elo = 1000, wins = 0, losses = 0`;
          await client.sql`DELETE FROM battles`;
          await client.sql`COMMIT`;
        } catch (e) {
          try { await client.sql`ROLLBACK`; } catch {}
          throw e;
        } finally {
          client.release();
        }
        return ok(res, { done: true });
      }

      case 'wipeAll': {
        const client = await db.connect();
        try {
          await client.sql`BEGIN`;
          await client.sql`TRUNCATE TABLE battles`;
          await client.sql`TRUNCATE TABLE characters RESTART IDENTITY`;
          await client.sql`COMMIT`;
        } catch (e) {
          try { await client.sql`ROLLBACK`; } catch {}
          throw e;
        } finally {
          client.release();
        }
        return ok(res, { done: true });
      }

      case 'dropAll': {
        // 테이블 자체를 제거(이후 /api/init을 다시 호출해야 함)
        // 순서 주의: FK 때문에 battles부터
        await sql`DROP TABLE IF EXISTS battles`;
        await sql`DROP TABLE IF EXISTS characters`;
        // users는 보통 유지하지만, 정말 비우려면 다음 라인 주석 해제
        // await sql`DROP TABLE IF EXISTS users`;
        return ok(res, { dropped: ['battles','characters'] });
      }

      case 'deleteCharacter': {
        // 특정 캐릭터만 삭제 (body.name 또는 body.id 필요)
        const id = body?.id ? Number(body.id) : null;
        const name = body?.name ? String(body.name) : null;
        if (!id && !name) return bad(res, 'require id or name');
        if (name) {
          const { rowCount } = await sql`DELETE FROM characters WHERE name = ${name}`;
          return ok(res, { deleted_by_name: rowCount });
        } else {
          const { rowCount } = await sql`DELETE FROM characters WHERE id = ${id}`;
          return ok(res, { deleted_by_id: rowCount });
        }
      }

      default:
        return bad(res, `Unknown action: ${action}`);
    }
  } catch (e) {
    return err(res, e);
  }
}
