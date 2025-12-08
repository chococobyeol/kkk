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
const SHEET_TAGS = '태그목록'; // 태그 목록 시트 이름
const SHEET_CATEGORIES = '카테고리목록'; // 카테고리 목록 시트 이름

// Gemini API 설정
// 모델: gemini-2.5-flash
// 공식 문서: https://ai.google.dev/gemini-api/docs/gemini-3
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
    Logger.log('doPost 호출됨');
    Logger.log('parameter:', e.parameter);
    Logger.log('postData.contents:', e.postData ? e.postData.contents : '없음');
    Logger.log('postData.type:', e.postData ? e.postData.type : '없음');
    
    // URL 파라미터 또는 JSON 처리
    let category, name, description = '';
    
    // 우선 URL 파라미터 확인 (FormData 방식)
    if (e.parameter && e.parameter.category && e.parameter.name) {
      category = e.parameter.category;
      name = e.parameter.name;
      description = e.parameter.description || '';
      Logger.log('URL 파라미터로 받음:', { category, name, description });
    } 
    // postData 확인 (JSON 또는 text/plain)
    else if (e.postData && e.postData.contents) {
      try {
        // text/plain으로 보낸 JSON도 파싱 가능
        const requestData = JSON.parse(e.postData.contents);
        category = requestData.category;
        name = requestData.name;
        description = requestData.description || '';
        Logger.log('JSON으로 받음 (text/plain):', { category, name, description });
      } catch (parseError) {
        Logger.log('JSON 파싱 오류:', parseError);
        throw new Error('요청 데이터 형식이 올바르지 않습니다.');
      }
    } else {
      throw new Error('카테고리와 이름이 필요합니다.');
    }
    
    // IP 주소 추출
    // 참고: Google Apps Script에서는 클라이언트 IP를 직접 가져올 수 없습니다.
    // 따라서 클라이언트 측에서 IP를 가져와서 'ipAddress' 파라미터로 전송합니다.
    // 클라이언트 측에서 IP를 가져오지 못한 경우 'unknown'이 전송됩니다.
    let ipAddress = 'unknown';
    
    // URL 파라미터 또는 POST 데이터에서 IP 주소 확인
    if (e.parameter && e.parameter.ipAddress) {
      ipAddress = e.parameter.ipAddress;
      Logger.log('IP 주소 (URL 파라미터): ' + ipAddress);
    } else if (e.postData && e.postData.contents) {
      try {
        const requestData = JSON.parse(e.postData.contents);
        if (requestData.ipAddress) {
          ipAddress = requestData.ipAddress;
          Logger.log('IP 주소 (JSON): ' + ipAddress);
        }
      } catch (parseError) {
        // JSON 파싱 실패는 무시 (이미 위에서 처리됨)
      }
    }
    
    Logger.log('최종 IP 주소: ' + ipAddress);
    
    // ========== 1단계: 입력 검증 ==========
    const validation = validateInput(category, name);
    if (!validation.valid) {
      // 입력 검증 실패는 등록신청 시트에 저장하지 않음 (잘못된 요청)
      return createErrorResponse(validation.message);
    }
    
    // ========== 2단계: 사전 중복 확인 ==========
    // 요청한 카테고리에서 중복 확인
    // 같은 이름이라도 카테고리가 다르면 다른 항목으로 간주 (예: "게임 부엉이"와 "생물 부엉이"는 다른 항목)
    if (isDuplicate(name, category)) {
      // 등록신청 시트에 거부 상태로 저장
      saveRegistrationRequest(ipAddress, category, name, '거부됨', `요청한 카테고리("${category}")에 이미 등록된 항목입니다.`);
      return createErrorResponse(`이미 등록된 항목입니다. (${category} 카테고리)`, {
        reason: `요청한 카테고리("${category}")에 이미 등록된 항목입니다.`
      });
    }
    
    // ========== 3단계: 제한 확인 ==========
    // IP당 시간당 제한 확인
    if (isRateLimited(ipAddress)) {
      saveRegistrationRequest(ipAddress, category, name, '거부됨', 'IP당 시간당 등록 제한 초과 (1시간에 10개 초과)');
      return createErrorResponse('등록 제한을 초과했습니다. 잠시 후 다시 시도해주세요.', {
        reason: 'IP당 시간당 등록 제한 초과 (1시간에 10개 초과)'
      });
    }
    
    // 토큰 사용량 확인
    const tokenUsage = getTokenUsage();
    if (tokenUsage.tokensUsed >= DAILY_TOKEN_LIMIT) {
      saveRegistrationRequest(ipAddress, category, name, '거부됨', '일일 토큰 사용량 제한 초과 (100,000 토큰 초과)');
      return createErrorResponse('일일 등록 제한에 도달했습니다. 나중에 다시 시도해주세요.', {
        reason: '일일 토큰 사용량 제한 초과 (100,000 토큰 초과)'
      });
    }
    
    // ========== 4단계: 등록신청 시트에 저장 (대기 중) ==========
    const requestId = saveRegistrationRequest(ipAddress, category, name, '대기 중', 'Gemini API 검토 대기 중...');
    
    // ========== 5단계: Gemini API 검토 ==========
    let reviewResult;
    let tokensUsed = 0;
    try {
      reviewResult = reviewWithGemini(category, name, description);
      tokensUsed = reviewResult.tokensUsed || 0;
    } catch (apiError) {
      // API 오류 발생 시 등록신청 시트에 거부 상태로 저장
      let errorMessage = 'Gemini API 호출 중 오류 발생: ' + apiError.toString();
      let statusMessage = errorMessage;
      
      // 오류 유형별 상세 메시지
      if (apiError.toString().includes('429') || apiError.toString().includes('할당량을 초과')) {
        statusMessage = 'Gemini API 요청 한도 초과 (429 Too Many Requests) - 일일 할당량 또는 분당 요청 수 제한 초과';
        errorMessage = 'API 요청 한도가 초과되었습니다. 잠시 후 다시 시도해주세요.';
      } else if (apiError.toString().includes('500') || apiError.toString().includes('503')) {
        statusMessage = 'Gemini API 서버 오류 (' + apiError.toString() + ') - 일시적인 서버 문제로 검토 불가';
        errorMessage = 'API 서버에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.';
      } else if (apiError.toString().includes('401') || apiError.toString().includes('403')) {
        statusMessage = 'Gemini API 인증 오류 (' + apiError.toString() + ') - API 키 문제 또는 권한 없음';
        errorMessage = 'API 인증에 문제가 발생했습니다. 관리자에게 문의해주세요.';
      }
      
      // 등록신청 시트 상태 업데이트
      updateRegistrationStatus(requestId, '거부됨', statusMessage, 0);
      
      return createErrorResponse(errorMessage, {
        reason: statusMessage
      });
    }
    
    // ========== 6단계: 검토 결과 처리 ==========
    if (!reviewResult.approved) {
      // 거부된 경우
      updateRegistrationStatus(requestId, '거부됨', reviewResult.reason || 'Gemini API에 의해 거부됨', tokensUsed);
      updateTokenUsage(tokensUsed);
      
      return createErrorResponse('등록 신청이 거부되었습니다: ' + (reviewResult.reason || '이유 없음'), {
        reason: reviewResult.reason || 'Gemini API에 의해 거부됨'
      });
    }
    
    // 승인된 경우: 최종 카테고리 결정
    const finalCategory = reviewResult.category || category;
    const categoryChanged = (category !== finalCategory);
    
    // ========== 7단계: 최종 카테고리에서 중복 확인 ==========
    // 카테고리가 변경되었거나 변경되지 않았더라도 최종 확인
    // (카테고리 변경 시 중복 방지 + 동시 등록 방지)
    if (isDuplicate(name, finalCategory)) {
      const reasonMessage = categoryChanged 
        ? `카테고리 자동 변경 후 중복 발견: "${category}" → "${finalCategory}" 카테고리에 이미 등록된 항목입니다.`
        : `최종 확인 중 중복 발견: "${finalCategory}" 카테고리에 이미 등록된 항목입니다. (동시 등록 가능성)`;
      
      updateRegistrationStatus(requestId, '거부됨', reasonMessage, tokensUsed);
      updateTokenUsage(tokensUsed);
      
      return createErrorResponse(
        categoryChanged 
          ? `카테고리가 "${finalCategory}"로 변경되었지만, 해당 카테고리에 이미 등록된 항목입니다.`
          : `"${finalCategory}" 카테고리에 이미 등록된 항목입니다.`,
        { reason: reasonMessage }
      );
    }
    
    // ========== 8단계: 메인 시트에 등록 ==========
    try {
      addToMainSheet(finalCategory, name, reviewResult.tags || []);
      syncTagsToSheet(reviewResult.tags || [], finalCategory);
      syncCategoryToSheet(finalCategory);
    } catch (sheetError) {
      // 시트 저장 실패 시
      updateRegistrationStatus(requestId, '거부됨', `시트 저장 실패: ${sheetError.toString()}`, tokensUsed);
      updateTokenUsage(tokensUsed);
      return createErrorResponse('데이터 저장 중 오류가 발생했습니다. 관리자에게 문의해주세요.', {
        reason: `시트 저장 실패: ${sheetError.toString()}`
      });
    }
    
    // ========== 9단계: 등록신청 시트 상태 업데이트 ==========
    let statusMessage = reviewResult.reason || '승인됨';
    if (categoryChanged) {
      statusMessage = `[카테고리 자동 변경: ${category} → ${finalCategory}]\n${reviewResult.reason || '승인됨'}`;
    }
    
    updateRegistrationStatus(requestId, '승인됨', statusMessage, tokensUsed);
    updateTokenUsage(tokensUsed);
    
    // 성공 응답에 카테고리와 태그 정보 포함
    let successMessage = '등록 신청이 승인되었습니다.';
    if (category === '기타' && finalCategory !== '기타') {
      successMessage += `\n카테고리: ${category} → ${finalCategory}`;
    } else {
      successMessage += `\n카테고리: ${finalCategory}`;
    }
    if (reviewResult.tags && reviewResult.tags.length > 0) {
      successMessage += `\n태그: ${reviewResult.tags.join(', ')}`;
    } else {
      successMessage += '\n태그: 없음';
    }
    
    return createSuccessResponse(successMessage, {
      name: name,
      category: finalCategory,
      tags: reviewResult.tags || [],
      originalCategory: category
    });
    
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    
    // 등록신청 시트에 저장된 경우 상태 업데이트
    // requestId가 있는 경우에만 업데이트 (이미 저장된 경우)
    try {
      // requestId가 스코프에 있는지 확인하고, 있으면 업데이트
      if (typeof requestId !== 'undefined' && requestId) {
        updateRegistrationStatus(requestId, '거부됨', '서버 오류 발생: ' + error.toString(), 0);
      } else {
        // requestId가 없으면 새로 저장 (입력 검증 전 오류 등)
        const ipAddress = (e.parameter && e.parameter.ipAddress) || 'unknown';
        const category = (e.parameter && e.parameter.category) || '';
        const name = (e.parameter && e.parameter.name) || '';
        if (category && name) {
          saveRegistrationRequest(ipAddress, category, name, '거부됨', '서버 오류 발생: ' + error.toString());
        }
      }
    } catch (saveError) {
      Logger.log('등록신청 시트 저장 실패: ' + saveError.toString());
    }
    
    return createErrorResponse('서버 오류가 발생했습니다: ' + error.toString(), {
      reason: '서버 오류 발생: ' + error.toString()
    });
  }
}

/**
 * OPTIONS 요청 처리 (CORS)
 */
function doOptions(e) {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT)
    .setHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '3600'
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
 * 중복 확인 (카테고리별로 체크)
 * 같은 이름이라도 카테고리가 다르면 다른 항목으로 간주
 */
function isDuplicate(name, category) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MAIN);
  if (!sheet) return false;
  
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    // A열: 카테고리, B열: 태그, C열: 이름
    const rowCategory = data[i].length >= 1 ? data[i][0] : '';
    const nameColumn = data[i].length >= 3 ? data[i][2] : (data[i].length >= 2 ? data[i][1] : ''); // C열 또는 B열(하위 호환)
    
    // 이름과 카테고리가 모두 일치하면 중복
    if (nameColumn === name && rowCategory === category) {
      return true;
    }
  }
  return false;
}

/**
 * 모든 카테고리에서 같은 이름이 있는지 확인
 * @param {string} name - 확인할 이름
 * @return {string|null} - 이름이 있는 카테고리 이름, 없으면 null
 */
function findExistingCategory(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MAIN);
  if (!sheet) return null;
  
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    // A열: 카테고리, B열: 태그, C열: 이름
    const rowCategory = data[i].length >= 1 ? data[i][0] : '';
    const nameColumn = data[i].length >= 3 ? data[i][2] : (data[i].length >= 2 ? data[i][1] : ''); // C열 또는 B열(하위 호환)
    
    // 이름이 일치하면 해당 카테고리 반환
    if (nameColumn === name && rowCategory) {
      return rowCategory.toString().trim();
    }
  }
  return null;
}

/**
 * IP당 시간당 제한 확인
 */
function isRateLimited(ipAddress) {
  const limitPerHour = 10; // IP당 시간당 10개 제한
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REGISTRATION);
  if (!sheet) {
    Logger.log('등록신청 시트를 찾을 수 없음, 제한 없음');
    return false;
  }
  
  // 'unknown' IP는 제한하지 않음 (로컬 테스트 등)
  if (ipAddress === 'unknown') {
    Logger.log('IP 주소가 unknown이므로 제한 없음');
    return false;
  }
  
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const data = sheet.getDataRange().getValues();
  
  let count = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i].length < 2) continue;
    
    try {
      const timestampStr = data[i][0];
      if (!timestampStr) continue;
      
      const timestamp = new Date(timestampStr); // A열이 타임스탬프
      if (isNaN(timestamp.getTime())) continue; // 유효하지 않은 날짜
      
      const ip = data[i][1]; // B열이 IP 주소
      
      if (ip === ipAddress && timestamp > oneHourAgo) {
        count++;
      }
    } catch (e) {
      Logger.log('타임스탬프 파싱 오류 (행 ' + i + '): ' + e.toString());
      continue;
    }
  }
  
  Logger.log('IP ' + ipAddress + '의 최근 1시간 내 요청 수: ' + count + ' / ' + limitPerHour);
  
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
function addToMainSheet(category, name, tags) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MAIN);
  if (!sheet) {
    throw new Error('메인 시트를 찾을 수 없습니다.');
  }
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['카테고리', '태그', '이름']);
  }
  
  // 태그를 쉼표로 구분된 문자열로 변환
  const tagsString = tags && tags.length > 0 ? tags.join(',') : '';
  
  sheet.appendRow([category, tagsString, name]);
  
  // 즉시 반영을 위해 flush 호출 (캐시 문제 해결)
  SpreadsheetApp.flush();
}

/**
 * 기존 카테고리 목록 가져오기 (별도 시트에서)
 */
function getExistingCategories() {
  const sheet = getOrCreateSheet(SHEET_CATEGORIES);
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['카테고리']);
    // 메인 시트에서 기존 카테고리 수집하여 초기화
    syncCategoriesFromMainSheet();
  }
  
  const data = sheet.getDataRange().getValues();
  const categories = [];
  
  // 헤더 건너뛰기
  for (let i = 1; i < data.length; i++) {
    if (data[i].length >= 1 && data[i][0]) {
      const category = data[i][0].toString().trim();
      if (category) {
        categories.push(category);
      }
    }
  }
  
  return categories;
}

/**
 * 메인 시트에서 카테고리 동기화 (초기화용)
 */
function syncCategoriesFromMainSheet() {
  const mainSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MAIN);
  if (!mainSheet || mainSheet.getLastRow() <= 1) return;
  
  const categorySheet = getOrCreateSheet(SHEET_CATEGORIES);
  const categoriesMap = {};
  const data = mainSheet.getDataRange().getValues();
  
  // 헤더 건너뛰기
  for (let i = 1; i < data.length; i++) {
    if (data[i].length >= 1 && data[i][0]) {
      const category = data[i][0].toString().trim();
      if (category) {
        categoriesMap[category] = true;
      }
    }
  }
  
  // 카테고리 시트에 추가
  for (var category in categoriesMap) {
    if (categoriesMap.hasOwnProperty(category)) {
      categorySheet.appendRow([category]);
    }
  }
}

/**
 * 카테고리에 따른 검토 기준 설명 가져오기
 */
function getCategoryDescription(category) {
  const descriptions = {
    '게임': '게임 아이템, 캐릭터, 무기, 장비 등 게임 관련 항목입니다.',
    '영화': '영화 제목, 영화 속 인물, 영화 관련 용어 등 영화 관련 항목입니다.',
    '인물': '실존 인물, 역사적 인물, 유명인 등 인물 관련 항목입니다.',
    '생물': '생물학적 종명(종의 이름)만 허용됩니다. 개체 이름, 애완동물 이름, 강아지 이름, 고양이 이름 등은 거부해야 합니다. 예: "개", "고양이", "사람", "장미"는 허용되지만 "요미", "뽀삐", "나비" 같은 개체 이름은 거부해야 합니다.',
    '단어': '일반 단어, 사전에 등재된 단어, 용어 등 단어 관련 항목입니다.',
    '기타': '기타 분류되지 않은 항목입니다.'
  };
  
  // 카테고리에 맞는 설명이 있으면 반환, 없으면 기본 설명
  return descriptions[category] || `"${category}" 카테고리의 항목으로 적절한지 검토해주세요.`;
}

/**
 * 기존 태그 목록 가져오기 (카테고리별, 별도 시트에서)
 * @param {string} category - 카테고리 (선택사항, 없으면 모든 태그 반환)
 */
function getExistingTags(category) {
  const sheet = getOrCreateSheet(SHEET_TAGS);
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['카테고리', '태그']);
    // 메인 시트에서 기존 태그 수집하여 초기화
    syncTagsFromMainSheet();
  }
  
  const data = sheet.getDataRange().getValues();
  const tags = [];
  
  // 헤더 건너뛰기
  for (let i = 1; i < data.length; i++) {
    // A열: 카테고리, B열: 태그
    if (data[i].length >= 2 && data[i][1]) {
      const tagCategory = data[i][0] ? data[i][0].toString().trim() : '';
      const tag = data[i][1].toString().trim();
      
      // 카테고리가 지정되었으면 해당 카테고리의 태그만, 아니면 모든 태그
      if (tag && (!category || tagCategory === category)) {
        tags.push(tag);
      }
    }
  }
  
  return tags;
}

/**
 * 메인 시트에서 태그 동기화 (초기화용, 카테고리별로 관리)
 */
function syncTagsFromMainSheet() {
  const mainSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MAIN);
  if (!mainSheet || mainSheet.getLastRow() <= 1) return;
  
  const tagSheet = getOrCreateSheet(SHEET_TAGS);
  const tagsMap = {}; // {카테고리: {태그: true}} 형태
  const data = mainSheet.getDataRange().getValues();
  
  // 헤더 건너뛰기
  for (let i = 1; i < data.length; i++) {
    // A열: 카테고리, B열: 태그, C열: 이름
    if (data[i].length >= 2) {
      const category = data[i][0] ? data[i][0].toString().trim() : '';
      const tagsString = data[i][1] ? data[i][1].toString().trim() : '';
      
      if (category && tagsString) {
        // 카테고리별 태그 맵 초기화
        if (!tagsMap[category]) {
          tagsMap[category] = {};
        }
        
        // 쉼표로 구분된 태그들을 분리
        const tags = tagsString.split(',');
        for (let j = 0; j < tags.length; j++) {
          const tag = tags[j].trim();
          if (tag) {
            tagsMap[category][tag] = true;
          }
        }
      }
    }
  }
  
  // 태그 시트에 추가 (카테고리별로)
  for (var category in tagsMap) {
    if (tagsMap.hasOwnProperty(category)) {
      for (var tag in tagsMap[category]) {
        if (tagsMap[category].hasOwnProperty(tag)) {
          tagSheet.appendRow([category, tag]);
        }
      }
    }
  }
}

/**
 * Gemini API로 검토 및 태그 추천
 */
function reviewWithGemini(category, name, description) {
  const maxRetries = 2; // 최대 2회 재시도 (총 3회)
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        Logger.log(`재시도 ${attempt}회차 시작`);
      }
      return reviewWithGeminiOnce(category, name, description);
    } catch (error) {
      lastError = error;
      Logger.log(`시도 ${attempt + 1} 실패: ${error.toString()}`);
      
      // JSON 파싱 오류인 경우에만 재시도
      if (error.toString().includes('JSON') || error.toString().includes('형식이 올바르지 않습니다')) {
        if (attempt < maxRetries) {
          Logger.log('JSON 파싱 오류로 재시도합니다...');
          continue;
        }
      }
      
      // 다른 오류는 즉시 중단
      throw error;
    }
  }
  
  // 모든 재시도 실패
  throw lastError || new Error('재시도 횟수 초과');
}

/**
 * Gemini API로 검토 및 태그 추천 (1회 시도)
 */
function reviewWithGeminiOnce(category, name, description) {
  try {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      throw new Error('Gemini API 키가 설정되지 않았습니다.');
    }
    
    // 기존 태그 목록 가져오기 (현재 카테고리의 태그만)
    const existingTags = getExistingTags(category);
    const existingTagsText = existingTags.length > 0 ? existingTags.join(', ') : '없음';
    
    // 기존 카테고리 목록 가져오기
    const existingCategories = getExistingCategories();
    const existingCategoriesText = existingCategories.length > 0 ? existingCategories.join(', ') : '없음';
    
    // 카테고리에 따른 검토 기준 설정
    const categoryDescription = getCategoryDescription(category);
    
    // "기타" 카테고리인 경우 적절한 카테고리 찾기 요청 추가
    let categoryPrompt = '';
    if (category === '기타') {
      categoryPrompt = `\n중요: 현재 "기타" 카테고리로 등록하려고 하지만, 기존 카테고리 목록(${existingCategoriesText}) 중에 이 항목에 더 적합한 카테고리가 있다면 그 카테고리를 추천해주세요. 
- 특히 동물, 식물 등 생물 관련 항목인 경우 반드시 "생물" 카테고리를 추천해주세요
- 적합한 카테고리가 없으면 "기타"를 유지하세요`;
    }
    
    // 검토 및 태그 추천 프롬프트
    let descriptionText = '';
    if (description && description.trim()) {
      descriptionText = `\n\n***중요: 사용자 제공 설명***
${description.trim()}

이 설명을 웹 검색으로 반드시 검증해주세요:
1. 웹 검색을 통해 실제로 이 항목이 설명에 명시된 게임/영화/인물에 존재하는지 확인
2. 설명이 정확하면: 설명에 명시된 게임/영화/인물 정보를 그대로 사용하여 태그 추천
3. 설명이 틀렸거나 다른 게임/영화/인물의 것이라면: 거부하거나 정확한 정보로 수정
4. 설명과 실제 정보가 다르면 반드시 거부해주세요
5. 설명이 없거나 불명확한 경우에만 웹 검색 결과를 참고하여 태그 추천

예시:
- 사용자 설명: "바람의나라 게임의 아이템"
  → 웹 검색 결과 바람의나라에 실제로 존재하면: "바람의나라" 태그 사용
  → 웹 검색 결과 다른 게임의 아이템이면: 거부 또는 정확한 게임명으로 수정
- 사용자 설명: "검은사막 게임의 아이템" (실제로는 바람의나라 아이템인 경우)
  → 웹 검색 결과 실제로는 바람의나라 아이템이면: 거부 또는 "바람의나라"로 수정`;
    }
    
    // 생물 카테고리 특별 처리 (기타에서 생물로 변경될 수도 있으므로 항상 포함)
    let biologyPrompt = '';
    biologyPrompt = `
중요: 카테고리가 "생물"로 결정되거나, 동물/식물 등 생물 관련 항목인 경우:
- 반드시 생물학적 종명(종의 이름)만 허용합니다
- 개체 이름, 애완동물 이름, 강아지 이름, 고양이 이름 등은 절대 허용하지 마세요
- 예: "개", "고양이", "사람", "장미", "호랑이" → 허용 (생물학적 종명)
- 예: "요미", "뽀삐" → 거부 (웹 검색 결과가 "강아지 이름"으로 확인된 경우)
- 주의: "초코"는 "초콜릿"의 줄임말일 수 있으므로, 웹 검색 결과를 보고 판단하세요
  * 웹 검색 결과가 "초콜릿", "음식", "과자" 등으로 나오면 → 허용 (일반 단어)
  * 웹 검색 결과가 "강아지 이름", "애완동물 이름"으로 나오면 → 거부 (개체 이름)
- 웹 검색 결과가 "강아지 이름", "애완동물 이름", "개체 이름"으로 나오면 반드시 거부하세요
- 생물학적 분류 태그(계, 문, 강)만 사용해주세요 (종, 속, 과, 목은 사용하지 않음)
- 일반적인 태그 "동물", "식물", "포유류", "맹수", "야생동물", "멸종위기종" 등은 만들지 마세요
- 생물학적 분류 태그는 웹 검색을 통해 정확한 정보를 확인하여 추천해주세요
- 각 분류 단계는 별도의 태그로 구분해주세요
- 예: "고양이" (종명) → "포유강, 척삭동물문, 동물계"
- 예: "사람" (종명) → "포유강, 척삭동물문, 동물계"
- 예: "장미" (종명) → "쌍자엽식물강, 속씨식물문, 식물계"
- "기타" 카테고리에서 "생물"로 변경된 경우에도 반드시 생물학적 종명인지 확인하고, 개체 이름이면 거부하세요
- 생물 카테고리는 계, 문, 강 3개 태그만 사용하세요`;
    
    const prompt = `다음 항목이 "${category}" 카테고리의 항목으로 적절한지 검토하고, 적절한 태그를 추천해주세요.

***앱의 목적: 초성 검색 앱***
이 앱은 사용자가 초성을 입력하여 일반적인 검색어, 단어, 항목을 찾는 데 사용됩니다.
따라서 개인적인 이름, 개체 이름, 애완동물 이름 등은 부적절하며 거부해야 합니다.

카테고리: ${category}
이름: ${name}${descriptionText}

${categoryDescription}
${categoryPrompt}
${biologyPrompt}

현재 사용 중인 태그 목록: ${existingTagsText}

***모든 카테고리 공통 검토 기준 (매우 중요):***
- 개인적인 이름, 개체 이름, 애완동물 이름, 강아지 이름, 고양이 이름 등은 모든 카테고리에서 거부하세요
- 일반적인 검색어, 단어, 항목만 허용합니다
- **중요: 웹 검색 결과를 반드시 확인하여 판단하세요**
  * 웹 검색 결과가 "강아지 이름", "애완동물 이름", "개체 이름", "반려동물 이름", "개인 이름"으로 나오면 → 즉시 거부
  * 웹 검색 결과가 일반적인 단어, 검색어, 항목으로 나오면 → 허용
- 예시 (명확히 개체 이름인 경우):
  * "요미" → 웹 검색 결과가 "강아지 이름"으로 나오면 → 거부
  * "뽀삐" → 웹 검색 결과가 "강아지 이름"으로 나오면 → 거부
- 예시 (애매한 경우 - 웹 검색 결과로 판단):
  * "초코" → 웹 검색 결과가 "초콜릿", "음식"으로 나오면 → 허용 (일반 단어)
  * "초코" → 웹 검색 결과가 "강아지 이름"으로 나오면 → 거부 (개체 이름)
  * "나비" → 웹 검색 결과가 "곤충", "동물"로 나오면 → 허용 (일반 단어)
  * "나비" → 웹 검색 결과가 "강아지 이름"으로 나오면 → 거부 (개체 이름)
- 예시 (개인 이름 - 웹 검색 결과로 판단):
  * "철수" → 웹 검색 결과가 특정 유명인물(배우, 가수, 정치인 등)로 나오면 → 허용 (유명인물)
  * "철수" → 웹 검색 결과가 일반적인 이름으로만 나오거나 특정 인물이 없으면 → 거부 (일반 개인 이름)
  * "영희", "민수" 등도 동일하게 웹 검색 결과를 확인하여 판단하세요

중요: 이 항목이 실제로 존재하는지 웹 검색으로 반드시 확인해주세요. 특히 게임 아이템, 영화 제목, 인물 이름 등은 실제로 존재하는 항목인지 판단해주세요. 
- 게임 아이템의 경우: 
  * 사용자 설명이 있으면: 웹 검색으로 설명에 명시된 게임에서 실제로 존재하는지 검증
  * 설명과 실제 정보가 다르면 반드시 거부하거나 정확한 정보로 수정
  * 설명이 없으면: 웹 검색으로 어떤 게임의 아이템인지 확인
- 영화의 경우: 실제로 존재하는 영화 제목인지 웹 검색으로 확인
- 인물의 경우: 실제로 존재하는 인물인지 웹 검색으로 확인
- 모든 카테고리 공통:
  * 웹 검색 결과가 "강아지 이름", "애완동물 이름", "개체 이름", "반려동물 이름", "개인 이름"으로 나오면 즉시 거부하세요
  * 개인적인 이름, 개체 이름은 초성 검색 앱의 목적에 맞지 않으므로 거부해야 합니다
  * 예: "요미"가 "강아지 이름"으로 검색되면 → 거부 (모든 카테고리)
  * 예: "뽀삐"가 "애완동물 이름"으로 검색되면 → 거부 (모든 카테고리)
- 생물 카테고리의 경우 (매우 중요):
  * 반드시 생물학적 종명(종의 이름)인지 확인하세요
  * 웹 검색 결과가 "강아지 이름", "애완동물 이름", "개체 이름", "반려동물 이름"으로 나오면 즉시 거부하세요
  * 예: "요미"가 "강아지 이름"으로 검색되면 → 거부 (생물학적 종명이 아님)
  * 예: "개"가 "동물의 종"으로 검색되면 → 승인 (생물학적 종명)
  * 생물 카테고리는 오직 생물학적 종명만 허용합니다
- 사용자 설명이 있으면 반드시 웹 검색으로 검증하고, 설명과 다르면 거부해주세요
- 존재하지 않거나 부적절한 내용이면 거부해주세요

***반드시 JSON 형식으로만 답변해주세요. 다른 텍스트는 포함하지 마세요.***

다음 JSON 형식으로 정확하게 답변해주세요:
{
  "approved": true 또는 false,
  "reason": "이유 (한 줄, 웹 검색 결과를 바탕으로 실제 존재 여부를 포함하여 설명)",
  "category": "카테고리 (현재 카테고리가 '기타'인 경우에만, 기존 카테고리 목록 중 적합한 것을 추천하거나 '기타' 유지, 없으면 null)",
  "tags": ["태그1", "태그2", "태그3"] 또는 []
}

태그 규칙:
- 기존 태그 목록(${existingTagsText})을 우선 사용하고, 기존 태그로 표현 가능하면 새로운 태그를 만들지 않음
- 카테고리와 중복 제외, 모순 태그 동시 사용 금지, 핵심 태그만 (최대 3개), 구체적 태그 우선
- "생물" 카테고리인 경우 생물학적 분류 태그(계, 문, 강)만 사용 (최대 3개)
- 태그는 반드시 배열 형식으로 제공하고, 각 태그는 문자열로 제공
- 태그가 없으면 빈 배열 [] 제공

예시 (일반):
{
  "approved": true,
  "reason": "웹 검색 결과 실제 존재하는 게임 아이템으로 확인되었습니다.",
  "category": null,
  "tags": ["게임명", "MMORPG", "아이템"]
}

예시 (기타 카테고리인 경우):
{
  "approved": true,
  "reason": "웹 검색 결과 게임 관련 항목으로 확인되었습니다.",
  "category": "게임",
  "tags": ["게임명", "MMORPG", "온라인게임"]
}

예시 (거부):
{
  "approved": false,
  "reason": "웹 검색 결과 해당 항목이 존재하지 않거나 부적절한 내용입니다.",
  "category": null,
  "tags": []
}

***중요: 반드시 유효한 JSON 형식으로만 답변하고, JSON 외의 다른 텍스트는 포함하지 마세요.***`;

    const payload = {
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      tools: [{
        googleSearch: {}
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
    const responseBody = response.getContentText();
    
    if (responseCode !== 200) {
      Logger.log('Gemini API 오류 응답 코드: ' + responseCode);
      Logger.log('Gemini API 오류 응답 내용: ' + responseBody);
      Logger.log('사용한 모델: ' + GEMINI_MODEL);
      Logger.log('사용한 URL: ' + GEMINI_API_URL);
      
      // 429 오류 (할당량 초과)인 경우 사용자 친화적인 메시지
      if (responseCode === 429) {
        throw new Error('Gemini API 할당량을 초과했습니다. 잠시 후 다시 시도해주세요.');
      }
      
      throw new Error('Gemini API 호출 실패: ' + responseCode + ' - ' + responseBody);
    }
    
    let responseData;
    try {
      responseData = JSON.parse(responseBody);
      Logger.log('JSON 파싱 성공');
    } catch (parseError) {
      Logger.log('JSON 파싱 실패: ' + parseError.toString());
      Logger.log('응답 본문 (처음 500자): ' + responseBody.substring(0, 500));
      throw new Error('Gemini API 응답 파싱 실패: ' + parseError.toString());
    }
    
    // 응답 구조 확인
    Logger.log('응답 구조 확인 시작');
    if (!responseData.candidates) {
      Logger.log('응답에 candidates가 없음');
      Logger.log('응답 데이터: ' + JSON.stringify(responseData).substring(0, 500));
      throw new Error('Gemini API 응답에 candidates가 없습니다.');
    }
    if (!responseData.candidates[0]) {
      Logger.log('응답에 candidates[0]이 없음');
      throw new Error('Gemini API 응답에 candidates[0]이 없습니다.');
    }
    if (!responseData.candidates[0].content) {
      Logger.log('응답에 content가 없음');
      Logger.log('candidates[0]: ' + JSON.stringify(responseData.candidates[0]).substring(0, 500));
      throw new Error('Gemini API 응답에 content가 없습니다.');
    }
    if (!responseData.candidates[0].content.parts || !responseData.candidates[0].content.parts[0]) {
      Logger.log('응답에 parts가 없음');
      Logger.log('content: ' + JSON.stringify(responseData.candidates[0].content).substring(0, 500));
      throw new Error('Gemini API 응답에 parts가 없습니다.');
    }
    if (!responseData.candidates[0].content.parts[0].text) {
      Logger.log('응답에 text가 없음');
      Logger.log('parts[0]: ' + JSON.stringify(responseData.candidates[0].content.parts[0]).substring(0, 500));
      throw new Error('Gemini API 응답에 text가 없습니다.');
    }
    
    // 토큰 사용량 추출
    const tokensUsed = responseData.usageMetadata?.totalTokenCount || 0;
    Logger.log('토큰 사용량: ' + tokensUsed);
    
    // 응답 파싱 (JSON 형식)
    let responseText = responseData.candidates[0].content.parts[0].text;
    Logger.log('응답 텍스트 (전체): ' + responseText);
    
    // JSON 추출 (코드 블록이나 마크다운 제거)
    let jsonText = responseText.trim();
    
    // ```json 또는 ``` 코드 블록 제거
    if (jsonText.startsWith('```')) {
      const lines = jsonText.split('\n');
      const startIndex = lines.findIndex(line => line.trim().startsWith('```'));
      const endIndex = lines.findIndex((line, idx) => idx > startIndex && line.trim().startsWith('```'));
      if (startIndex >= 0 && endIndex > startIndex) {
        jsonText = lines.slice(startIndex + 1, endIndex).join('\n').trim();
      } else if (startIndex >= 0) {
        jsonText = lines.slice(startIndex + 1).join('\n').trim();
      }
    }
    
    // JSON 객체만 추출 (중괄호로 시작하고 끝나는 부분)
    const jsonStart = jsonText.indexOf('{');
    const jsonEnd = jsonText.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      jsonText = jsonText.substring(jsonStart, jsonEnd + 1);
    }
    
    Logger.log('추출된 JSON 텍스트: ' + jsonText);
    
    // JSON 파싱
    let result;
    try {
      result = JSON.parse(jsonText);
    } catch (parseError) {
      Logger.log('JSON 파싱 실패, 재시도 요청');
      // JSON 파싱 실패 시 재시도 (최대 1회)
      throw new Error('JSON 형식이 올바르지 않습니다. 재시도가 필요합니다: ' + parseError.toString());
    }
    
    // 필수 필드 확인
    if (typeof result.approved !== 'boolean') {
      Logger.log('approved 필드가 없거나 boolean이 아님, 재시도 요청');
      throw new Error('응답 형식이 올바르지 않습니다. approved 필드가 필요합니다.');
    }
    
    const approved = result.approved;
    const reason = result.reason || '이유 없음';
    let recommendedCategory = result.category || category; // category가 없으면 원래 카테고리 유지
    let recommendedTags = Array.isArray(result.tags) ? result.tags : [];
    
    Logger.log('파싱된 결과:', { approved, reason, category: recommendedCategory, tags: recommendedTags });
    
    // 카테고리 검증 (기존 카테고리 목록에 있는지 확인)
    if (category === '기타' && recommendedCategory && recommendedCategory !== '기타') {
      const existingCategories = getExistingCategories();
      if (existingCategories.indexOf(recommendedCategory) === -1) {
        Logger.log('추천된 카테고리가 기존 목록에 없음, 원래 카테고리 유지');
        recommendedCategory = category; // 기존 목록에 없으면 원래 카테고리 유지
      }
    } else if (category !== '기타') {
      recommendedCategory = category; // 기타가 아니면 원래 카테고리 유지
    }
    
    Logger.log('최종 승인 여부: ' + approved);
    
    // 태그 검증 및 정리
    const finalTags = [];
    const tagsMap = {};
    
    for (let i = 0; i < recommendedTags.length; i++) {
      let tag = recommendedTags[i];
      if (!tag || typeof tag !== 'string') continue;
      
      tag = tag.trim();
      if (tag.length === 0 || tag.length >= 30) continue; // 최대 30자 제한
      
      const tagLower = tag.toLowerCase();
      
      // 중복 제거 (대소문자 구분 없이)
      if (!tagsMap[tagLower]) {
        tagsMap[tagLower] = true;
        finalTags.push(tag);
      }
    }
    
    // 생물 카테고리는 계, 문, 강 3개만 허용
    const finalCategoryForTagLimit = (category === '기타' && recommendedCategory && recommendedCategory !== '기타') ? recommendedCategory : category;
    if (finalCategoryForTagLimit === '생물' || recommendedCategory === '생물') {
      // 최대 3개로 제한
      if (finalTags.length > 3) {
        Logger.log('생물 카테고리 태그가 3개를 초과하여 제한: ' + finalTags.length + '개 -> 3개');
        finalTags.splice(3);
      }
    } else {
      // 생물이 아닌 경우 최대 7개로 제한
      if (finalTags.length > 7) {
        Logger.log('태그가 7개를 초과하여 제한: ' + finalTags.length + '개 -> 7개');
        finalTags.splice(7);
      }
    }
    
    return {
      approved: approved,
      reason: reason, // 파싱된 reason 사용 (JSON 코드 블록 제외)
      category: recommendedCategory, // 추천된 카테고리 (기타인 경우 변경될 수 있음)
      tags: finalTags, // 기존 태그 + 새로운 태그 모두 포함
      tokensUsed: tokensUsed
    };
    
  } catch (error) {
    Logger.log('=== Gemini API 오류 발생 ===');
    Logger.log('오류 타입: ' + (error.name || 'Unknown'));
    Logger.log('오류 메시지: ' + error.toString());
    Logger.log('오류 스택: ' + (error.stack || 'No stack trace'));
    Logger.log('카테고리: ' + category);
    Logger.log('이름: ' + name);
    Logger.log('설명: ' + (description || '없음'));
    Logger.log('==========================');
    // 오류 발생 시 기본적으로 거부
    return {
      approved: false,
      reason: '검토 중 오류가 발생했습니다: ' + error.toString(),
      tags: [],
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
 * 태그를 태그 시트에 동기화 (카테고리별, 중복 제거)
 * @param {Array} tags - 태그 배열
 * @param {string} category - 카테고리
 */
function syncTagsToSheet(tags, category) {
  if (!tags || tags.length === 0 || !category) return;
  
  const sheet = getOrCreateSheet(SHEET_TAGS);
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['카테고리', '태그']);
  }
  
  // 기존 태그 목록 가져오기 (해당 카테고리의 태그만)
  const existingTags = [];
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    // A열: 카테고리, B열: 태그
    if (data[i].length >= 2 && data[i][0] && data[i][0].toString().trim() === category) {
      const tag = data[i][1] ? data[i][1].toString().trim() : '';
      if (tag) {
        existingTags.push(tag.toLowerCase());
      }
    }
  }
  
  // 새로운 태그만 추가
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i].trim();
    if (tag && existingTags.indexOf(tag.toLowerCase()) === -1) {
      sheet.appendRow([category, tag]);
      existingTags.push(tag.toLowerCase());
    }
  }
  
  // 즉시 반영을 위해 flush 호출 (캐시 문제 해결)
  SpreadsheetApp.flush();
}

/**
 * 카테고리를 카테고리 시트에 동기화 (중복 제거)
 */
function syncCategoryToSheet(category) {
  if (!category) return;
  
  const sheet = getOrCreateSheet(SHEET_CATEGORIES);
  
  // 헤더 확인 및 추가
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['카테고리']);
  }
  
  // 기존 카테고리 목록 확인
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i].length >= 1 && data[i][0] && data[i][0].toString().trim().toLowerCase() === category.toLowerCase()) {
      return; // 이미 존재
    }
  }
  
  // 새로운 카테고리 추가
  sheet.appendRow([category]);
  SpreadsheetApp.flush();
}

/**
 * 성공 응답 생성
 * @param {string} message - 성공 메시지
 * @param {Object} data - 추가 데이터 (카테고리, 태그 등)
 */
function createSuccessResponse(message, data) {
  const response = {
    success: true,
    message: message
  };
  
  if (data) {
    Object.assign(response, data);
  }
  
  // HTML Service를 사용하여 CORS 문제 우회
  const htmlOutput = HtmlService.createHtmlOutput(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
    </head>
    <body>
      <script>
        (function() {
          try {
            console.log('[Apps Script] 오류 응답 전송 시도:', ${JSON.stringify(response)});
            
            // 부모 창에 메시지 전송 (CORS 우회)
            if (window.parent && window.parent !== window) {
              console.log('[Apps Script] postMessage 전송:', window.parent);
              window.parent.postMessage(${JSON.stringify(response)}, '*');
              
              // 추가로 window.top에도 시도
              if (window.top && window.top !== window && window.top !== window.parent) {
                window.top.postMessage(${JSON.stringify(response)}, '*');
              }
            } else {
              console.log('[Apps Script] 직접 접근 - JSON 표시');
              // 직접 접근한 경우 JSON 표시
              document.body.textContent = JSON.stringify(${JSON.stringify(response)}, null, 2);
            }
          } catch (error) {
            console.error('[Apps Script] postMessage 오류:', error);
            document.body.textContent = '오류: ' + error.toString();
          }
        })();
      </script>
    </body>
    </html>
  `);
  
  return htmlOutput.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 오류 응답 생성
 * @param {string} message - 오류 메시지
 * @param {Object} data - 추가 데이터 (거부 사유 등)
 */
function createErrorResponse(message, data) {
  const response = {
    success: false,
    message: message
  };
  
  if (data) {
    Object.assign(response, data);
  }
  
  // HTML Service를 사용하여 CORS 문제 우회
  const htmlOutput = HtmlService.createHtmlOutput(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
    </head>
    <body>
      <script>
        (function() {
          try {
            console.log('[Apps Script] 오류 응답 전송 시도:', ${JSON.stringify(response)});
            
            // 부모 창에 메시지 전송 (CORS 우회)
            if (window.parent && window.parent !== window) {
              console.log('[Apps Script] postMessage 전송:', window.parent);
              window.parent.postMessage(${JSON.stringify(response)}, '*');
              
              // 추가로 window.top에도 시도
              if (window.top && window.top !== window && window.top !== window.parent) {
                window.top.postMessage(${JSON.stringify(response)}, '*');
              }
            } else {
              console.log('[Apps Script] 직접 접근 - JSON 표시');
              // 직접 접근한 경우 JSON 표시
              document.body.textContent = JSON.stringify(${JSON.stringify(response)}, null, 2);
            }
          } catch (error) {
            console.error('[Apps Script] postMessage 오류:', error);
            document.body.textContent = '오류: ' + error.toString();
          }
        })();
      </script>
    </body>
    </html>
  `);
  
  return htmlOutput.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

