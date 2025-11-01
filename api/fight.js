import { sql } from '@vercel/postgres';
import { z } from 'zod';

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

  // ⚠️ 사용자 프롬프트 원문 그대로 (수정 금지)
  const prompt = `
당신은 두 캐릭터의 가상 시나리올르 해설하는 해설위원입니다. 두 캐릭터의 이름과 설정이 주어집니다.
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

  // REST 호출(의존성 최소화)
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }]}],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 300
        }
      })
    }
  );

  try {
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const raw = JSON.parse(text);

    const schema = z.object({
      winner: z.string().min(1),
      log: z.string().min(1)
    });
    const parsed = schema.parse(raw);

    // 이름 검증
    let winner = parsed.winner;
    if (winner !== nameA && winner !== nameB) winner = 'draw';

    return { winner, log: parsed.log };
  } catch {
    return { winner: 'draw', log: '판정 실패로 무승부 처리' };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).end('Method Not Allowed');
    }

    const body = req.body || {};
    let { my_id, opponent_id } = body;

    // my_id 없으면 옛 방식(완전 랜덤 2명)도 하위호환
    let A, B;
    if (!my_id) {
      const two = await sql`select * from characters order by random() limit 2`;
      if (two.rows.length < 2) return res.status(400).json({ error: '캐릭터가 2명 이상 필요' });
      [A, B] = two.rows;
    } else {
      const { rows: myRows } = await sql`select * from characters where id=${my_id} limit 1`;
      if (!myRows.length) return res.status(400).json({ error: 'my_id 캐릭터를 찾을 수 없음' });
      A = myRows[0];

      if (opponent_id) {
        const { rows: oppRows } = await sql`select * from characters where id=${opponent_id} limit 1`;
        if (!oppRows.length) return res.status(400).json({ error: 'opponent_id 캐릭터를 찾을 수 없음' });
        B = oppRows[0];
      } else {
        const { rows: oppRows } = await sql`
          select * from characters where id <> ${A.id} order by random() limit 1`;
        if (!oppRows.length) return res.status(400).json({ error: '상대 캐릭터가 없습니다(최소 2명 필요)' });
        B = oppRows[0];
      }
    }

    // 판정 (프롬프트 유지)
    const verdict = await judgeBattle(A.name, B.name, A.description, B.description);

    // 승자 매핑
    let winner_id = null;
    if (verdict.winner === A.name) winner_id = A.id;
    else if (verdict.winner === B.name) winner_id = B.id;
    else winner_id = null;

    // 트랜잭션으로 ELO/전적/배틀 기록
    const result = await sql.begin(async (tx) => {
      let aElo = A.elo, bElo = B.elo;
      if (winner_id === A.id) {
        aElo = updateElo(A.elo, B.elo, 1);
        bElo = updateElo(B.elo, A.elo, 0);
        await tx`update characters set wins = wins + 1, elo = ${aElo} where id = ${A.id}`;
        await tx`update characters set losses = losses + 1, elo = ${bElo} where id = ${B.id}`;
      } else if (winner_id === B.id) {
        aElo = updateElo(A.elo, B.elo, 0);
        bElo = updateElo(B.elo, A.elo, 1);
        await tx`update characters set losses = losses + 1, elo = ${aElo} where id = ${A.id}`;
        await tx`update characters set wins = wins + 1, elo = ${bElo} where id = ${B.id}`;
      } else {
        aElo = updateElo(A.elo, B.elo, 0.5);
        bElo = updateElo(B.elo, A.elo, 0.5);
        await tx`update characters set elo = ${aElo} where id = ${A.id}`;
        await tx`update characters set elo = ${bElo} where id = ${B.id}`;
      }

      await tx`
        insert into battles(a_id, b_id, winner_id, reason, log_json)
        values (${A.id}, ${B.id}, ${winner_id}, ${verdict.log}, ${JSON.stringify(verdict.log)})`;

      return { aElo, bElo };
    });

    // 최신 값으로 응답 리프레시
    const { rows: aNow } = await sql`select * from characters where id=${A.id}`;
    const { rows: bNow } = await sql`select * from characters where id=${B.id}`;

    res.status(200).json({
      A: aNow[0],
      B: bNow[0],
      result: {
        winner: verdict.winner,       // 이름 또는 'draw'
        winner_id,                    // 숫자 ID 또는 null
        reason: verdict.log,          // 한 문단 해설
        log: verdict.log              // 문자열
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
