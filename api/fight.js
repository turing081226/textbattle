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
    warn('GEMINI_API_KEY missing');
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

  dbg('Gemini request start', { A: nameA, B: nameB });

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
            responseMimeType: 'application/json'
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

  // 후보 텍스트 샘플(앞부분만)
  dbg('candidate text', t(text, 200));

  // JSON 추출 & 검증
  let raw;
  try {
    // 코드펜스 제거 + 첫 {} 블록만 파싱
    const cleaned = text.replace(/```json|```/gi, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    raw = JSON.parse(m ? m[0] : cleaned);
  } catch (pe) {
    warn('candidate not valid JSON', t(text));
    return null;
  }

  if (typeof raw?.winner !== 'string' || typeof raw?.log !== 'string') {
    warn('schema mismatch', raw);
    return null;
  }
  if (raw.winner !== nameA && raw.winner !== nameB) {
    warn('invalid winner', raw.winner, 'expected', nameA, nameB);
    return null;
  }

  dbg('Gemini verdict OK', { winner: raw.winner });
  return raw;
}

