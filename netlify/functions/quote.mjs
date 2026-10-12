const ALLOWED = /^[A-Z0-9._-]{1,15}$/;
const FETCH_TIMEOUT_MS = 9000;
const CROSSCHECK_LIMIT_PCT = 1.0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'access-control-allow-origin': '*'
    }
  });
}

function cleanSymbol(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\.O$/i, '');
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
        'accept': options.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...(options.headers || {})
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const r = await fetchText(url, { ...options, accept: 'application/json' });
  return JSON.parse(r.text);
}

function numberFrom(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function getNaver(symbol, logs) {
  const url = `https://api.stock.naver.com/stock/${encodeURIComponent(symbol)}.O/basic`;
  try {
    const { text } = await fetchText(url, { timeout: 7000, accept: 'application/json' });
    const j = JSON.parse(text);
    const close = numberFrom(j.closePrice);
    const delta = numberFrom(j.compareToPreviousClosePrice);
    if (!(close > 0) || delta == null) throw new Error('closePrice/compareToPreviousClosePrice missing');
    logs.push({ source: 'Naver', message: `서버 직접 호출 성공 · ${close.toFixed(2)} / 전일대비 ${delta.toFixed(2)}` });
    return { price: close, previousClose: close - delta };
  } catch (e) {
    logs.push({ source: 'Naver', message: `실패: ${e.message}` });
    return null;
  }
}

async function getGoogle(symbol, logs) {
  const url = `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:NASDAQ`;
  try {
    const { text } = await fetchText(url, { timeout: 9000, accept: 'text/html,application/xhtml+xml' });
    const patterns = [
      /class="YMlKec fxKbKc"[^>]*>([^<]+)/,
      /data-last-price="([0-9.,]+)"/,
      /"price":"([0-9.,]+)"/
    ];
    let price = null;
    for (const re of patterns) {
      const m = text.match(re);
      if (m) { price = numberFrom(m[1]); if (price > 0) break; }
    }
    if (!(price > 0)) throw new Error('가격 DOM 패턴을 찾지 못함');
    logs.push({ source: 'Google', message: `서버 직접 호출 성공 · ${price.toFixed(2)}` });
    return { price };
  } catch (e) {
    logs.push({ source: 'Google', message: `실패: ${e.message}` });
    return null;
  }
}

async function getYahooHistory(symbol, logs) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d&events=history`;
  try {
    const j = await fetchJson(url, { timeout: 8000 });
    const r = j?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const q = r?.indicators?.quote?.[0];
    if (!q) throw new Error('OHLC payload missing');
    const hist = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if ([o,h,l,c].every(Number.isFinite)) hist.push({ t: ts[i], o, h, l, c });
    }
    if (hist.length < 20) throw new Error(`OHLC ${hist.length}개`);
    logs.push({ source: 'OHLC', message: `Yahoo Chart 서버 호출 성공 · ${hist.length}개 일봉` });
    return { history: hist.slice(-60), quoteDate: new Date(hist.at(-1).t * 1000).toISOString().slice(0,10) };
  } catch (e) {
    logs.push({ source: 'OHLC', message: `실패: ${e.message}` });
    return null;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));
  const logs = [];
  const fetchedAt = new Date().toISOString();

  if (!ALLOWED.test(symbol)) return json({ ok: false, error: '유효하지 않은 symbol 입니다.', logs }, 400);

  const [naver, google, history] = await Promise.all([
    getNaver(symbol, logs),
    getGoogle(symbol, logs),
    getYahooHistory(symbol, logs)
  ]);

  if (!naver || !google) {
    return json({
      ok: false,
      error: 'Naver + Google 양쪽 교차검증을 완료하지 못했습니다. 데이터 지연으로 인한 확인 불가',
      logs,
      fetchedAt
    }, 503);
  }

  const differencePct = Math.abs(naver.price - google.price) / google.price * 100;
  const status = differencePct < CROSSCHECK_LIMIT_PCT ? 'PASS' : 'WARNING';

  // 안전 원칙: 양쪽 성공 + 1% 미만일 때만 매매 계산 허용.
  // 불일치 시 임의로 높은/낮은 가격을 채택하지 않습니다.
  const price = naver.price;
  const previousClose = naver.previousClose;

  return json({
    ok: true,
    fetchedAt,
    quote: {
      symbol,
      price,
      previousClose,
      quoteDate: history?.quoteDate || null,
      history: history?.history || [],
      historySource: history ? 'Yahoo Finance Chart (server-side diagnostic)' : null,
      crossCheck: {
        status,
        differencePct,
        thresholdPct: CROSSCHECK_LIMIT_PCT,
        naverPrice: naver.price,
        googlePrice: google.price,
        tradeAllowed: status === 'PASS'
      }
    },
    logs
  });
};

export const config = { path: '/api/quote' };
