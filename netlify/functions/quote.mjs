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
  if (!(close > 0) || delta == null) throw new Error("closePrice/compareToPreviousClosePrice missing");
  return {
    price: close,
    change: delta,
    previousClose: close - delta,
    currency: "USD",
    market: "NASDAQ",
    timestampSource: "RECEIVED_AT"
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
      message: `서버 직접 호출 성공 · ${data.price.toFixed(2)} USD / 전일대비 ${data.change.toFixed(2)} USD · attempt ${attempt}`
    });
    return data;
  } catch (e) {
    logs.push({ source: "Naver", message: `실패: ${e.message}` });
    return null;
  }
}

/*
 * Google Finance HTML is not an official machine-readable quote API.
 * v4.5.1 deliberately uses several parsing strategies and records which
 * strategy succeeded. A parser failure must never be converted into a
 * guessed price.
 */
function parseGooglePrice(html, symbol) {
  const patterns = [
    {
      name: "CSS_CLASS",
      re: /class=["'][^"']*\bYMlKec\b[^"']*\bfxKbKc\b[^"']*["'][^>]*>\s*([^<]+?)\s*</i
    },
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

  for (const p of patterns) {
    const m = html.match(p.re);
    if (m) {
      const price = numberFrom(m[1]);
      if (price > 0) return { price, parser: p.name };
    }
  }

  // Text-context fallback:
  // On the Google Finance quote page the ticker/company block precedes the
  // current quote. We take the first USD-looking amount after that block,
  // not later values such as market cap or after-hours quote.
  const anchorRe = new RegExp(
    `${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:NASDAQ`,
    "i"
  );
  const anchor = anchorRe.exec(html);
  if (anchor) {
    const windowText = html.slice(anchor.index, anchor.index + 5000);
    const amounts = [...windowText.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)];
    for (const m of amounts) {
      const price = numberFrom(m[1]);
      if (price > 0 && price < 1000000) {
        return { price, parser: "TICKER_CONTEXT_USD" };
      }
    }
  }

  // Last-resort company-name context. Still deterministic; never guessed.
  const companyAnchor = /SanDisk Corp|SanDisk Corporation/i.exec(html);
  if (companyAnchor) {
    const windowText = html.slice(companyAnchor.index, companyAnchor.index + 3000);
    const amounts = [...windowText.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)];
    for (const m of amounts) {
      const price = numberFrom(m[1]);
      if (price > 0 && price < 1000000) {
        return { price, parser: "COMPANY_CONTEXT_USD" };
      }
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
    if (!parsed) throw new Error("현재 Google Finance HTML에서 가격 패턴을 찾지 못함");

    logs.push({
      source: "Google",
      message: `서버 직접 호출 성공 · ${parsed.price.toFixed(2)} USD · parser=${parsed.parser} · attempt ${attempt}`
    });
    return {
      price: parsed.price,
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
      if ([o, h, l, c].every(Number.isFinite)) {
        hist.push({ t: ts[i], o, h, l, c });
      }
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
      quoteDate
    };
  } catch (e) {
    logs.push({ source: "OHLC", message: `실패: ${e.message}` });
    return null;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const fetchedAt = new Date().toISOString();
  const logs = [];

  if (!ALLOWED.test(symbol)) {
    return json({
      ok: false,
      error: "유효하지 않은 symbol 입니다.",
      logs,
      fetchedAt
    }, 400);
  }

  const [naver, google, history] = await Promise.all([
    getNaver(symbol, logs),
    getGoogle(symbol, logs),
    getYahooHistory(symbol, logs)
  ]);

  // Trading safety gate:
  // both quote sources are mandatory. A single-source result is never
  // promoted to a tradable quote.
  if (!naver || !google) {
    return json({
      ok: false,
      tradeAllowed: false,
      error: "Naver + Google 양쪽 교차검증을 완료하지 못했습니다. 데이터 지연으로 인한 확인 불가",
      logs,
      fetchedAt,
      quote: {
        symbol,
        currency: "USD",
        market: "NASDAQ",
        history: history?.history || [],
        quoteDate: history?.quoteDate || null
      }
    }, 503);
  }

  const differencePct =
    Math.abs(naver.price - google.price) /
    Math.max(Math.abs(naver.price), Math.abs(google.price)) * 100;

  const status = differencePct < CROSSCHECK_LIMIT_PCT ? "PASS" : "WARNING";

  // Do not select max/min price when sources disagree.
  // The quote is usable for display, but tradeAllowed stays false.
  const tradeAllowed = status === "PASS";

  return json({
    ok: true,
    tradeAllowed,
    fetchedAt,
    quote: {
      symbol,
      currency: "USD",
      market: "NASDAQ",
      price: naver.price,
      previousClose: naver.previousClose,
      change: naver.change,
      changePct: naver.previousClose
        ? (naver.change / naver.previousClose) * 100
        : null,
      quoteDate: history?.quoteDate || null,
      history: history?.history || [],
      historySource: history
        ? "Yahoo Finance Chart (server-side diagnostic)"
        : null,
      crossCheck: {
        status,
        differencePct,
        thresholdPct: CROSSCHECK_LIMIT_PCT,
        naverPrice: naver.price,
        googlePrice: google.price,
        tradeAllowed
      },
      timestampSource: {
        naver: naver.timestampSource,
        google: google.timestampSource,
        ohlc: history ? "SOURCE_DATE" : null
      }
    },
    logs
  });
};

export const config = { path: "/api/quote" };
