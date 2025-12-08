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
    // e.parameter는 URL 파라미터나 POST 데이터만 포함하며, IP 주소는 포함되지 않습니다.
    // 실제 IP 추적이 필요한 경우 다른 방법(로그 분석 등)을 사용해야 합니다.
    // 여기서는 'unknown'을 기본값으로 사용하여 로컬 테스트를 허용합니다.
    const ipAddress = 'unknown';
    
    Logger.log('IP 주소: ' + ipAddress + ' (Apps Script에서는 IP를 직접 가져올 수 없음)');
    
    // 입력 검증
    const validation = validateInput(category, name);
    if (!validation.valid) {
      return createErrorResponse(validation.message);
    }
    
    // 중복 확인 (카테고리별로 체크)
    if (isDuplicate(name, category)) {
      return createErrorResponse(`이미 등록된 항목입니다. (${category} 카테고리)`);
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
    
    // Gemini API로 자동 검토 및 태그 추천
    const reviewResult = reviewWithGemini(category, name, description);
    
    if (reviewResult.approved) {
      // 카테고리가 변경되었으면 변경된 카테고리 사용
      const finalCategory = reviewResult.category || category;
      
      // 승인된 경우 메인 시트에 추가 (태그 포함)
      addToMainSheet(finalCategory, name, reviewResult.tags || []);
      
      // 태그와 카테고리를 별도 시트에 동기화
      syncTagsToSheet(reviewResult.tags || [], finalCategory);
      syncCategoryToSheet(finalCategory);
      
      // 카테고리가 변경되었으면 로그에 기록
      let statusMessage = reviewResult.reason;
      if (category === '기타' && finalCategory !== '기타') {
        statusMessage = `[카테고리 자동 변경: ${category} → ${finalCategory}]\n${reviewResult.reason}`;
      }
      
      updateRegistrationStatus(requestId, '승인됨', statusMessage, reviewResult.tokensUsed);
      
      // 토큰 사용량 업데이트
      updateTokenUsage(reviewResult.tokensUsed);
      
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
    } else {
      // 거부된 경우
      updateRegistrationStatus(requestId, '거부됨', reviewResult.reason, reviewResult.tokensUsed);
      
      // 토큰 사용량 업데이트
      updateTokenUsage(reviewResult.tokensUsed);
      
      // 거부 응답에 사유 포함
      return createErrorResponse('등록 신청이 거부되었습니다: ' + reviewResult.reason, {
        reason: reviewResult.reason
      });
    }
    
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return createErrorResponse('서버 오류가 발생했습니다: ' + error.toString());
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

다음 형식으로 답변해주세요:
***반드시 첫 줄에 "승인" 또는 "거부" 중 하나만 한 단어로만 작성하세요***
- 첫 줄에 "승인" 또는 "거부"만 작성하고, 그 아래에 이유를 작성하세요
- 첫 줄에 다른 설명을 추가하지 마세요
- 예: 첫 줄이 "승인"이면 → 승인
- 예: 첫 줄이 "거부"이면 → 거부
- 혼란을 피하기 위해 첫 줄에는 "승인" 또는 "거부"만 작성하세요

승인 또는 거부 (첫 줄에 한 단어로만)
이유 (한 줄, 웹 검색 결과를 바탕으로 실제 존재 여부를 포함하여 설명)
적절한 카테고리 (현재 카테고리가 "기타"인 경우에만, 기존 카테고리 목록 중 적합한 것을 추천하거나 "기타" 유지, 없으면 생략)
- 반드시 "적절한 카테고리:" 또는 "카테고리:" 라는 라벨과 함께 한 줄에 명확하게 표시해주세요
- 예: "적절한 카테고리: 생물" 또는 "카테고리: 생물"
추천 태그 (기존 태그 목록에서 적절한 태그만 사용, 쉼표로 구분, 없으면 "없음")
   - 원칙: 기존 태그 목록(${existingTagsText})을 우선 사용하고, 기존 태그로 표현 가능하면 새로운 태그를 만들지 않음
   - 태그 규칙:
     * 카테고리와 중복 제외, 모순 태그 동시 사용 금지, 핵심 태그만 (최대 7개), 구체적 태그 우선
     * 기존 태그로 의미 전달 가능하면 새 태그 추가하지 않음
     * "생물" 카테고리인 경우 생물학적 분류 태그(계, 문, 강)만 사용 (최대 3개)
   - 태그는 번호 없이 태그 이름만 쉼표로 구분
   - 각 태그는 반드시 쉼표(,)로 구분하고, 태그 이름 사이에 공백은 없어야 함
   - 예: "태그1,태그2,태그3" (올바름) / "태그1, 태그2, 태그3" (가능하지만 공백 없이 권장) / "태그1 태그2" (잘못됨)

예시 (일반):
승인
웹 검색 결과 실제 존재하는 게임 아이템으로 확인되었습니다.
게임명,MMORPG,아이템

예시 (기타 카테고리인 경우):
승인
웹 검색 결과 게임 관련 항목으로 확인되었습니다.
게임
게임명,MMORPG,온라인게임

또는

거부
웹 검색 결과 해당 항목이 존재하지 않거나 부적절한 내용입니다.
없음

예시 (거부 - 개체 이름):
거부
웹 검색 결과 "요미"는 강아지 이름으로 확인되었습니다. 초성 검색 앱의 목적에 맞지 않는 개체 이름이므로 거부합니다.
없음

예시 (거부 - 개인 이름):
거부
웹 검색 결과 "철수"는 일반적인 개인 이름으로 확인되었습니다. 초성 검색 앱의 목적에 맞지 않는 개인 이름이므로 거부합니다.
없음`;

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
    
    // 응답 파싱
    const responseText = responseData.candidates[0].content.parts[0].text;
    Logger.log('응답 텍스트 길이: ' + responseText.length);
    Logger.log('응답 텍스트 (처음 200자): ' + responseText.substring(0, 200));
    Logger.log('응답 텍스트 (전체): ' + responseText);
    const textLower = responseText.toLowerCase();
    
    // 거부 키워드를 먼저 확인 (안전 우선)
    const hasReject = textLower.includes('거부') || textLower.includes('reject') || textLower.includes('deny');
    const hasApprove = textLower.includes('승인') || textLower.includes('approve');
    
    // 첫 줄 확인 (프롬프트에서 "승인 또는 거부 (한 단어로만)" 지시)
    const firstLine = responseText.split('\n')[0].trim().toLowerCase();
    const firstLineReject = firstLine.includes('거부') || firstLine.includes('reject') || firstLine.includes('deny');
    const firstLineApprove = firstLine.includes('승인') || firstLine.includes('approve');
    
    // 판단 로직: 거부가 명시되어 있으면 무조건 거부, 첫 줄이 명확하면 그것을 우선
    let approved = false;
    if (firstLineReject) {
      approved = false;
      Logger.log('첫 줄에서 거부 확인');
    } else if (firstLineApprove && !hasReject) {
      approved = true;
      Logger.log('첫 줄에서 승인 확인 (거부 키워드 없음)');
    } else if (hasReject) {
      approved = false;
      Logger.log('응답에 거부 키워드 발견');
    } else if (hasApprove) {
      approved = true;
      Logger.log('응답에 승인 키워드 발견');
    } else {
      // 키워드가 없으면 기본적으로 거부 (안전 우선)
      approved = false;
      Logger.log('승인/거부 키워드가 없어 기본적으로 거부');
    }
    
    Logger.log('최종 승인 여부: ' + approved);
    
    // 카테고리 추출 (기타 카테고리인 경우에만)
    let recommendedCategory = category; // 기본값은 원래 카테고리
    const lines = responseText.split('\n');
    
    if (category === '기타') {
      // 기존 카테고리 목록 가져오기
      const existingCategories = getExistingCategories();
      
      // 응답에서 카테고리 찾기
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // 카테고리 키워드가 있는 줄 찾기
        if (line.includes('카테고리') || (i > 0 && lines[i-1].trim().includes('이유'))) {
          // "카테고리:" 뒤의 내용 추출
          let categoryLine = line;
          const colonIndex = categoryLine.indexOf(':');
          if (colonIndex >= 0) {
            categoryLine = categoryLine.substring(colonIndex + 1).trim();
          }
          
          // 기존 카테고리 목록과 비교
          for (let j = 0; j < existingCategories.length; j++) {
            const existingCat = existingCategories[j];
            if (categoryLine.includes(existingCat) || categoryLine === existingCat) {
              recommendedCategory = existingCat;
              break;
            }
          }
          
          // 다음 줄도 확인
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            for (let j = 0; j < existingCategories.length; j++) {
              const existingCat = existingCategories[j];
              if (nextLine === existingCat || nextLine.includes(existingCat)) {
                recommendedCategory = existingCat;
                break;
              }
            }
          }
          
          if (recommendedCategory !== category) {
            break;
          }
        }
      }
      
      // 카테고리를 찾지 못한 경우, 응답 전체에서 기존 카테고리 찾기
      if (recommendedCategory === '기타') {
        // "생물" 카테고리를 우선 확인 (동물/식물 관련 항목일 가능성이 높음)
        if (responseText.includes('생물') && existingCategories.indexOf('생물') >= 0) {
          // 생물 관련 키워드 확인
          const biologyKeywords = ['동물', '식물', '생물', '포유', '조류', '어류', '곤충', '과', '속', '종', '목', '강', '문', '계'];
          const hasBiologyKeyword = biologyKeywords.some(keyword => {
            const keywordIndex = responseText.toLowerCase().indexOf(keyword.toLowerCase());
            if (keywordIndex >= 0) {
              const context = responseText.substring(Math.max(0, keywordIndex - 30), Math.min(responseText.length, keywordIndex + 30));
              return context.includes('생물') || context.includes('동물') || context.includes('식물');
            }
            return false;
          });
          
          if (hasBiologyKeyword) {
            recommendedCategory = '생물';
            Logger.log('생물 관련 키워드 발견, 카테고리를 "생물"로 변경');
          }
        }
        
        // 다른 카테고리도 확인
        if (recommendedCategory === '기타') {
          for (let j = 0; j < existingCategories.length; j++) {
            const existingCat = existingCategories[j];
            if (responseText.includes(existingCat) && existingCat !== '기타' && existingCat !== '생물') {
              // 해당 카테고리가 문맥상 적절한지 확인 (단순 포함이 아닌)
              const catIndex = responseText.indexOf(existingCat);
              const beforeText = responseText.substring(Math.max(0, catIndex - 20), catIndex);
              const afterText = responseText.substring(catIndex, Math.min(responseText.length, catIndex + existingCat.length + 20));
              
              // 카테고리가 추천 맥락에서 나온 경우
              if (beforeText.includes('카테고리') || beforeText.includes('추천') || 
                  afterText.includes('적절') || afterText.includes('추천')) {
                recommendedCategory = existingCat;
                break;
              }
            }
          }
        }
      }
    }
    
    // 태그 추출 (기존 태그 + 새로운 태그 모두 포함)
    let recommendedTags = [];
    
    Logger.log('태그 추출 시작, 응답 텍스트:', responseText);
    
    // 여러 방법으로 태그 추출 시도
    // 방법 1: "태그:" 또는 "추천 태그:" 키워드가 있는 줄 찾기
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // "태그" 키워드가 있는 줄 찾기
      if (line.includes('태그') || (line.includes('추천') && i + 1 < lines.length)) {
        let tagLine = line;
        
        // "태그:" 뒤의 내용 추출
        const colonIndex = tagLine.indexOf(':');
        if (colonIndex >= 0) {
          tagLine = tagLine.substring(colonIndex + 1).trim();
        }
        
        // 같은 줄에서 태그 추출
        if (tagLine && tagLine !== '없음' && !tagLine.includes('승인') && !tagLine.includes('거부')) {
          const tagsInLine = tagLine.split(/[,，\s]+/).map(function(tag) {
            // 번호와 점 제거 (예: "4. 바람의나라" -> "바람의나라")
            tag = tag.trim().replace(/^\d+\.\s*/, '').trim();
            return tag;
          }).filter(function(tag) {
            return tag && tag !== '없음' && tag.length > 0 && tag.length < 50; // 너무 긴 태그 제외
          });
          if (tagsInLine.length > 0) {
            recommendedTags = tagsInLine;
            Logger.log('같은 줄에서 태그 추출:', recommendedTags);
            break;
          }
        }
        
        // 다음 줄 확인
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine && !nextLine.includes('승인') && !nextLine.includes('거부') && 
              !nextLine.includes('이유') && !nextLine.includes('카테고리') && 
              nextLine !== '없음') {
            const tagsInNextLine = nextLine.split(/[,，\s]+/).map(function(tag) {
              // 번호와 점 제거 (예: "4. 바람의나라" -> "바람의나라")
              tag = tag.trim().replace(/^\d+\.\s*/, '').trim();
              return tag;
            }).filter(function(tag) {
              return tag && tag !== '없음' && tag.length > 0 && tag.length < 50;
            });
            if (tagsInNextLine.length > 0) {
              recommendedTags = tagsInNextLine;
              Logger.log('다음 줄에서 태그 추출:', recommendedTags);
              break;
            }
          }
        }
      }
    }
    
    // 방법 2: 응답 전체에서 쉼표로 구분된 태그 패턴 찾기 (마지막 3줄)
    if (recommendedTags.length === 0) {
      const lastLines = lines.slice(Math.max(0, lines.length - 3));
      for (let i = 0; i < lastLines.length; i++) {
        const line = lastLines[i].trim();
        if (line.includes(',') && !line.includes('승인') && !line.includes('거부') && 
            !line.includes('이유') && !line.includes('카테고리')) {
          const tagsInLine = line.split(/[,，]/).map(function(tag) {
            // 번호와 점 제거 (예: "4. 바람의나라" -> "바람의나라")
            tag = tag.trim().replace(/^\d+\.\s*/, '').trim();
            return tag;
          }).filter(function(tag) {
            return tag && tag !== '없음' && tag.length > 0 && tag.length < 50;
          });
          if (tagsInLine.length > 0) {
            recommendedTags = tagsInLine;
            Logger.log('마지막 줄에서 태그 추출:', recommendedTags);
            break;
          }
        }
      }
    }
    
    // 태그를 찾지 못한 경우, 쉼표가 있는 줄에서 태그 추출 시도
    if (recommendedTags.length === 0) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // 숫자나 특수문자로 시작하지 않고 쉼표가 있는 줄
        // 카테고리 추출 후 태그가 나올 수 있는 위치 확인
        if (line.includes(',') && !line.match(/^\d/) && !line.includes('승인') && !line.includes('거부') && !line.includes('이유')) {
          // 카테고리 추출이 이미 끝난 후의 줄인지 확인
          let isAfterCategory = false;
          for (let j = 0; j < i; j++) {
            if (lines[j].trim().includes('카테고리') || (category === '기타' && lines[j].trim() !== '승인' && lines[j].trim() !== '거부' && lines[j].trim().length > 0 && lines[j].trim().length < 20)) {
              isAfterCategory = true;
              break;
            }
          }
          
          if (isAfterCategory || category !== '기타') {
            const tagsInLine = line.split(/[,，]/).map(function(tag) {
              // 번호와 점 제거 (예: "4. 바람의나라" -> "바람의나라")
              tag = tag.trim().replace(/^\d+\.\s*/, '').trim();
              // 앞뒤 공백 및 특수문자 제거
              tag = tag.replace(/^[\s\-_]+|[\s\-_]+$/g, '').trim();
              return tag;
            }).filter(function(tag) {
              // 태그 유효성 검사: 빈 문자열, "없음", 너무 긴 태그 제외
              return tag && tag !== '없음' && tag.length > 0 && tag.length < 50;
            });
            // 생물 카테고리는 최대 3개(계, 문, 강), 그 외는 최대 15개
            // recommendedCategory가 이미 추출되었는지 확인
            const finalCategoryForTags = (category === '기타' && recommendedCategory && recommendedCategory !== '기타') ? recommendedCategory : category;
            const maxTags = (finalCategoryForTags === '생물' || recommendedCategory === '생물') ? 3 : 15;
            if (tagsInLine.length > 0 && tagsInLine.length <= maxTags) {
              recommendedTags = tagsInLine;
              break;
            }
          }
        }
      }
    }
    
    // 추출된 태그에서 기존 태그와 새로운 태그 분리
    const existingTagsLower = existingTags.map(function(tag) {
      return tag.toLowerCase();
    });
    
    // 기존 태그와 새로운 태그 모두 포함 (중복 제거)
    const finalTags = [];
    const tagsMap = {};
    
    for (let i = 0; i < recommendedTags.length; i++) {
      let tag = recommendedTags[i];
      // 번호와 점 제거 (예: "4. 바람의나라" -> "바람의나라")
      tag = tag.replace(/^\d+\.\s*/, '').trim();
      // 앞뒤 불필요한 문자 제거
      tag = tag.replace(/^[^\w가-힣]+|[^\w가-힣]+$/g, '').trim();
      
      if (!tag || tag.length === 0 || tag.length >= 50) continue;
      
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
    }
    
    return {
      approved: approved,
      reason: responseText,
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

