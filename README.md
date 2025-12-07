# ㅋㅋㅋ - 초성 검색 캡처 앱

초성을 입력하여 게임 아이템을 검색하는 웹 애플리케이션입니다.

## 기능

### MVP 기능 (구현 완료)
- ✅ 구글 시트 데이터 로딩
- ✅ 초성 변환 및 실시간 검색
- ✅ 검색 결과 표시 및 클립보드 복사
- ✅ 카테고리별 필터링
- ✅ 검색 히스토리 저장/복원
- ✅ 로컬 스토리지 설정 저장
- ✅ 정답 등록 UI (기능은 미구현)

### 추가 기능 (예정)
- 정답 등록 기능 (Google Apps Script 연동 필요)
- Google Gemini API를 활용한 자동 검토 시스템

## 사용 방법

### 로컬에서 실행

1. 파일 다운로드
2. `index.html` 파일을 브라우저에서 열기
3. 또는 로컬 서버 실행:
   ```bash
   # Python 3
   python -m http.server 8000
   
   # Node.js (http-server 설치 필요)
   npx http-server
   ```

### 호스팅

정적 파일 호스팅 플랫폼에 배포 가능:
- Render.com
- Netlify
- Vercel
- GitHub Pages

**주의**: Clipboard API 사용을 위해 HTTPS 환경이 필요합니다 (localhost 제외).

## 파일 구조

```
.
├── index.html          # 메인 HTML 파일
├── styles.css          # 스타일시트 (흑백, 도트 폰트)
├── app.js              # 메인 JavaScript 로직
├── apps-script/        # Google Apps Script 파일
│   ├── Code.gs        # Apps Script 코드
│   └── README.md      # Apps Script 설정 가이드
├── PRD.md              # 제품 요구사항 문서
└── README.md           # 이 파일
```

## 설정

### 구글 시트 URL 변경

1. 설정 영역에서 구글 시트 CSV URL 입력
2. "저장" 버튼 클릭
3. 자동으로 데이터가 새로고침됩니다

기본 URL: `https://docs.google.com/spreadsheets/d/e/2PACX-1vTNgKTsKcqDr4etDeuMtzfJqlFDfsDuCTRA3AgGdUtaIimSGV6Jc-kUO2zEEUf3MJbfic_21tnjo3oz/pub?output=csv`

## 정답 등록 기능 설정

정답 등록 기능을 사용하려면 Google Apps Script를 설정해야 합니다.

자세한 설정 방법은 `apps-script/README.md`를 참고하세요.

## 기술 스택

- HTML5
- CSS3 (도트 폰트: Press Start 2P)
- JavaScript (ES6+)
- Clipboard API
- LocalStorage API
- Google Sheets API (CSV)
- Google Apps Script (정답 등록용)
- Google Gemini API (자동 검토용)

## 브라우저 호환성

- Chrome 66+
- Edge 79+
- Firefox 63+
- Safari 13.1+

## 라이선스

이 프로젝트는 개인 사용 목적으로 제작되었습니다.

