# Coinstep Sync Bookmarklet

Tapbit 에이전트 페이지에서 거래 데이터를 수집하여 Coinstep 서버로 전송하는 북마클릿입니다.

## 설치

### 방법 1: 설치 페이지 (권장)

`https://api.coinstep.co.kr/install` 페이지에서 드래그 앤 드롭으로 설치합니다.

### 방법 2: 수동 설치

1. 브라우저 북마크 바에 새 북마크 추가
2. 이름: `Coinstep Sync`
3. URL에 아래 코드 입력:

```
javascript:void((function(){var s=document.createElement('script');s.src='https://api.coinstep.co.kr/static/sync.js?t='+Date.now();document.head.appendChild(s)})())
```

## 사용법

1. [agent.tapbit.com](https://agent.tapbit.com)에 로그인
2. 북마크 바에서 **Coinstep Sync** 클릭
3. 첫 실행 시 SyncToken 입력 (관리자에게 발급받은 `stk_` 토큰)
4. 동기화 완료 확인

## 수집 데이터

| 항목 | 설명 | 소스 |
|------|------|------|
| Profile | maskId, remarkName | dva store / fetch intercept |
| Positions | 현재 포지션 | dva store / fetch intercept |
| Accounts | 계좌 잔고 | dva store / fetch intercept |
| Histories | 체결내역 (최근 180일, 최대 5000건) | dva dispatch + pagination |

## 제한사항

- 분당 3회, 시간당 10회 동기화 제한
- 동일 데이터 5분 내 재전송 시 중복 차단
- Tapbit 에이전트 페이지(agent.tapbit.com)에서만 동작
- 30초 타임아웃 (부분 데이터도 전송됨)

## 문제 해결

| 증상 | 해결 |
|------|------|
| "dva store 없음" | agent.tapbit.com에서 실행하세요 |
| "유효한 SyncToken 필요" | 관리자에게 토큰 발급 요청 |
| "요청이 너무 많습니다" | 제한 시간 후 재시도 |
| "동일한 데이터" | 이미 동기화된 상태 |

## SyncToken 초기화

토큰을 변경하려면 브라우저 콘솔에서:

```js
localStorage.removeItem('coinstep_sync_token');
```

다음 북마클릿 실행 시 새 토큰 입력 가능.
