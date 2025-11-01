import { sql, db } from '@vercel/postgres';
import { z } from 'zod';
import { getUserFromCookie, secondsUntil } from './_lib.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function updateElo(current, opponent, score) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (opponent - current) / 400));
  return Math.round(current + K * (score - expected));
}

// 무조건 승자를 정하는 결정적 fallback
function fallbackVerdict(A, B) {
  // 우선순위: 높은 ELO > (동률 시) id가 작은 쪽
  let winner = A;
  if (B.elo > A.elo) winner = B;
  else if (B.elo === A.elo && B.id < A.id) winner = B;

  const loser = (winner.id === A.id) ? B : A;
  const log = `${A.name}와 ${B.name}의 팽팽한 접전! ${winner.name}이(가) 결정타를 적중시키며 승리했다.`;
  return { winnerName: winner.name, winnerId: winner.id, log };
}

async function judgeBattle(nameA, nameB, descA, descB) {
  // 키가 없거나 호출 불가 → null을 반환해서 fallback 사용
  if (!GEMINI_API_KEY) return null;

  // ⚠️ 사용자 제공 프롬프트 그대로 사용
  const prompt = `
당신은 두 캐릭터의 가상 시나리오를 해설하는 해설위원입니다. 두 캐릭터의 이름과 설정이 주어집니다. 
- "${nameA}": "${descA}"
- "${nameB}": "${descB}"

규칙:
1) 100자 내외로 흥미진진한 둘의 전투를 중계하세요.
2) 승자를 '${nameA}', '${nameB}' 중 하나로 결정하세요.
3) 창의성, 상호 카운터 가능성, 설정의 논리성을 기준으로 판단하세요.
4) 유해/불법/혐오/성적 묘사는 금지합니다.
5) 아래 JSON 형태로만 응답하세요. 설명 문구 없이.
{
  "winner": "${nameA}" | "${nameB}",
  "log": "중계"
}
  `.trim();

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }]}],
        generationConfig: { temperature: 0.4, maxOutputTokens: 300 }
      })
    }
  );

  try {
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const raw = JSON.parse(text);
    const schema = z.object({ winner: z.string().min(1), log: z.string().min(1) });
    const out = schema.parse(raw);
    return out; // 여기서 winner는 nameA 또는 nameB 라고 가정
  } catch {
    return null; // 파싱/포맷 에러 → fallback
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']); return res.status(405).end('Method Not Allowed');
  }
  try {
    const s = getUserFromCookie(req);
    if (!s) return res.status(401).json({ error: 'login required' });
    if (s.role !== 'character' || !s.id) return res.status(403).json({ error: 'character only' });

    // 내 캐릭터
    const { rows: myRows } = await sql`select * from characters where id=${s.id} limit 1`;
    if (!myRows.length) return res.status(401).json({ error: 'login required' });
    const A = myRows[0];

    // 1분 쿨다운 (서버 강제)
    const { rows: last } = await sql`
      select created_at from battles where a_id=${A.id} or b_id=${A.id}
      order by created_at desc limit 1`;
    if (last.length) {
      const nextAt = new Date(last[0].created_at).getTime() + 60_000;
      const remain = secondsUntil(nextAt);
      if (remain > 0) return res.status(429).json({ error: 'cooldown', remain });
    }

    // 이전에 싸운 적 없는 상대
    const { rows: opp } = await sql`
      select * from characters c
      where c.id <> ${A.id}
      and not exists (
        select 1 from battles b
        where (b.a_id=${A.id} and b.b_id=c.id) or (b.a_id=c.id and b.b_id=${A.id})
      )
      order by random()
      limit 1`;
    if (!opp.length) return res.status(409).json({ error: 'no available opponent' });
    const B = opp[0];

    // ── 판정 시도 (항상 승자 결정) ──
    let winnerName, winnerId, logText;

    const verdict = await judgeBattle(A.name, B.name, A.description, B.description);
    if (verdict && (verdict.winner === A.name || verdict.winner === B.name)) {
      // 모델이 정한 승자 그대로
      winnerName = verdict.winner;
      winnerId = (winnerName === A.name) ? A.id : B.id;
      logText = verdict.log;
    } else {
      // 모델 실패/이상 응답 → 결정적 fallback
      const fb = fallbackVerdict(A, B);
      winnerName = fb.winnerName;
      winnerId = fb.winnerId;
      logText = fb.log;
    }

    // ===== 트랜잭션: 전용 커넥션으로 BEGIN/COMMIT =====
    const client = await db.connect();
    try {
      await client.sql`BEGIN`;

      let aElo = A.elo, bElo = B.elo;
      if (winnerId === A.id) {
        aElo = updateElo(A.elo, B.elo, 1);
        bElo = updateElo(B.elo, A.elo, 0);
        await client.sql`update characters set wins=wins+1, elo=${aElo} where id=${A.id}`;
        await client.sql`update characters set losses=losses+1, elo=${bElo} where id=${B.id}`;
      } else {
        aElo = updateElo(A.elo, B.elo, 0);
        bElo = updateElo(B.elo, A.elo, 1);
        await client.sql`update characters set losses=losses+1, elo=${aElo} where id=${A.id}`;
        await client.sql`update characters set wins=wins+1, elo=${bElo} where id=${B.id}`;
      }

      await client.sql`
        insert into battles(a_id, b_id, winner_id, reason, log_json)
        values (${A.id}, ${B.id}, ${winnerId}, ${logText}, ${JSON.stringify(logText)})`;

      await client.sql`COMMIT`;
    } catch (txErr) {
      try { await client.sql`ROLLBACK`; } catch {}
      throw txErr;
    } finally {
      client.release();
    }
    // ===============================================

    // 최신 값 조회
    const { rows: aNow } = await sql`select * from characters where id=${A.id}`;
    const { rows: bNow } = await sql`select * from characters where id=${B.id}`;

    res.status(200).json({
      A: aNow[0],
      B: bNow[0],
      result: { winner: winnerName, winner_id: winnerId, reason: logText, log: logText }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
