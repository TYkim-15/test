# AlphaPilot Pro v4.5 — Netlify Server Cross-Check

## 목적
기존 v4.3의 브라우저 → 공개 CORS Proxy → Naver/Google 구조를 제거하고,
브라우저 → Netlify Function → Naver/Google/Yahoo 구조로 변경했습니다.

## 파일
- `index.html` : v4.5 프론트엔드
- `netlify/functions/quote.mjs` : 서버측 시세/교차검증 API
- `netlify.toml` : Netlify Functions 및 publish 설정

## 동작
1. 브라우저가 `/api/quote?symbol=SNDK` 호출
2. Netlify Function이 Naver와 Google을 서버측에서 각각 호출
3. 두 가격 모두 확보되고 오차가 1% 미만이면 `PASS`
4. 둘 중 하나라도 실패하면 `503 / 데이터 지연으로 인한 확인 불가`
5. 오차가 1% 이상이면 `WARNING`이며 임의의 보수 가격으로 바꾸지 않고 `tradeAllowed=false`
6. ATR(14)/MA(20)은 Yahoo Chart의 실제 일봉 OHLC가 20개 이상 확보될 때만 계산
7. 실제 OHLC가 부족하면 ATR/MA20 계산을 중단하고 합성 캔들을 만들지 않음

## Netlify 배포
GitHub 저장소 루트에 위 구조 그대로 업로드하고 Netlify에서 해당 저장소를 연결합니다.
- Build command: 비워둠
- Publish directory: `.`
- Functions directory: `netlify/functions`

## 주의
Naver/Google HTML 또는 비공식 endpoint의 구조 변경에 따라 파서가 깨질 수 있습니다.
실거래용 장기 운영에서는 공식/허가된 시세 API로 교체하는 것을 권장합니다.
