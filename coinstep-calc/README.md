# Coinstep 선물 포지션 시뮬레이터 v4 + Tapbit 동기화

## 변경사항 요약

### 🔄 가격 소스: Binance REST → Tapbit WebSocket
- **Tapbit markPrice** 기반 PnL 계산 (Tapbit 실제 청산 기준과 일치)
- WebSocket 실시간 push (500ms 버퍼 플러시, 초당 2회 렌더)
- 연결 실패 시 **Binance REST 자동 폴백** (기존 3초 폴링)
- 재연결: 지수 백오프 (1초→2초→4초...최대 30초), 5회 실패 후 폴백
- 탭 활성화 시 즉시 재연결 시도

### 📊 거래쌍 동적 로딩
- Tapbit `/instruments/list` API에서 코인 목록, 최소 수량, 레버리지 자동 로딩
- API 실패 시 하드코딩 Fallback 상수 사용 (기존과 동일 동작 보장)

### 🔌 크롬 확장 연동 (Tapbit 관리자 포지션 동기화)
- Tapbit 관리자 페이지의 포지션/잔고를 버튼 하나로 계산기에 자동 채움
- 유저 선택 드롭다운 (이름, 포지션 수, 잔고 표시)
- `auth` 토큰 자동 캡처 (fetch 감시, 리버스 엔지니어링 불필요)

### 💰 펀딩비 표시
- WebSocket ticker에서 fundingRate 수신 → 코인별 표시

---

## 파일 구조

```
calc.jsx                    # 계산기 (수정됨, 6,400줄)
extension/                  # 크롬 확장
├── manifest.json           # Manifest V3
├── background.js           # 메시지 라우터 + 상태 관리
├── content-tapbit.js       # agent.tapbit.com 전용
├── content-calc.js         # calc.coinstep.co.kr 전용
├── inject-tapbit.js        # 페이지 컨텍스트 fetch 감시
├── popup.html              # 확장 팝업 UI
├── popup.js                # 팝업 로직
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 크롬 확장 설치 방법

1. `chrome://extensions/` 접속
2. **개발자 모드** 활성화
3. **압축 해제된 확장 프로그램 로드** → `extension/` 폴더 선택
4. Tapbit 관리자 페이지 (agent.tapbit.com) 로그인
5. calc.coinstep.co.kr 접속 → "📥 Tapbit에서 불러오기" 클릭

---

## 동작 플로우

```
[calc.coinstep.co.kr]               [background.js]              [agent.tapbit.com]
      │                                    │                              │
 "불러오기" 클릭 ──► SYNC_REQUEST ─────────►│                              │
      │                                    │── FETCH_DATA ──────────────►│
      │                                    │                   fetch 실행 (쿠키 자동)
      │                                    │                   positions + accounts
      │                                    │◄── 응답 ───────────────────│
      │◄── tapbit-sync-response ──────────│                              │
 유저 선택 → 자동 채움                       │                              │
```

---

## 에러 처리

| 시나리오 | 동작 |
|---------|------|
| Tapbit WS 연결 실패 | 5회 재연결 후 Binance REST 폴백 |
| 확장 미설치 | 기존 수동 입력 모드 (하위 호환) |
| Tapbit 탭 없음 | "Tapbit 관리자 페이지를 열어주세요" |
| Auth 만료 | "다시 로그인해주세요" |
| instruments API 실패 | Fallback 상수 (BTC/ETH/SOL/XRP...) |
