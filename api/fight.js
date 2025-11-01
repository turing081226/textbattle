// api/fight.js 안의 judgeBattle만 교체
import { z } from 'zod';

const VerdictSchema = z.object({
  winner: z.string().min(1),
  log: z.string().min(1)
});

const DEBUG = process.env.LOG_DEBUG === '1';

function t(x, max=300) { // truncate helper
  if (x == null) return '';
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > max ? s.slice(0, max) + '…(truncated)' : s;
}

function dbg(...args) { if (DEBUG) console.log('[fight]', ...args); }
function warn(...args) { console.warn('[fight]', ...args); }
function err(...args) { console.error('[fight]', ...args); }
// =========================

// 백틱/여분 텍스트가 섞여도 JSON만 추출해보는 보조 파서
function tryExtractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  // 코드펜스 제거
  const cleaned = text.replace(/```json|```/gi, '').trim();
  // 바로 파싱 시도
  try { return JSON.parse(cleaned); } catch {}
  // 첫 번째 { ... } 블록만 추출
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

async function judgeBattle(nameA, nameB, descA, descB) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[judgeBattle] GEMINI_API_KEY missing');
    return null;
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

  let resp;
  try {
    resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }]}],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 300,
            // ⬇️ JSON 강제 (지원 모델에서 효과 큼)
            responseMimeType: 'application/json',
            // 선택: 스키마 힌트 (미지원이면 무시됨)
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
    console.error('[judgeBattle] fetch error:', netErr);
    return null;
  }

  let data;
  try {
    data = await resp.json();
  } catch (parseHTTP) {
    console.error('[judgeBattle] http json parse fail:', parseHTTP);
    return null;
  }

  // 안전정책 차단/후보 없음 케이스
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.warn('[judgeBattle] no text candidate:', JSON.stringify(data?.promptFeedback || data));
    return null;
  }

  // JSON 파싱 (느슨하게 복구 시도)
  const raw = tryExtractJSON(text);
  if (!raw) {
    console.warn('[judgeBattle] cannot extract JSON from text:', text);
    return null;
  }

  // 스키마 검증
  let out;
  try {
    out = VerdictSchema.parse(raw);
  } catch (zerr) {
    console.warn('[judgeBattle] schema mismatch:', zerr?.errors, 'raw=', raw);
    return null;
  }

  // 승자 값 검증 (반드시 nameA 또는 nameB)
  if (out.winner !== nameA && out.winner !== nameB) {
    console.warn('[judgeBattle] invalid winner:', out.winner, 'expected:', nameA, nameB);
    return null;
  }

  return out;
}
