import { sql, db } from '@vercel/postgres';
import { z } from 'zod';
import { getUserFromCookie, secondsUntil } from './_lib.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEBUG = process.env.LOG_DEBUG === '1';

// ── logger utils ──
function t(x, max = 300) {
  if (x == null) return '';
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > max ? s.slice(0, max) + '…(truncated)' : s;
}
function dbg(...args) { if (DEBUG) console.log('[fight]', ...args); }
function warn(...args) { console.warn('[fight]', ...args); }
function err(...args) { console.error('[fight]', ...args); }

// ── Elo ──
function updateElo(current, opponent, score) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (opponent - current) / 400));
  return Math.round(current + K * (score - expected));
}

// ── 무승부 없는 결정적 fallback ──
function fallbackVerdict(A, B) {
  let winner = A;
  if (B.elo > A.elo) winner = B;
  else if (B.elo === A.elo && B.id < A.id) winner = B;
  const log = `${A.name}와 ${B.name}의 접전! ${winner.name}이(가) 결정타로 승리했다.`;
  return { winnerName: winner.name, winnerId: winner.id, log };
}

// ── Gemini 판정 (프롬프트 그대로) ──
const VerdictSchema = z.object({ winner: z.string().min(1), log: z.string().min(1) });

async function judgeBattle(nameA, nameB, descA, descB) {
  if (!GEMINI_API_KEY) { warn('GEMINI_API_KEY missing'); return null; }

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

  dbg('Gemini request start', { A: nameA, B: nameB });

  let resp;
  try {
    resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }]}],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 300,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                winner: { type: 'string' },
                log: { type: 'string' }
              },
              required: ['winner','log']
            }
          }
        })
      }
    );
  } catch (netErr) {
    err('fetch error', netErr?.message || netErr);
    return null;
  }

  dbg('Gemini HTTP status', resp.status);

  let data;
  try {
    data = await resp.json();
  } catch (parseHTTP) {
    err('response JSON parse fail', parseHTTP?.message || parseHTTP);
    return null;
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    warn('no candidate text', t(data?.promptFeedback || data));
    return null;
  }
  dbg('candidate text', t(text, 200));

  // 코드펜스 제거 + {} 블록 파싱
  let raw;
  try {
    const cleaned = text.replace(/```json|```/gi, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    raw = JSON.parse(m ? m[0] : cleaned);
  } catch (pe) {
    warn('candidate not valid JSON', t(text));
    return null;
  }

  try {
    const out = VerdictSchema.parse(raw);
    if (out.winner !== nameA && out.winner !== nameB) {
      warn('invalid winner', out.winner, 'expected', nameA, nameB);
      return null;
    }
    dbg('Gemini verdict OK', { winner: out.winner });
    return out;
  } catch (zerr) {
    warn('schema mismatch', zerr?.errors, 'raw=', raw);
    return null;
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

    const { rows: myRows } = await sql`select * from characters where id=${s.id} limit 1`;
    if (!myRows.length) return res.status(401).json({ error: 'login required' });
    const A = myRows[0];

    const { rows: last } = await sql`
      select created_at from battles where a_id=${A.id} or b_id=${A.id}
      order by created_at desc limit 1`;
    if (last.length) {
      const nextAt = new Date(last[0].created_at).getTime() + 60_000;
      const remain = secondsUntil(nextAt);
      if (remain > 0) return res.status(429).json({ error: 'cooldown', remain });
    }

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

    // 판정
    let winnerName, winnerId, logText, verdictSource = 'gemini', fallbackReason = null;
    const verdict = await judgeBattle(A.name, B.name, A.description, B.description);
    if (verdict) {
      winnerName = verdict.winner;
      winnerId = (winnerName === A.name) ? A.id : B.id;
      logText = verdict.log;
    } else {
      verdictSource = 'fallback';
      const fb = fallbackVerdict(A, B);
      winnerName = fb.winnerName;
      winnerId = fb.winnerId;
      logText = fb.log;
      fallbackReason = 'gemini_parse_or_policy_or_network';
      warn('fallback used', { A: A.id, B: B.id, reason: fallbackReason });
    }

    // 트랜잭션 (sql.begin 미사용 버전)
    const client = await db.connect();
    try {
      await client.sql`BEGIN`;
      if (winnerId === A.id) {
        const aE = updateElo(A.elo, B.elo, 1);
        const bE = updateElo(B.elo, A.elo, 0);
        await client.sql`update characters set wins=wins+1, elo=${aE} where id=${A.id}`;
        await client.sql`update characters set losses=losses+1, elo=${bE} where id=${B.id}`;
      } else {
        const aE = updateElo(A.elo, B.elo, 0);
        const bE = updateElo(B.elo, A.elo, 1);
        await client.sql`update characters set losses=losses+1, elo=${aE} where id=${A.id}`;
        await client.sql`update characters set wins=wins+1, elo=${bE} where id=${B.id}`;
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

    const { rows: aNow } = await sql`select * from characters where id=${A.id}`;
    const { rows: bNow } = await sql`select * from characters where id=${B.id}`;

    res.status(200).json({
      A: aNow[0],
      B: bNow[0],
      result: {
        winner: winnerName,
        winner_id: winnerId,
        reason: logText,
        log: logText,
        verdict_source: verdictSource,
        fallback_reason: fallbackReason
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
