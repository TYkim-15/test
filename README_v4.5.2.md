# AlphaPilot Pro v4.5.2 — Changed Files Only

## 목적
v4.5.1 테스트 결과를 반영한 최소 변경 배포본입니다.

### 핵심 변경
1. **Naver 우선 조회**
   - Naver를 먼저 확보한 뒤 Google/Yahoo를 병렬 조회합니다.
   - Naver의 `change`(USD)와 `changePct`(%)를 분리합니다.
   - `localTradedAt`가 있으면 원천 거래시각으로 보존합니다.

2. **Google Finance 파서 재설계**
   - `meta itemprop=price`
   - 기존 가격 CSS class
   - `AF_initDataCallback` 구조화 데이터
   - data/aria/json 속성
   순서로 검사합니다.
   - v4.5.1의 광범위한 `$...` 문맥 fallback은 제거했습니다. 관련 없는 달러 금액을 가격으로 오인할 위험이 있기 때문입니다.

3. **부분 성공을 503으로 버리지 않음**
   - Naver + 실제 Yahoo OHLC가 확보되면 `ok=true`로 화면 표시/기술분석을 허용합니다.
   - Google 검증이 실패하면 `dataStatus=B_PARTIAL_GOOGLE`, `tradeAllowed=false`입니다.
   - 따라서 가격/MA20/ATR14는 볼 수 있지만 주문 계산은 차단됩니다.

4. **실제 OHLC 유지**
   - Yahoo Chart의 실제 일봉만 사용합니다.
   - Synthetic candle은 사용하지 않습니다.

5. **UI 수정**
   - Google 미검증 상태를 `WARNING (0.00%)`처럼 오해할 수 있는 표시를 제거했습니다.
   - `data.fetchedAt`를 실제 서버 수집시각으로 저장합니다.
   - Naver change/changePct가 있으면 그대로 사용합니다.

## 안전 정책
- Naver + Google 가격 모두 확보되고 가격 차이가 **1.00% 미만**일 때만 `tradeAllowed=true`.
- Google 미검증 또는 가격 차이 1.00% 이상이면 주문 차단.
- 한 소스 값을 다른 소스로 복제하여 교차검증을 위장하지 않습니다.

## 변경 파일
- `netlify/functions/quote.mjs`
- `index.html`
- `README_v4.5.2.md`

`netlify.toml`은 변경하지 않았습니다. Netlify Functions 디렉터리/라우팅 설정은 기존 설정을 그대로 사용합니다.

## 배포 후 확인
1. GitHub 저장소에서 위 2개 실행 파일을 덮어씁니다.
2. Netlify 자동 배포 완료 후 다음 URL을 확인합니다.
   `https://golden-wisp-5265dc.netlify.app/api/quote?symbol=SNDK`
3. 정상적인 부분 성공 상태라면 다음 필드를 확인합니다.
   - `ok: true`
   - `dataStatus: B_PARTIAL_GOOGLE` 또는 `A_FULL`
   - `tradeAllowed: false` 또는 `true`
   - `quote.history` 실제 OHLC
   - `quote.quoteDate`
   - `logs`의 Naver/Google/OHLC 결과

## 외부 데이터 소스 주의
Google Finance HTML과 Naver 공개/내부 endpoint는 공식 증권사 시세 API가 아닙니다. 실전 자동주문 시스템으로 확장할 경우에는 거래소/브로커의 공식 또는 라이선스된 시장데이터 API로 교체하는 것이 바람직합니다.
