import { sql } from '@vercel/postgres';
import { z } from 'zod';
import { getUserFromCookie, secondsUntil } from './_lib.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function updateElo(current, opponent, score) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (opponent - current) / 400));
  return Math.round(current + K * (score - expected));
}

async function judgeBattle(nameA, nameB, descA, descB) {
  if (!GEMINI_API_KEY) {
    return { winner: 'draw', log: '키 미설정으로 무승부 처리' };
  }
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
    if (out.winner !== nameA && out.winner !== nameB) return { winner: 'draw', log: out.log };
    return out;
  } catch {
    return { winner: 'draw', log: '판정 실패로 무승부 처리' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']); return res.status(405).end('Method Not Allowed');
  }
  try {
    const me = getUserFromCookie(req);
    if (!me) return res.status(401).json({ error: 'login required' });

    // 내 캐릭터
    const { rows: myRows } = await sql`select * from characters where id=${me.id} limit 1`;
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

    // 이전에 싸운 적 없는 상대를 랜덤 선택
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

    // 판정 (프롬프트 그대로)
    const verdict = await judgeBattle(A.name, B.name, A.description, B.description);
    let winner_id = null;
    if (verdict.winner === A.name) winner_id = A.id;
    else if (verdict.winner === B.name) winner_id = B.id;
    else winner_id = null;

    // 트랜잭션: 전적/ELO 갱신 + 배틀 기록 (유니크 쌍 보장)
    const result = await sql.begin(async (tx) => {
      let aElo = A.elo, bElo = B.elo;
      if (winner_id === A.id) {
        aElo = updateElo(A.elo, B.elo, 1);
        bElo = updateElo(B.elo, A.elo, 0);
        await tx`update characters set wins = wins + 1, elo = ${aElo} where id=${A.id}`;
        await tx`update characters set losses = losses + 1, elo = ${bElo} where id=${B.id}`;
      } else if (winner_id === B.id) {
        aElo = updateElo(A.elo, B.elo, 0);
        bElo = updateElo(B.elo, A.elo, 1);
        await tx`update characters set losses = losses + 1, elo = ${aElo} where id=${A.id}`;
        await tx`update characters set wins = wins + 1, elo = ${bElo} where id=${B.id}`;
      } else {
        aElo = updateElo(A.elo, B.elo, 0.5);
        bElo = updateElo(B.elo, A.elo, 0.5);
        await tx`update characters set elo = ${aElo} where id=${A.id}`;
        await tx`update characters set elo = ${bElo} where id=${B.id}`;
      }

      await tx`
        insert into battles(a_id, b_id, winner_id, reason, log_json)
        values (${A.id}, ${B.id}, ${winner_id}, ${verdict.log}, ${JSON.stringify(verdict.log)})`;

      return { aElo, bElo };
    });

    // 최신 값으로 응답
    const { rows: aNow } = await sql`select * from characters where id=${A.id}`;
    const { rows: bNow } = await sql`select * from characters where id=${B.id}`;

    res.status(200).json({
      A: aNow[0],
      B: bNow[0],
      result: {
        winner: verdict.winner,
        winner_id,
        reason: verdict.log,
        log: verdict.log
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
