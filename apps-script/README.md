# Google Apps Script 설정 가이드

이 폴더에는 정답 등록 기능을 위한 Google Apps Script 코드가 포함되어 있습니다.

## 설정 방법

### 1. Google Sheets에서 Apps Script 열기

1. 구글 시트를 엽니다
2. 상단 메뉴에서 **확장 프로그램** > **Apps Script** 클릭
3. 새로운 스크립트 편집기가 열립니다

### 2. 코드 복사 및 붙여넣기

1. `Code.gs` 파일의 내용을 모두 복사합니다
2. Apps Script 편집기에 붙여넣습니다
3. 시트 이름 상수를 실제 시트 이름으로 수정합니다:
   ```javascript
   const SHEET_MAIN = '시트1'; // 실제 메인 시트 이름으로 변경
   ```

### 3. Gemini API 키 설정

1. Apps Script 편집기에서 **프로젝트 설정** (톱니바퀴 아이콘) 클릭
2. **스크립트 속성** 섹션으로 이동
3. **속성 추가** 클릭
4. 속성 이름: `GEMINI_API_KEY`
5. 속성 값: Gemini API 키 입력
6. **저장** 클릭

**Gemini API 키 발급 방법:**
- [Google AI Studio](https://aistudio.google.com/app/apikey)에서 API 키 발급
- 또는 [Google Cloud Console](https://console.cloud.google.com/)에서 API 키 생성

**사용 모델**: Gemini 2.5 Flash (`gemini-2.5-flash`)

### 4. 시트 구조 확인

Apps Script가 정상 작동하려면 다음 시트들이 필요합니다:

#### 메인 시트 (데이터 시트)
- A열: 카테고리
- B열: 이름
- 첫 번째 행은 헤더 (카테고리, 이름)

#### 등록신청 시트 (자동 생성됨)
- A열: 타임스탬프
- B열: IP 주소
- C열: 카테고리
- D열: 이름
- E열: 상태 (대기 중/승인됨/거부됨)
- F열: 승인 여부 로그
- G열: 사용된 토큰 수

#### 토큰사용량 시트 (자동 생성됨)
- A열: 날짜 (YYYY-MM-DD)
- B열: 사용된 토큰 수
- C열: 남은 토큰 수
- D열: 사용률 (%)
- E열: 리셋 시간

### 5. 웹 앱으로 배포

1. Apps Script 편집기에서 **배포** > **새 배포** 클릭
2. **유형 선택**에서 **웹 앱** 선택
3. 설정:
   - **설명**: 원하는 설명 입력 (예: "초성 검색 앱 API")
   - **실행 대상**: `me` (본인)
   - **액세스 권한**: `모든 사용자` 또는 `익명 사용자` 선택
4. **배포** 클릭
5. **웹 앱 URL**을 복사합니다 (이 URL을 프론트엔드에서 사용)

### 6. Time-driven Trigger 설정 (선택사항)

일일 토큰 사용량을 자정에 자동으로 리셋하려면:

1. Apps Script 편집기에서 **트리거** (시계 아이콘) 클릭
2. **트리거 추가** 클릭
3. 설정:
   - **실행할 함수**: `resetDailyTokenUsage`
   - **이벤트 소스**: `시간 기반`
   - **시간 기반 트리거 유형**: `일일 타이머`
   - **시간**: `자정 ~ 오전 1시`
4. **저장** 클릭

### 7. 프론트엔드 연동

웹 앱 URL을 프론트엔드 코드에 추가해야 합니다. (현재는 UI만 구현되어 있으므로, 실제 연동은 나중에 구현)

## 테스트

### 수동 테스트

1. Apps Script 편집기에서 함수를 선택하고 실행:
   - `doGet` 함수로 토큰 사용량 조회 테스트
   - `doPost` 함수는 웹 앱 배포 후 POST 요청으로 테스트

### 웹 앱 테스트

1. 웹 앱 URL로 POST 요청 전송:
   ```bash
   curl -X POST "YOUR_WEB_APP_URL" \
     -H "Content-Type: application/json" \
     -d '{"category":"바람의나라","name":"테스트아이템"}'
   ```

2. 토큰 사용량 조회:
   ```bash
   curl "YOUR_WEB_APP_URL?action=getTokenUsage"
   ```

## 주의사항

1. **시트 권한**: Apps Script를 실행하는 계정이 시트 편집 권한을 가지고 있어야 합니다.
2. **CORS**: 웹 앱 배포 시 CORS 헤더가 자동으로 설정됩니다.
3. **API 키 보안**: API 키는 절대 공개하지 마세요. Properties Service에 안전하게 저장됩니다.
4. **실행 시간 제한**: Apps Script는 한 번의 실행이 최대 6분을 초과하면 타임아웃됩니다.
5. **일일 토큰 제한**: 기본값은 100,000 토큰입니다. 필요에 따라 `DAILY_TOKEN_LIMIT` 상수를 수정하세요.

## 문제 해결

### "시트를 찾을 수 없습니다" 오류
- 시트 이름이 정확한지 확인하세요
- 시트가 존재하는지 확인하세요

### "Gemini API 키가 설정되지 않았습니다" 오류
- Properties Service에 `GEMINI_API_KEY`가 설정되어 있는지 확인하세요

### CORS 오류
- 웹 앱 배포 시 액세스 권한을 `모든 사용자` 또는 `익명 사용자`로 설정했는지 확인하세요

### 토큰 제한 초과
- 일일 토큰 제한에 도달하면 새로운 등록 요청은 대기 상태로 저장됩니다
- 다음 날 자정에 자동으로 리셋됩니다 (Time-driven Trigger 설정 시)

