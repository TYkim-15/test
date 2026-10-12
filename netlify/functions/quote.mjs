const ALLOWED = /^[A-Z0-9._-]{1,15}$/;
const FETCH_TIMEOUT_MS = 9000;
const RETRIES = 2;
const CROSSCHECK_LIMIT_PCT = 1.0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "access-control-allow-origin": "*"
    }
  });
}

function cleanSymbol(raw) {
  return String(raw || "").trim().toUpperCase().replace(/\.O$/i, "");
}

function numberFrom(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, "").replace(/−/g, "-");
  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url, options = {}) {
  const timeout = options.timeout ?? FETCH_TIMEOUT_MS;
  let lastError = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        cache: "no-store",
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
          "accept-language": "en-US,en;q=0.9,ko;q=0.8",
          "accept": options.accept || "text/html,application/json;q=0.9,*/*;q=0.8",
          ...(options.headers || {})
        }
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text, status: res.status, attempt: attempt + 1 };
    } catch (e) {
      lastError = e?.name === "AbortError" ? `timeout ${timeout}ms` : e.message;
      if (attempt < RETRIES) await sleep(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || "request failed");
}

async function fetchJson(url, options = {}) {
  const r = await fetchText(url, { ...options, accept: "application/json" });
  return JSON.parse(r.text);
}

function parseNaver(text) {
  const j = JSON.parse(text);
  const close = numberFrom(j.closePrice);
  const delta = numberFrom(j.compareToPreviousClosePrice);
  const ratio = numberFrom(j.fluctuationsRatio);
  if (!(close > 0) || delta == null) throw new Error("closePrice/compareToPreviousClosePrice missing");

  const tradedAt = j.localTradedAt || j.localDate || null;
  return {
    price: close,
    change: delta,
    changePct: ratio,
    previousClose: close - delta,
    currency: "USD",
    market: "NASDAQ",
    tradedAt,
    marketStatus: j.marketStatus || null,
    timestampSource: tradedAt ? "NAVER_LOCAL_TRADED_AT" : "RECEIVED_AT"
  };
}

async function getNaver(symbol, logs) {
  const url = `https://api.stock.naver.com/stock/${encodeURIComponent(symbol)}.O/basic`;
  try {
    const { text, attempt } = await fetchText(url, {
      timeout: 7000,
      accept: "application/json"
    });
    const data = parseNaver(text);
    logs.push({
      source: "Naver",
      message: `서버 직접 호출 성공 · ${data.price.toFixed(2)} USD / 전일대비 ${data.change.toFixed(2)} USD / ${data.changePct == null ? "등락률 확인불가" : data.changePct.toFixed(2) + "%"} · attempt ${attempt}`
    });
    return data;
  } catch (e) {
    logs.push({ source: "Naver", message: `실패: ${e.message}` });
    return null;
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * Google Finance is not an official machine-readable quote API.
 * Parsing order:
 *   1) itemprop/meta structured data
 *   2) stable-ish visible price class
 *   3) embedded AF_initDataCallback quote array
 *   4) data/aria/json attributes
 *
 * Deliberately removed the old broad "$..." context fallback. It could
 * select an unrelated dollar value from the page and create a false quote.
 */
function parseGooglePrice(html, symbol) {
  const safeSymbol = escapeRegExp(symbol);

  const metaPrice = html.match(/<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']price["'][^>]*>/i);
  if (metaPrice) {
    const price = numberFrom(metaPrice[1]);
    if (price > 0) return { price, parser: "META_ITEMPROP_PRICE" };
  }

  const css = html.match(/class=["'][^"']*\bYMlKec\b[^"']*\bfxKbKc\b[^"']*["'][^>]*>\s*([^<]+?)\s*</i);
  if (css) {
    const price = numberFrom(css[1]);
    if (price > 0) return { price, parser: "CSS_CLASS" };
  }

  // Google embeds quote records in AF_initDataCallback blocks. A typical
  // record contains: ["SNDK","NASDAQ"], company, ..., "USD", [price,change,pct]
  const callbackRe = /AF_initDataCallback\(\{[\s\S]*?data:([\s\S]*?),\s*sideChannel:\s*\{[\s\S]*?\}\s*\}\);/gi;
  let callbackMatch;
  while ((callbackMatch = callbackRe.exec(html)) !== null) {
    const block = callbackMatch[1];
    if (!new RegExp(`\\["${safeSymbol}","NASDAQ"\\]`, "i").test(block)) continue;

    const quoteRe = new RegExp(
      `\\["${safeSymbol}","NASDAQ"\\][\\s\\S]{0,1800}?[,\\s]"USD"[,\\s]*\\[\\s*(-?[0-9][0-9,.]*)\\s*,\\s*(-?[0-9][0-9,.]*)\\s*,\\s*(-?[0-9][0-9,.]*)\\s*\\]`,
      "i"
    );
    const m = block.match(quoteRe);
    if (m) {
      const price = numberFrom(m[1]);
      const change = numberFrom(m[2]);
      const changePct = numberFrom(m[3]);
      if (price > 0) return { price, change, changePct, parser: "AF_INIT_DATA" };
    }
  }

  const attrPatterns = [
    {
      name: "DATA_LAST_PRICE",
      re: /data-last-price=["']([0-9.,]+)["']/i
    },
    {
      name: "ARIA_LABEL",
      re: /aria-label=["'](?:Price|Current price|현재가)?\s*[:=]?\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)["']/i
    },
    {
      name: "PRICE_JSON",
      re: /["'](?:price|lastPrice)["']\s*:\s*["']?\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i
    }
  ];
  for (const p of attrPatterns) {
    const m = html.match(p.re);
    if (m) {
      const price = numberFrom(m[1]);
      if (price > 0) return { price, parser: p.name };
    }
  }

  return null;
}

async function getGoogle(symbol, logs) {
  const url = `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:NASDAQ?hl=en-US&gl=US`;
  try {
    const { text, attempt } = await fetchText(url, {
      timeout: 9000,
      accept: "text/html,application/xhtml+xml"
    });
    const parsed = parseGooglePrice(text, symbol);
    if (!parsed) throw new Error("현재 Google Finance HTML에서 구조화 가격 데이터를 찾지 못함");

    logs.push({
      source: "Google",
      message: `서버 직접 호출 성공 · ${parsed.price.toFixed(2)} USD · parser=${parsed.parser} · attempt ${attempt}`
    });
    return {
      price: parsed.price,
      change: parsed.change ?? null,
      changePct: parsed.changePct ?? null,
      currency: "USD",
      market: "NASDAQ",
      timestampSource: "RECEIVED_AT"
    };
  } catch (e) {
    logs.push({ source: "Google", message: `실패: ${e.message}` });
    return null;
  }
}

async function getYahooHistory(symbol, logs) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=3mo&interval=1d&events=history`;

  try {
    const j = await fetchJson(url, { timeout: 8000 });
    const r = j?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const q = r?.indicators?.quote?.[0];
    if (!q) throw new Error("OHLC payload missing");

    const hist = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if ([o, h, l, c].every(Number.isFinite)) hist.push({ t: ts[i], o, h, l, c });
    }

    if (hist.length < 20) throw new Error(`OHLC ${hist.length}개 — 최소 20개 필요`);

    const last = hist.at(-1);
    const quoteDate = new Date(last.t * 1000).toISOString().slice(0, 10);

    logs.push({
      source: "OHLC",
      message: `Yahoo Chart 서버 호출 성공 · ${hist.length}개 일봉 · 최근 거래일 ${quoteDate}`
    });

    return {
      history: hist.slice(-60),
      quoteDate,
      close: last.c
    };
  } catch (e) {
    logs.push({ source: "OHLC", message: `실패: ${e.message}` });
    return null;
  }
}

function buildCrossCheck(naver, google, history) {
  if (!naver || !google) {
    return {
      status: "BLOCKED",
      reason: !naver ? "NAVER_UNAVAILABLE" : "GOOGLE_UNAVAILABLE",
      differencePct: null,
      thresholdPct: CROSSCHECK_LIMIT_PCT,
      naverPrice: naver?.price ?? null,
      googlePrice: google?.price ?? null,
      tradeAllowed: false
    };
  }

  const differencePct =
    Math.abs(naver.price - google.price) /
    Math.max(Math.abs(naver.price), Math.abs(google.price)) * 100;

  const status = differencePct < CROSSCHECK_LIMIT_PCT ? "PASS" : "WARNING";
  return {
    status,
    differencePct,
    thresholdPct: CROSSCHECK_LIMIT_PCT,
    naverPrice: naver.price,
    googlePrice: google.price,
    yahooClose: history?.close ?? null,
    tradeAllowed: status === "PASS"
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const fetchedAt = new Date().toISOString();
  const logs = [];

  if (!ALLOWED.test(symbol)) {
    return json({ ok: false, tradeAllowed: false, error: "유효하지 않은 symbol 입니다.", logs, fetchedAt }, 400);
  }

  // Naver first by design: primary quote/change-rate source.
  const naver = await getNaver(symbol, logs);
  const [google, history] = await Promise.all([
    getGoogle(symbol, logs),
    getYahooHistory(symbol, logs)
  ]);

  // A usable display quote requires Naver + real OHLC. Google remains a
  // mandatory second quote source for trade authorization.
  if (!naver || !history) {
    return json({
      ok: false,
      tradeAllowed: false,
      error: "기본 시세(Naver) 또는 실제 OHLC(Yahoo)를 확보하지 못했습니다. 데이터 지연으로 인한 확인 불가",
      fetchedAt,
      logs,
      quote: {
        symbol,
        currency: "USD",
        market: "NASDAQ",
        price: naver?.price ?? null,
        previousClose: naver?.previousClose ?? null,
        change: naver?.change ?? null,
        changePct: naver?.changePct ?? null,
        quoteDate: history?.quoteDate ?? null,
        history: history?.history ?? [],
        historySource: history ? "Yahoo Finance Chart (server-side diagnostic)" : null,
        crossCheck: buildCrossCheck(naver, google, history),
        timestampSource: {
          naver: naver?.timestampSource ?? null,
          google: google?.timestampSource ?? null,
          ohlc: history ? "SOURCE_DATE" : null
        }
      }
    }, 503);
  }

  const crossCheck = buildCrossCheck(naver, google, history);
  const okForDisplay = true;

  return json({
    ok: okForDisplay,
    tradeAllowed: crossCheck.tradeAllowed,
    fetchedAt,
    dataStatus: crossCheck.status === "PASS" ? "A_FULL" : "B_PARTIAL_GOOGLE",
    error: crossCheck.status === "PASS" ? null : "Google 교차검증 미완료 — 표시/기술분석은 가능하지만 매매 주문은 차단",
    quote: {
      symbol,
      currency: "USD",
      market: "NASDAQ",
      price: naver.price,
      previousClose: naver.previousClose,
      change: naver.change,
      changePct: naver.changePct ?? (naver.previousClose ? (naver.change / naver.previousClose) * 100 : null),
      quoteDate: history.quoteDate,
      history: history.history,
      historySource: "Yahoo Finance Chart (server-side diagnostic)",
      crossCheck,
      timestampSource: {
        naver: naver.timestampSource,
        naverTradedAt: naver.tradedAt,
        google: google?.timestampSource ?? null,
        ohlc: "SOURCE_DATE"
      }
    },
    logs
  });
};

export const config = { path: "/api/quote" };
