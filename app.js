// 전역 변수
const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTNgKTsKcqDr4etDeuMtzfJqlFDfsDuCTRA3AgGdUtaIimSGV6Jc-kUO2zEEUf3MJbfic_21tnjo3oz/pub?output=csv';
// Apps Script 웹 앱 URL
const APPS_SCRIPT_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzXkUvDc47reTLF2GgMW114LJMJ_lIxuVuBMkWVx8ClNApwHF4VRaG1VTx4nnlg_zVcSg/exec';
let database = [];
let filteredDatabase = [];
let searchHistory = []; // { query: string, timestamp: number } 형식
let searchStartTime = null;
let searchTimer = null;
let categories = new Set();
let selectedCategory = 'all';
let selectedTags = []; // 선택된 태그 배열
let availableTags = new Set(); // 현재 카테고리의 사용 가능한 태그
let debounceTimer = null;

// 성능 설정
const MAX_RESULTS = 500; // 최대 검색 결과 수

// 초성 리스트
const CHOSEONG_LIST = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

// DOM 요소
const choseongInput = document.getElementById('choseongInput');
const resultsList = document.getElementById('resultsList');
const resultsCount = document.getElementById('resultsCount');
const categoryFilter = document.getElementById('categoryFilter');
const tagFilterContainer = document.getElementById('tagFilterContainer');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const clearInputBtn = document.getElementById('clearInputBtn');
const refreshBtn = document.getElementById('refreshBtn');
const registerBtn = document.getElementById('registerBtn');
const registerModal = document.getElementById('registerModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const cancelRegisterBtn = document.getElementById('cancelRegisterBtn');
const submitRegisterBtn = document.getElementById('submitRegisterBtn');
const registerNameInput = document.getElementById('registerNameInput');
const registerCategorySelect = document.getElementById('registerCategorySelect');
const registerDescriptionInput = document.getElementById('registerDescriptionInput');
const registerStatus = document.getElementById('registerStatus');
const loadingOverlay = document.getElementById('loadingOverlay');
const notification = document.getElementById('notification');

// X 버튼 표시/숨김 업데이트
function updateClearButtonVisibility() {
    if (choseongInput.value.trim().length > 0) {
        clearInputBtn.classList.add('visible');
    } else {
        clearInputBtn.classList.remove('visible');
    }
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
    loadHistory();
    loadData();
    setupEventListeners();
    updateClearButtonVisibility();
});

// 복합 자음을 분리하는 함수 (ㄼ -> ㄹㅂ)
function splitComplexChoseong(char) {
    const complexChoseongMap = {
        'ㄳ': 'ㄱㅅ',
        'ㄵ': 'ㄴㅈ',
        'ㄶ': 'ㄴㅎ',
        'ㄺ': 'ㄹㄱ',
        'ㄻ': 'ㄹㅁ',
        'ㄼ': 'ㄹㅂ',
        'ㄽ': 'ㄹㅅ',
        'ㄾ': 'ㄹㅌ',
        'ㄿ': 'ㄹㅍ',
        'ㅀ': 'ㄹㅎ',
        'ㅄ': 'ㅂㅅ'
    };
    return complexChoseongMap[char] || char;
}

// 한글 문자를 초성으로 변환하는 함수
function convertToChoseong(text) {
    if (!text) return '';
    
    const result = [];
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const code = char.charCodeAt(0);
        
        // 한글 완성형 범위 (가-힣)
        if (code >= 0xAC00 && code <= 0xD7A3) {
            const choseongIndex = Math.floor((code - 0xAC00) / 588);
            const choseong = CHOSEONG_LIST[choseongIndex];
            console.log('[DEBUG] 한글 변환:', char, '(코드:', code, ') ->', choseong);
            result.push(choseong);
            continue;
        }
        
        // 이미 초성인 경우 (ㄱ~ㅎ)
        if (CHOSEONG_LIST.includes(char)) {
            result.push(char);
            continue;
        }
        
        // 공백은 유지
        if (char === ' ') {
            result.push(char);
            continue;
        }
        
        // 한글 자모 영역 (0x3131~0x318E) - 복합 자음 포함
        if (code >= 0x3131 && code <= 0x318E) {
            // 복합 자음인 경우 분리
            const split = splitComplexChoseong(char);
            if (split !== char) {
                console.log('[DEBUG] 복합 자음 분리:', char, '(코드:', code, ') ->', split);
                // 분리된 자음을 각각 추가
                result.push(...split.split(''));
                continue;
            }
            // 일반 자모인 경우 그대로 반환 (이미 초성 리스트에 있으면 위에서 처리됨)
            console.log('[DEBUG] 한글 자모:', char, '코드:', code);
            result.push(char);
            continue;
        }
        
        // 받침 영역 (0x11A8~0x11FF)
        if (code >= 0x11A8 && code <= 0x11FF) {
            const jongseongIndex = code - 0x11A8;
            const jongseongToChoseong = {
                8: 0,   // ㄱ
                9: 1,   // ㄲ
                10: 0,  // ㄳ -> ㄱ
                11: 3,  // ㄴ
                12: 3,  // ㄵ -> ㄴ
                13: 3,  // ㄶ -> ㄴ
                14: 6,  // ㄷ
                15: 7,  // ㄹ
                16: 7,  // ㄺ -> ㄹ
                17: 7,  // ㄻ -> ㄹ
                18: 7,  // ㄼ -> ㄹ
                19: 7,  // ㄽ -> ㄹ
                20: 7,  // ㄾ -> ㄹ
                21: 7,  // ㄿ -> ㄹ
                22: 7,  // ㅀ -> ㄹ
                23: 15, // ㅁ
                24: 16, // ㅂ
                25: 16, // ㅄ -> ㅂ
                26: 18, // ㅅ
                27: 19, // ㅆ
                28: 20, // ㅇ
                29: 21, // ㅈ
                30: 22, // ㅊ
                31: 23, // ㅋ
                32: 24, // ㅌ
                33: 25, // ㅍ
                34: 26  // ㅎ
            };
            
            if (jongseongIndex in jongseongToChoseong) {
                const choseongIdx = jongseongToChoseong[jongseongIndex];
                const choseong = CHOSEONG_LIST[choseongIdx];
                console.log('[DEBUG] 받침 변환:', char, '(코드:', code, ') ->', choseong);
                result.push(choseong);
                continue;
            }
        }
        
        // 그 외는 제거
        console.log('[DEBUG] 제거된 문자:', char, '코드:', code);
    }
    
    return result.join('');
}

// 이벤트 리스너 설정
function setupEventListeners() {
    // 초성 입력 - composition 이벤트로 한글 입력 처리
    let isComposing = false;
    let lastProcessedValue = '';
    
    // 입력값 처리 및 검색 실행 함수
    function handleInput(value) {
        if (!value) {
            performSearch('');
            return;
        }
        
        // 한글 자음과 공백만 허용, 한글 완성형은 초성으로 변환
        const converted = convertToChoseong(value);
        
        // 값이 변경되었으면 입력 필드 업데이트
        if (value !== converted) {
            choseongInput.value = converted;
        }
        
        // 마지막 처리된 값과 다르면 검색 실행
        if (converted !== lastProcessedValue) {
            lastProcessedValue = converted;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                performSearch(converted);
            }, 100);
        }
    }
    
    choseongInput.addEventListener('compositionstart', () => {
        isComposing = true;
        console.log('[DEBUG] compositionstart');
    });
    
    choseongInput.addEventListener('compositionupdate', (e) => {
        console.log('[DEBUG] compositionupdate:', e.data, 'value:', e.target.value);
        // composition 중에도 실시간 검색 수행
        handleInput(e.target.value);
    });
    
    choseongInput.addEventListener('compositionend', (e) => {
        isComposing = false;
        console.log('[DEBUG] compositionend, value:', e.target.value);
        // compositionend 후 약간의 지연 후 처리 (값이 완전히 반영되도록)
        setTimeout(() => {
            handleInput(e.target.value);
        }, 10);
    });
    
    choseongInput.addEventListener('input', (e) => {
        const value = e.target.value;
        console.log('[DEBUG] input event, isComposing:', isComposing, 'value:', value);
        
        // composition 중이어도 실시간 검색 수행 (compositionupdate와 함께)
        handleInput(value);
        // X 버튼 표시/숨김 업데이트
        updateClearButtonVisibility();
    });

    // 카테고리 필터
    categoryFilter.addEventListener('change', (e) => {
        selectedCategory = e.target.value;
        selectedTags = []; // 카테고리 변경 시 태그 초기화
        updateTagFilter();
        performSearch(choseongInput.value);
    });

    // 검색 히스토리
    clearHistoryBtn.addEventListener('click', clearHistory);

    // 입력 지우기 버튼
    clearInputBtn.addEventListener('click', () => {
        choseongInput.value = '';
        choseongInput.focus();
        performSearch('');
        updateClearButtonVisibility();
    });

    // 데이터 새로고침
    refreshBtn.addEventListener('click', () => {
        loadData();
    });

    // 정답 등록 모달
    registerBtn.addEventListener('click', () => {
        openRegisterModal();
    });

    closeModalBtn.addEventListener('click', closeRegisterModal);
    cancelRegisterBtn.addEventListener('click', closeRegisterModal);

    // 모달 외부 클릭 시 닫기
    registerModal.addEventListener('click', (e) => {
        if (e.target === registerModal) {
            closeRegisterModal();
        }
    });

    // 정답 등록 제출 (UI만 구현)
    submitRegisterBtn.addEventListener('click', () => {
        handleRegisterSubmit();
    });


    // Enter 키로 검색
    choseongInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            performSearch(choseongInput.value);
        }
    });

    // 메뉴 버튼 토글
    const menuBtn = document.getElementById('menuBtn');
    const menuDropdown = document.getElementById('menuDropdown');
    
    if (menuBtn && menuDropdown) {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuDropdown.classList.toggle('active');
        });

        // 메뉴 외부 클릭 시 닫기
        document.addEventListener('click', (e) => {
            if (!menuBtn.contains(e.target) && !menuDropdown.contains(e.target)) {
                menuDropdown.classList.remove('active');
            }
        });
    }
}

// 초성 변환 함수
function getChoseong(text) {
    return text.split('').map(char => {
        const code = char.charCodeAt(0);
        if (code >= 0xAC00 && code <= 0xD7A3) {
            // 한글 완성형
            const choseongIndex = Math.floor((code - 0xAC00) / 588);
            return CHOSEONG_LIST[choseongIndex];
        }
        return char;
    }).join('');
}

// 구글 시트 데이터 로딩
async function loadData() {
    showLoading();
    
    try {
        // 캐시 버스터 추가 (CSV 캐시 문제 해결)
        const cacheBuster = '?t=' + Date.now();
        const sheetUrl = DEFAULT_SHEET_URL + (DEFAULT_SHEET_URL.includes('?') ? '&' : '?') + 't=' + Date.now();
        const response = await fetch(sheetUrl, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache'
            }
        });
        
        if (!response.ok) {
            throw new Error('데이터를 불러올 수 없습니다.');
        }
        
        const csvText = await response.text();
        const lines = csvText.split('\n').filter(line => line.trim());
        
        // 헤더 제거
        if (lines.length > 0 && lines[0].includes('카테고리')) {
            lines.shift();
        }
        
        const oldDatabaseLength = database.length;
        database = [];
        categories.clear();
        
        lines.forEach((line, index) => {
            // CSV 파싱 (쉼표로 분리, 따옴표 처리)
            const parts = parseCSVLine(line);
            if (parts.length >= 2) {
                const category = parts[0].trim();
                // 태그 컬럼 처리 (B열, 선택사항)
                let tags = [];
                if (parts.length >= 3 && parts[1].trim()) {
                    // 태그가 있으면 쉼표로 분리
                    tags = parts[1].trim().split(',').map(tag => tag.trim()).filter(tag => tag);
                }
                // 이름은 C열 (parts[2]) 또는 B열(태그가 없는 경우 parts[1])
                const name = (parts.length >= 3 ? parts[2] : parts[1]).trim();
                
                if (category && name) {
                    const choseong = getChoseong(name);
                    database.push({
                        t: category,
                        tags: tags,
                        n: name,
                        c: choseong
                    });
                    categories.add(category);
                } else if (parts.length >= 2) {
                    // 디버깅: 파싱 실패한 라인 로그
                    console.warn('[DEBUG] 파싱 실패한 라인:', index + 2, parts);
                }
            }
        });
        
        // 디버깅: 데이터 로드 확인
        console.log('[DEBUG] 데이터 로드 완료:', database.length, '개 항목 (이전:', oldDatabaseLength, '개)');
        if (database.length > 0) {
            console.log('[DEBUG] 최근 5개 항목:', database.slice(-5).map(item => ({ name: item.n, category: item.t, tags: item.tags })));
        }
        
        updateCategoryFilter();
        updateTagFilter();
        performSearch(choseongInput.value);
        showNotification('데이터 로딩 완료!', 'success');
        
    } catch (error) {
        console.error('데이터 로딩 실패:', error);
        showNotification('데이터를 불러올 수 없습니다. 다시 시도해주세요.', 'error');
        resultsList.innerHTML = '<p class="empty-message">데이터 로딩 실패</p>';
    } finally {
        hideLoading();
    }
}

// CSV 라인 파싱 (쉼표와 따옴표 처리)
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current);
    return result;
}

// 카테고리 필터 업데이트
function updateCategoryFilter() {
    categoryFilter.innerHTML = '<option value="all">전체</option>';
    
    const sortedCategories = Array.from(categories).sort();
    sortedCategories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        categoryFilter.appendChild(option);
    });
}

// 태그 필터 업데이트 (카테고리 선택 시)
function updateTagFilter() {
    if (!tagFilterContainer) return;
    
    // 태그 컨테이너 초기화
    tagFilterContainer.innerHTML = '';
    
    if (selectedCategory === 'all') {
        // 전체 선택 시 태그 필터 숨김
        tagFilterContainer.style.display = 'none';
        selectedTags = [];
        return;
    }
    
    // 해당 카테고리의 태그 수집
    availableTags.clear();
    const tagCounts = {}; // 태그별 아이템 개수
    
    database.forEach(item => {
        if (item.t === selectedCategory && item.tags && item.tags.length > 0) {
            item.tags.forEach(tag => {
                availableTags.add(tag);
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        }
    });
    
    if (availableTags.size === 0) {
        // 태그가 없으면 태그 필터 숨김
        tagFilterContainer.style.display = 'none';
        selectedTags = [];
        return;
    }
    
    // 태그 필터 표시
    tagFilterContainer.style.display = 'block';
    
    const tagLabel = document.createElement('label');
    tagLabel.textContent = '태그:';
    tagLabel.style.fontSize = '15px';
    tagLabel.style.fontWeight = '500';
    tagLabel.style.marginRight = '12px';
    tagLabel.style.color = '#212529';
    tagFilterContainer.appendChild(tagLabel);
    
    const tagList = document.createElement('div');
    tagList.className = 'tag-list';
    tagList.style.display = 'flex';
    tagList.style.flexWrap = 'wrap';
    tagList.style.gap = '8px';
    tagList.style.marginTop = '8px';
    
    // 태그를 개수 순으로 정렬 (많은 순)
    const sortedTags = Array.from(availableTags).sort((a, b) => {
        return (tagCounts[b] || 0) - (tagCounts[a] || 0);
    });
    
    // "전체" 옵션 추가
    const allTagCheckbox = document.createElement('input');
    allTagCheckbox.type = 'checkbox';
    allTagCheckbox.id = 'tag-all';
    allTagCheckbox.checked = selectedTags.length === 0;
    allTagCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            selectedTags = [];
            // 다른 체크박스 모두 해제
            tagList.querySelectorAll('input[type="checkbox"]:not(#tag-all)').forEach(cb => {
                cb.checked = false;
            });
        }
        performSearch(choseongInput.value);
    });
    
    const allTagLabel = document.createElement('label');
    allTagLabel.htmlFor = 'tag-all';
    allTagLabel.textContent = '전체';
    allTagLabel.className = 'tag-item';
    allTagLabel.style.cursor = 'pointer';
    allTagLabel.style.fontSize = '14px';
    allTagLabel.style.color = '#212529';
    
    const allTagWrapper = document.createElement('div');
    allTagWrapper.style.display = 'flex';
    allTagWrapper.style.alignItems = 'center';
    allTagWrapper.style.gap = '6px';
    allTagWrapper.appendChild(allTagCheckbox);
    allTagWrapper.appendChild(allTagLabel);
    tagList.appendChild(allTagWrapper);
    
    // 각 태그 체크박스 생성
    sortedTags.forEach(tag => {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `tag-${tag}`;
        checkbox.value = tag;
        checkbox.checked = selectedTags.includes(tag);
        checkbox.addEventListener('change', (e) => {
            // "전체" 체크박스 해제
            allTagCheckbox.checked = false;
            
            if (e.target.checked) {
                selectedTags.push(tag);
            } else {
                selectedTags = selectedTags.filter(t => t !== tag);
            }
            
            // 태그가 모두 해제되면 "전체" 자동 선택
            if (selectedTags.length === 0) {
                allTagCheckbox.checked = true;
            }
            
            performSearch(choseongInput.value);
        });
        
        const label = document.createElement('label');
        label.htmlFor = `tag-${tag}`;
        label.textContent = `${tag} (${tagCounts[tag]})`;
        label.className = 'tag-item';
        label.style.cursor = 'pointer';
        label.style.fontSize = '14px';
        label.style.color = '#212529';
        
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '6px';
        wrapper.appendChild(checkbox);
        wrapper.appendChild(label);
        tagList.appendChild(wrapper);
    });
    
    tagFilterContainer.appendChild(tagList);
}

// 검색 수행
function performSearch(query) {
    if (!query || !query.trim()) {
        resultsList.innerHTML = '<p class="empty-message">초성을 입력하면 검색 결과가 표시됩니다</p>';
        resultsCount.textContent = '';
        // 검색이 비어있으면 타이머 리셋
        if (searchTimer) {
            clearTimeout(searchTimer);
            searchTimer = null;
        }
        searchStartTime = null;
        return;
    }
    
    const searchQuery = query.trim();
    
    // 검색어가 변경되었는지 확인
    let lastSearchQuery = choseongInput.getAttribute('data-last-search') || '';
    if (lastSearchQuery !== searchQuery) {
        // 검색어가 변경되었으므로 시간 리셋
        searchStartTime = Date.now();
        choseongInput.setAttribute('data-last-search', searchQuery);
    } else if (!searchStartTime) {
        // 처음 시작
        searchStartTime = Date.now();
    }
    
    // 이전 타이머 클리어
    if (searchTimer) {
        clearTimeout(searchTimer);
    }
    
    // 1.5초 이상 유지된 검색어만 히스토리에 추가
    // 타이머가 실행될 때 현재 입력값을 다시 확인하여 최신 값 사용
    searchTimer = setTimeout(() => {
        // 타이머 실행 시점의 현재 입력값 확인 (최신 값 보장)
        const finalQuery = choseongInput.value.trim();
        const duration = Date.now() - searchStartTime;
        
        // 최소 1.5초 이상 유지되고, 값이 있고, 마지막으로 저장한 검색어와 같으면 등록
        if (duration >= 1500 && finalQuery && finalQuery === searchQuery) {
            // 중복 확인 (최근 10개만 확인)
            const recentQueries = searchHistory.slice(0, 10).map(h => h.query);
            if (!recentQueries.includes(finalQuery)) {
                searchHistory.unshift({
                    query: finalQuery,
                    timestamp: Date.now()
                });
                // 최대 20개만 유지
                if (searchHistory.length > 20) {
                    searchHistory.pop();
                }
                saveHistory();
                updateHistoryDisplay();
            }
        }
        searchStartTime = null;
        searchTimer = null;
    }, 1500);
    
    // 검색 수행 - 성능 최적화: 필터링 순서 조정
    let results = database;
    
    // 1단계: 카테고리 필터링 (검색 대상 축소)
    if (selectedCategory !== 'all') {
        results = results.filter(item => item.t === selectedCategory);
    }
    
    // 2단계: 태그 필터링 (검색 대상 추가 축소)
    if (selectedTags.length > 0) {
        results = results.filter(item => {
            // 태그가 없는 아이템은 제외
            if (!item.tags || item.tags.length === 0) {
                return false;
            }
            // 선택한 태그 중 하나라도 포함되어 있으면 포함
            return selectedTags.some(tag => item.tags.includes(tag));
        });
    }
    
    // 3단계: 초성 검색 (가장 비용이 큰 작업을 마지막에)
    if (searchQuery) {
        results = results.filter(item => {
            return item.c && item.c.includes(searchQuery);
        });
    }
    
    // 4단계: 검색 결과 제한 (성능 보호)
    if (results.length > MAX_RESULTS) {
        results = results.slice(0, MAX_RESULTS);
    }
    
    displayResults(results);
    
    // 결과 개수 표시
    if (results.length > 0) {
        const displayCount = results.length;
        // 실제 총 결과 수 계산 (제한 전)
        let totalCount = displayCount;
        if (displayCount >= MAX_RESULTS) {
            // 제한된 경우 실제 개수를 다시 계산
            let tempResults = database;
            if (selectedCategory !== 'all') {
                tempResults = tempResults.filter(item => item.t === selectedCategory);
            }
            if (selectedTags.length > 0) {
                tempResults = tempResults.filter(item => {
                    if (!item.tags || item.tags.length === 0) return false;
                    return selectedTags.some(tag => item.tags.includes(tag));
                });
            }
            if (searchQuery) {
                totalCount = tempResults.filter(item => item.c.includes(searchQuery)).length;
            } else {
                totalCount = tempResults.length;
            }
        }
        
        if (totalCount > MAX_RESULTS) {
            resultsCount.textContent = `총 ${totalCount}개 중 ${displayCount}개 표시 (최대 ${MAX_RESULTS}개)`;
        } else {
            resultsCount.textContent = `총 ${displayCount}개 결과`;
        }
    } else {
        resultsCount.textContent = '';
    }
}

// 검색 결과 표시
function displayResults(results) {
    if (results.length === 0) {
        resultsList.innerHTML = '<p class="empty-message">검색 결과가 없습니다</p>';
        return;
    }
    
    resultsList.innerHTML = '';
    
    results.forEach(item => {
        const resultItem = document.createElement('div');
        resultItem.className = 'result-item';
        
        const leftSection = document.createElement('div');
        leftSection.className = 'result-left';
        
        const categorySpan = document.createElement('span');
        categorySpan.className = 'result-category';
        categorySpan.textContent = `[${item.t}]`;
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'result-name';
        nameSpan.textContent = item.n;
        
        leftSection.appendChild(categorySpan);
        leftSection.appendChild(nameSpan);
        
        // 태그가 있으면 표시
        if (item.tags && item.tags.length > 0) {
            const tagsContainer = document.createElement('div');
            tagsContainer.className = 'result-tags';
            
            item.tags.forEach(tag => {
                const tagSpan = document.createElement('span');
                tagSpan.className = 'result-tag';
                tagSpan.textContent = tag;
                tagsContainer.appendChild(tagSpan);
            });
            
            resultItem.appendChild(leftSection);
            resultItem.appendChild(tagsContainer);
        } else {
            resultItem.appendChild(leftSection);
        }
        
        // 전체 항목 클릭 시 복사
        resultItem.addEventListener('click', () => {
            copyToClipboard(item.n);
        });
        
        resultsList.appendChild(resultItem);
    });
}

// 클립보드 복사
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showNotification('클립보드에 복사되었습니다', 'success');
    } catch (error) {
        console.error('클립보드 복사 실패:', error);
        showNotification('클립보드 복사에 실패했습니다', 'error');
    }
}

// 검색 히스토리 관리
function loadHistory() {
    const saved = localStorage.getItem('searchHistory');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // 이전 형식(문자열 배열)과 새 형식(객체 배열) 모두 지원
            if (Array.isArray(parsed) && parsed.length > 0) {
                if (typeof parsed[0] === 'string') {
                    // 이전 형식: 문자열 배열을 객체 배열로 변환
                    searchHistory = parsed.map(q => ({ query: q, timestamp: Date.now() }));
                } else {
                    // 새 형식: 객체 배열
                    searchHistory = parsed;
                }
            } else {
                searchHistory = [];
            }
            updateHistoryDisplay();
        } catch (error) {
            console.error('히스토리 로드 실패:', error);
            searchHistory = [];
        }
    }
}

function saveHistory() {
    localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
}

function updateHistoryDisplay() {
    if (searchHistory.length === 0) {
        historyList.innerHTML = '<p class="empty-message">검색 히스토리가 없습니다</p>';
        return;
    }
    
    historyList.innerHTML = '';
    
    searchHistory.forEach((item, index) => {
        const historyItem = document.createElement('div');
        historyItem.className = 'history-item';
        
        const textSpan = document.createElement('span');
        const query = typeof item === 'string' ? item : item.query;
        textSpan.textContent = query;
        textSpan.addEventListener('click', () => {
            choseongInput.value = query;
            performSearch(query);
        });
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'history-delete';
        deleteBtn.textContent = '×';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            searchHistory.splice(index, 1);
            saveHistory();
            updateHistoryDisplay();
        });
        
        historyItem.appendChild(textSpan);
        historyItem.appendChild(deleteBtn);
        historyList.appendChild(historyItem);
    });
}

function clearHistory() {
    if (confirm('검색 히스토리를 모두 삭제하시겠습니까?')) {
        searchHistory = [];
        saveHistory();
        updateHistoryDisplay();
    }
}

// 정답 등록 모달
function openRegisterModal() {
    // 카테고리 목록 업데이트
    registerCategorySelect.innerHTML = '<option value="">선택하세요</option>';
    const sortedCategories = Array.from(categories).sort();
    sortedCategories.forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        registerCategorySelect.appendChild(option);
    });
    
    // 카테고리 자동 설정
    autoSetCategory();
    
    // 입력 필드 초기화
    registerNameInput.value = '';
    registerDescriptionInput.value = '';
    registerStatus.textContent = '';
    registerStatus.className = 'register-status';
    
    registerModal.classList.add('active');
    registerNameInput.focus();
}

function closeRegisterModal() {
    registerModal.classList.remove('active');
}

// 카테고리 자동 설정
function autoSetCategory() {
    // 우선순위 1: 정확 일치 항목 확인
    const currentSearch = choseongInput.value.trim();
    if (currentSearch) {
        const exactMatch = database.find(item => item.n === currentSearch);
        if (exactMatch) {
            registerCategorySelect.value = exactMatch.t;
            return;
        }
    }
    
    // 우선순위 2: 최근 검색 결과의 카테고리
    if (currentSearch) {
        // 성능 최적화: 검색 결과 제한
        const recentResults = database.filter(item => item.c.includes(currentSearch)).slice(0, 100);
        if (recentResults.length > 0) {
            const categoryCounts = {};
            recentResults.forEach(item => {
                categoryCounts[item.t] = (categoryCounts[item.t] || 0) + 1;
            });
            const mostCommonCategory = Object.keys(categoryCounts).reduce((a, b) => 
                categoryCounts[a] > categoryCounts[b] ? a : b
            );
            registerCategorySelect.value = mostCommonCategory;
            return;
        }
    }
    
    // 우선순위 3: 가장 빈번한 카테고리
    const categoryCounts = {};
    database.forEach(item => {
        categoryCounts[item.t] = (categoryCounts[item.t] || 0) + 1;
    });
    if (Object.keys(categoryCounts).length > 0) {
        const mostCommonCategory = Object.keys(categoryCounts).reduce((a, b) => 
            categoryCounts[a] > categoryCounts[b] ? a : b
        );
        registerCategorySelect.value = mostCommonCategory;
    }
}

// 정답 등록 제출 (UI만 구현)
function handleRegisterSubmit() {
    const name = registerNameInput.value.trim();
    const category = registerCategorySelect.value;
    const description = registerDescriptionInput ? registerDescriptionInput.value.trim() : '';
    
    // 입력 검증
    if (!name) {
        showRegisterStatus('이름을 입력해주세요.', 'error');
        return;
    }
    
    if (!category) {
        showRegisterStatus('카테고리를 선택해주세요.', 'error');
        return;
    }
    
    // 한글만 허용 검증
    const koreanRegex = /^[\uAC00-\uD7A3\s]+$/;
    if (!koreanRegex.test(name)) {
        showRegisterStatus('한글만 입력 가능합니다.', 'error');
        return;
    }
    
    if (name.length > 200) {
        showRegisterStatus('이름은 최대 200자까지 입력 가능합니다.', 'error');
        return;
    }
    
    // 중복 확인 (클라이언트 측 사전 검증)
    const duplicate = database.find(item => item.n === name);
    if (duplicate) {
        showRegisterStatus('이미 등록된 항목입니다.', 'error');
        return;
    }
    
    // Apps Script 웹 앱 URL이 설정되지 않았으면 에러
    if (!APPS_SCRIPT_WEB_APP_URL) {
        showRegisterStatus('서버 설정이 필요합니다. 관리자에게 문의하세요.', 'error');
        return;
    }
    
    // 등록 요청 전송
    submitRegistration(name, category, description);
}

// 정답 등록 API 호출
async function submitRegistration(name, category, description) {
    // 로딩 상태 표시
    showRegisterStatus('등록 신청 중...', 'success');
    submitRegisterBtn.disabled = true;
    
    console.log('[DEBUG] 등록 요청 시작:', { category, name, url: APPS_SCRIPT_WEB_APP_URL });
    
    // Apps Script 웹 앱 CORS 해결: iframe + postMessage 방식 사용
    // HTML Service를 통해 응답을 받음
    return new Promise((resolve, reject) => {
        try {
            // iframe 생성
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.name = 'apps-script-iframe-' + Date.now();
            
            // iframe 로드 이벤트 추가 (디버깅)
            iframe.onload = () => {
                console.log('[DEBUG] iframe 로드 완료:', iframe.src || iframe.name);
            };
            
            iframe.onerror = (error) => {
                console.error('[DEBUG] iframe 로드 오류:', error);
            };
            
            document.body.appendChild(iframe);
            
            // postMessage 리스너
            const messageHandler = (event) => {
                console.log('[DEBUG] postMessage 수신:', {
                    origin: event.origin,
                    data: event.data,
                    source: event.source
                });
                
                // 보안: Apps Script 도메인에서 온 메시지만 처리
                const allowedOrigins = [
                    'https://script.google.com',
                    'https://script.googleusercontent.com',
                    'https://*.googleusercontent.com'
                ];
                
                const isAllowed = allowedOrigins.some(allowed => {
                    if (allowed.includes('*')) {
                        const pattern = allowed.replace('*', '.*');
                        return new RegExp(pattern).test(event.origin);
                    }
                    return event.origin === allowed;
                });
                
                if (!isAllowed) {
                    console.log('[DEBUG] 허용되지 않은 origin:', event.origin);
                    return;
                }
                
                // 데이터가 객체인지 확인
                let result;
                if (typeof event.data === 'string') {
                    try {
                        result = JSON.parse(event.data);
                    } catch (e) {
                        console.error('[DEBUG] JSON 파싱 실패:', event.data);
                        return;
                    }
                } else if (typeof event.data === 'object' && event.data !== null) {
                    result = event.data;
                } else {
                    console.error('[DEBUG] 예상치 못한 데이터 형식:', typeof event.data, event.data);
                    return;
                }
                
                console.log('[DEBUG] 파싱된 응답:', result);
                
                // iframe과 form 제거 (안전하게)
                if (document.body.contains(iframe)) {
                    document.body.removeChild(iframe);
                }
                if (document.body.contains(form)) {
                    document.body.removeChild(form);
                }
                window.removeEventListener('message', messageHandler);
                
                if (result.success) {
                    resolve(result);
                } else {
                    reject(new Error(result.message || '등록 실패'));
                }
            };
            
            // 모든 postMessage 수신 (디버깅용)
            const debugMessageHandler = (event) => {
                console.log('[DEBUG] 모든 postMessage:', {
                    origin: event.origin,
                    data: event.data,
                    source: event.source
                });
            };
            
            window.addEventListener('message', debugMessageHandler);
            window.addEventListener('message', messageHandler);
            
            // 폼 생성하여 iframe으로 제출
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = APPS_SCRIPT_WEB_APP_URL;
            form.target = iframe.name;
            form.style.display = 'none';
            
            const categoryInput = document.createElement('input');
            categoryInput.type = 'hidden';
            categoryInput.name = 'category';
            categoryInput.value = category;
            
            const nameInput = document.createElement('input');
            nameInput.type = 'hidden';
            nameInput.name = 'name';
            nameInput.value = name;
            
            const descriptionInput = document.createElement('input');
            descriptionInput.type = 'hidden';
            descriptionInput.name = 'description';
            descriptionInput.value = description || '';
            
            form.appendChild(categoryInput);
            form.appendChild(nameInput);
            form.appendChild(descriptionInput);
            document.body.appendChild(form);
            
            // 타임아웃 설정 (30초)
            const timeoutId = setTimeout(() => {
                if (document.body.contains(iframe)) {
                    document.body.removeChild(iframe);
                }
                if (document.body.contains(form)) {
                    document.body.removeChild(form);
                }
                window.removeEventListener('message', messageHandler);
                reject(new Error('요청 시간 초과'));
            }, 30000);
            
            // 메시지 핸들러에서 타임아웃 취소
            const originalMessageHandler = messageHandler;
            const wrappedMessageHandler = (event) => {
                clearTimeout(timeoutId);
                originalMessageHandler(event);
            };
            
            window.removeEventListener('message', messageHandler);
            window.addEventListener('message', wrappedMessageHandler);
            
            form.submit();
            
            // form은 submit 후 즉시 제거하지 않음 (iframe이 로드될 때까지 유지)
            setTimeout(() => {
                if (document.body.contains(form)) {
                    document.body.removeChild(form);
                }
            }, 100);
        } catch (error) {
            reject(error);
        }
    }).then((result) => {
            // 성공 처리
            console.log('[DEBUG] 응답 데이터:', result);
            
            if (result.success) {
                // 성공 - 카테고리와 태그 정보 표시
                let successMessage = result.message || '등록 신청이 승인되었습니다.';
                
                if (result.category) {
                    if (result.originalCategory && result.originalCategory === '기타' && result.category !== '기타') {
                        successMessage += `\n\n카테고리: ${result.originalCategory} → ${result.category} (자동 변경됨)`;
                    } else {
                        successMessage += `\n\n카테고리: ${result.category}`;
                    }
                }
                
                if (result.tags && result.tags.length > 0) {
                    successMessage += `\n태그: ${result.tags.join(', ')}`;
                } else {
                    successMessage += '\n태그: 없음';
                }
                
                showRegisterStatus(successMessage, 'success');
                
            // 데이터 새로고침 (새로 등록된 항목 반영)
            // 구글 시트 CSV 반영 시간을 고려하여 재시도 로직 추가
            console.log('[DEBUG] 등록 성공, 데이터 새로고침 시작 (등록된 항목:', result.name, ')');
            
            const checkAndLoad = (retryCount = 0) => {
                const maxRetries = 5;
                const delay = 2000; // 2초마다 재시도
                
                setTimeout(() => {
                    loadData().then(() => {
                        console.log('[DEBUG] 데이터 새로고침 완료 (시도:', retryCount + 1, '), 등록된 항목 확인:', result.name);
                        const registeredItem = database.find(item => item.n === result.name);
                        
                        if (registeredItem) {
                            console.log('[DEBUG] 등록된 항목 찾음:', registeredItem);
                            console.log('[DEBUG] 초성:', registeredItem.c);
                            
                            // 검색 재실행
                            const currentQuery = choseongInput.value.trim();
                            if (currentQuery) {
                                console.log('[DEBUG] 검색 재실행, 쿼리:', currentQuery);
                                performSearch(currentQuery);
                            } else {
                                // 검색어가 없으면 등록된 항목의 초성으로 검색
                                console.log('[DEBUG] 등록된 항목의 초성으로 검색:', registeredItem.c);
                                choseongInput.value = registeredItem.c;
                                performSearch(registeredItem.c);
                            }
                        } else {
                            if (retryCount < maxRetries) {
                                console.log('[DEBUG] 등록된 항목을 찾을 수 없음, 재시도:', retryCount + 1, '/', maxRetries);
                                checkAndLoad(retryCount + 1);
                            } else {
                                console.warn('[DEBUG] 등록된 항목을 찾을 수 없음 (최대 재시도 횟수 초과):', result.name);
                                showNotification('등록은 완료되었지만 검색에 반영되지 않았습니다. 페이지를 새로고침해주세요.', 'warning');
                            }
                        }
                    }).catch(error => {
                        console.error('[DEBUG] 데이터 로드 실패:', error);
                        if (retryCount < maxRetries) {
                            checkAndLoad(retryCount + 1);
                        }
                    });
                }, delay);
            };
            
            checkAndLoad();
                
                // 5초 후 모달 닫기 (정보를 읽을 시간 제공)
                setTimeout(() => {
                    closeRegisterModal();
                }, 5000);
            } else {
                // 실패 - 거부 사유 표시
                let errorMessage = result.message || '등록 신청이 거부되었습니다.';
                
                if (result.reason) {
                    errorMessage += `\n\n거부 사유:\n${result.reason}`;
                }
                
                showRegisterStatus(errorMessage, 'error');
            }
        }).catch((error) => {
            console.error('등록 요청 실패:', error);
            showRegisterStatus(error.message || '등록 요청 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.', 'error');
        }).finally(() => {
            submitRegisterBtn.disabled = false;
        });
}

function showRegisterStatus(message, type) {
    registerStatus.textContent = message;
    registerStatus.className = `register-status ${type}`;
}


// 로딩 오버레이
function showLoading() {
    loadingOverlay.classList.add('active');
}

function hideLoading() {
    loadingOverlay.classList.remove('active');
}

// 알림 메시지
function showNotification(message, type = 'success') {
    notification.textContent = message;
    notification.className = `notification active ${type}`;
    
    setTimeout(() => {
        notification.classList.remove('active');
    }, 3000);
}

