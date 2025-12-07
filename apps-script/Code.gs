/**
 * 초성 검색 캡처 앱 - Google Apps Script
 * 
 * 이 스크립트는 정답 등록 기능을 위한 백엔드 역할을 합니다.
 * 
 * 배포 방법:
 * 1. Google Sheets에서 확장 프로그램 > Apps Script 열기
 * 2. 이 코드를 붙여넣기
 * 3. Properties Service에 Gemini API 키 설정
 * 4. 웹 앱으로 배포
 */

// 시트 이름 상수
const SHEET_MAIN = '시트1'; // 메인 데이터 시트 이름 (실제 시트 이름으로 변경 필요)
const SHEET_REGISTRATION = '등록신청'; // 등록 신청 시트 이름
const SHEET_TOKEN_USAGE = '토큰사용량'; // 토큰 사용량 시트 이름

// Gemini API 설정
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_MODEL = 'gemini-2.5-flash';
const DAILY_TOKEN_LIMIT = 100000; // 일일 토큰 제한

/**
 * GET 요청 처리 (토큰 사용량 조회)
 */
function doGet(e) {
  const action = e.parameter.action;
  
  if (action === 'getTokenUsage') {
    return ContentService.createTextOutput(JSON.stringify(getTokenUsage()))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeaders({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
  }
  
  return ContentService.createTextOutput('Invalid action')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * POST 요청 처리 (정답 등록)
 */
function doPost(e) {
  try {
    const requestData = JSON.parse(e.postData.contents);
    const category = requestData.category;
    const name = requestData.name;
    
    // IP 주소 추출
    const ipAddress = e.parameter.sourceIp || 
                     e.parameter['X-Forwarded-For'] || 
                     'unknown';
    
    // 입력 검증
    const validation = validateInput(category, name);
    if (!validation.valid) {
      return createErrorResponse(validation.message);
    }
    
    // 중복 확인
    if (isDuplicate(name)) {
      return createErrorResponse('이미 등록된 항목입니다.');
    }
    
    // IP당 시간당 제한 확인
    if (isRateLimited(ipAddress)) {
      return createErrorResponse('등록 제한을 초과했습니다. 잠시 후 다시 시도해주세요.');
    }
    
    // 토큰 사용량 확인
    const tokenUsage = getTokenUsage();
    if (tokenUsage.tokensUsed >= DAILY_TOKEN_LIMIT) {
      // 등록신청 시트에 대기 상태로 저장
      saveRegistrationRequest(ipAddress, category, name, '대기 중', '토큰 제한 초과로 대기 중');
      return createErrorResponse('일일 등록 제한에 도달했습니다. 나중에 다시 시도해주세요.');
    }
    
    // 등록신청 시트에 저장 (상태: 대기 중)
    const timestamp = new Date().toISOString();
    const requestId = saveRegistrationRequest(ipAddress, category, name, '대기 중', '');
    
    // Gemini API로 자동 검토
    const reviewResult = reviewWithGemini(category, name);
    
    if (reviewResult.approved) {
      // 승인된 경우 메인 시트에 추가
      addToMainSheet(category, name);
      updateRegistrationStatus(requestId, '승인됨', reviewResult.reason, reviewResult.tokensUsed);
      
      // 토큰 사용량 업데이트
      updateTokenUsage(reviewResult.tokensUsed);
      
      return createSuccessResponse('등록 신청이 승인되었습니다.');
    } else {
      // 거부된 경우
      updateRegistrationStatus(requestId, '거부됨', reviewResult.reason, reviewResult.tokensUsed);
      
      // 토큰 사용량 업데이트
      updateTokenUsage(reviewResult.tokensUsed);
      
      return createErrorResponse('등록 신청이 거부되었습니다: ' + reviewResult.reason);
    }
    
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return createErrorResponse('서버 오류가 발생했습니다: ' + error.toString());
  }
}

/**
 * OPTIONS 요청 처리 (CORS)
 */
function doOptions() {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT)
    .setHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
}

/**
 * 입력 검증
 */
function validateInput(category, name) {
  if (!name || name.trim() === '') {
    return { valid: false, message: '이름을 입력해주세요.' };
  }
  
  if (name.length > 200) {
    return { valid: false, message: '이름은 최대 200자까지 입력 가능합니다.' };
  }
  
  // 한글만 허용
  const koreanRegex = /^[\uAC00-\uD7A3\s]+$/;
  if (!koreanRegex.test(name)) {
    return { valid: false, message: '한글만 입력 가능합니다.' };
  }
  
  if (!category || category.trim() === '') {
    return { valid: false, message: '카테고리를 선택해주세요.' };
  }
  
  return { valid: true };
}

/**
 * 중복 확인
 */
function isDuplicate(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MAIN);
  if (!sheet) return false;
  
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === name) { // B열이 이름
      return true;
    }
  }
  return false;
}

/**
 * IP당 시간당 제한 확인
 */
function isRateLimited(ipAddress) {
  const limitPerHour = 10; // IP당 시간당 10개 제한
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REGISTRATION);
  if (!sheet) return false;
  
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const data = sheet.getDataRange().getValues();
  
  let count = 0;
  for (let i = 1; i < data.length; i++) {
    const timestamp = new Date(data[i][0]); // A열이 타임스탬프
    const ip = data[i][1]; // B열이 IP 주소
    
    if (ip === ipAddress && timestamp > oneHourAgo) {
      count++;
    }
  }
  
  return count >= limitPerHour;
}

/**
 * 등록 신청 저장
 */
function saveRegistrationRequest(ipAddress, category, name, status, reviewLog) {
  const sheet = getOrCreateSheet(SHEET_REGISTRATION);
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['타임스탬프', 'IP 주소', '카테고리', '이름', '상태', '승인 여부 로그', '사용된 토큰 수']);
  }
  
  const timestamp = new Date().toISOString();
  const row = [timestamp, ipAddress, category, name, status, reviewLog, ''];
  sheet.appendRow(row);
  
  return sheet.getLastRow();
}

/**
 * 등록 신청 상태 업데이트
 */
function updateRegistrationStatus(rowIndex, status, reviewLog, tokensUsed) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REGISTRATION);
  if (!sheet) return;
  
  sheet.getRange(rowIndex, 5).setValue(status); // E열: 상태
  sheet.getRange(rowIndex, 6).setValue(reviewLog); // F열: 승인 여부 로그
  sheet.getRange(rowIndex, 7).setValue(tokensUsed || ''); // G열: 사용된 토큰 수
}

/**
 * 메인 시트에 추가
 */
function addToMainSheet(category, name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MAIN);
  if (!sheet) {
    throw new Error('메인 시트를 찾을 수 없습니다.');
  }
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['카테고리', '이름']);
  }
  
  sheet.appendRow([category, name]);
}

/**
 * Gemini API로 검토
 */
function reviewWithGemini(category, name) {
  try {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      throw new Error('Gemini API 키가 설정되지 않았습니다.');
    }
    
    const prompt = `다음 항목이 게임 아이템 이름으로 적절한지 검토해주세요. 카테고리: ${category}, 이름: ${name}. 승인 또는 거부 중 하나로만 답변하고, 간단한 이유를 설명해주세요.`;
    
    const payload = {
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    };
    
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json'
      },
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(`${GEMINI_API_URL}?key=${apiKey}`, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode !== 200) {
      const errorText = response.getContentText();
      Logger.log('Gemini API 오류 응답: ' + errorText);
      throw new Error('Gemini API 호출 실패: ' + responseCode);
    }
    
    const responseData = JSON.parse(response.getContentText());
    
    // 응답 구조 확인
    if (!responseData.candidates || !responseData.candidates[0] || !responseData.candidates[0].content) {
      throw new Error('Gemini API 응답 형식이 올바르지 않습니다.');
    }
    
    // 토큰 사용량 추출
    const tokensUsed = responseData.usageMetadata?.totalTokenCount || 0;
    
    // 응답 파싱
    const text = responseData.candidates[0].content.parts[0].text.toLowerCase();
    const approved = text.includes('승인') || text.includes('approve');
    const reason = responseData.candidates[0].content.parts[0].text;
    
    return {
      approved: approved,
      reason: reason,
      tokensUsed: tokensUsed
    };
    
  } catch (error) {
    Logger.log('Gemini API 오류: ' + error.toString());
    // 오류 발생 시 기본적으로 거부
    return {
      approved: false,
      reason: '검토 중 오류가 발생했습니다.',
      tokensUsed: 0
    };
  }
}

/**
 * Gemini API 키 가져오기
 */
function getGeminiApiKey() {
  const properties = PropertiesService.getScriptProperties();
  return properties.getProperty('GEMINI_API_KEY');
}

/**
 * 토큰 사용량 조회
 */
function getTokenUsage() {
  const sheet = getOrCreateSheet(SHEET_TOKEN_USAGE);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  
  // 오늘 날짜의 데이터 찾기
  const data = sheet.getDataRange().getValues();
  let tokensUsed = 0;
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === today) { // A열이 날짜
      tokensUsed = data[i][1] || 0; // B열이 사용된 토큰 수
      break;
    }
  }
  
  const tokensRemaining = Math.max(0, DAILY_TOKEN_LIMIT - tokensUsed);
  const usageRate = (tokensUsed / DAILY_TOKEN_LIMIT) * 100;
  
  return {
    date: today,
    tokensUsed: tokensUsed,
    tokensRemaining: tokensRemaining,
    usageRate: usageRate.toFixed(2),
    limit: DAILY_TOKEN_LIMIT
  };
}

/**
 * 토큰 사용량 업데이트
 */
function updateTokenUsage(tokensUsed) {
  const sheet = getOrCreateSheet(SHEET_TOKEN_USAGE);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['날짜', '사용된 토큰 수', '남은 토큰 수', '사용률 (%)', '리셋 시간']);
  }
  
  // 오늘 날짜의 데이터 찾기
  const data = sheet.getDataRange().getValues();
  let found = false;
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === today) {
      const currentUsed = (data[i][1] || 0) + tokensUsed;
      const remaining = Math.max(0, DAILY_TOKEN_LIMIT - currentUsed);
      const usageRate = (currentUsed / DAILY_TOKEN_LIMIT) * 100;
      
      sheet.getRange(i + 1, 2).setValue(currentUsed); // B열: 사용된 토큰 수
      sheet.getRange(i + 1, 3).setValue(remaining); // C열: 남은 토큰 수
      sheet.getRange(i + 1, 4).setValue(usageRate.toFixed(2)); // D열: 사용률
      sheet.getRange(i + 1, 5).setValue(new Date().toISOString()); // E열: 리셋 시간
      
      found = true;
      break;
    }
  }
  
  // 오늘 날짜의 데이터가 없으면 새로 추가
  if (!found) {
    const remaining = Math.max(0, DAILY_TOKEN_LIMIT - tokensUsed);
    const usageRate = (tokensUsed / DAILY_TOKEN_LIMIT) * 100;
    sheet.appendRow([today, tokensUsed, remaining, usageRate.toFixed(2), new Date().toISOString()]);
  }
}

/**
 * 일일 토큰 사용량 리셋 (Time-driven Trigger용)
 */
function resetDailyTokenUsage() {
  const sheet = getOrCreateSheet(SHEET_TOKEN_USAGE);
  const yesterday = Utilities.formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  
  // 오늘 날짜의 새 행 추가 (0으로 시작)
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['날짜', '사용된 토큰 수', '남은 토큰 수', '사용률 (%)', '리셋 시간']);
  }
  
  sheet.appendRow([today, 0, DAILY_TOKEN_LIMIT, 0, new Date().toISOString()]);
}

/**
 * 시트 가져오기 또는 생성
 */
function getOrCreateSheet(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);
  
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  
  return sheet;
}

/**
 * 성공 응답 생성
 */
function createSuccessResponse(message) {
  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    message: message
  }))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
}

/**
 * 오류 응답 생성
 */
function createErrorResponse(message) {
  return ContentService.createTextOutput(JSON.stringify({
    success: false,
    message: message
  }))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
}

