# -*- coding: utf-8 -*-
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import json
import os
import re
import uvicorn
import sys

# 윈도우 한글 깨짐 방지
if sys.platform.startswith('win'):
    sys.stdout.reconfigure(encoding='utf-8')

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BIBLE_JSON_PATH = os.path.join(BASE_DIR, "bible.json")
bible_data = {}

try:
    with open(BIBLE_JSON_PATH, 'r', encoding='utf-8') as f:
        bible_data = json.load(f)
except Exception as e:
    print(f"Error loading bible.json: {e}")

# 1. 약어 -> 풀네임 매핑
BIBLE_MAP = {
    "창세기": "창", "출애굽기": "출", "레위기": "레", "민수기": "민", "신명기": "신",
    "여호수아": "수", "사사기": "삿", "룻기": "룻", "사무엘상": "삼상", "사무엘하": "삼하",
    "열왕기상": "왕상", "열왕기하": "왕하", "역대상": "대상", "역대하": "대하", "에스라": "스",
    "느헤미야": "느", "에스더": "에", "욥기": "욥", "시편": "시", "잠언": "잠",
    "전도서": "전", "아가": "아", "이사야": "사", "예레미야": "렘", "예레미야애가": "애",
    "에스겔": "겔", "다니엘": "단", "호세아": "호", "요엘": "욜", "아모스": "암",
    "오바댜": "옵", "요나": "욘", "미가": "미", "나훔": "나", "하박국": "합",
    "스바냐": "습", "학개": "학", "스가랴": "슥", "말라기": "말",
    "마태복음": "마", "마가복음": "막", "누가복음": "누", "요한복음": "요", "사도행전": "행",
    "로마서": "롬", "고린도전서": "고전", "고린도후서": "고후", "갈라디아서": "갈", "에베소서": "엡",
    "빌립보서": "빌", "골로새서": "골", "데살로니가전서": "살전", "데살로니가후서": "살후",
    "디모데전서": "딤전", "디모데후서": "딤후", "디도서": "딛", "빌레몬서": "몬", "히브리서": "히",
    "야고보서": "약", "베드로전서": "벧전", "베드로후서": "벧후", "요한일서": "요일", "요한이서": "요이",
    "요한삼서": "요삼", "유다서": "유", "요한계시록": "계"
}
BIBLE_MAP_REV = {v: k for k, v in BIBLE_MAP.items()}

# 정규식 1: 성경 주소 파싱 (출 3:1) - 숫자가 반드시 있어야 함
PARSE_REGEX = re.compile(r"([가-힣]+)\s*([0-9]+(?:[-~][0-9]+)?)(?:[:장\s]*([0-9]+(?:[-~,][0-9]+)*))?")

# 정규식 2: [NEW] 범위 한정 검색 (출 : 사랑) - 콜론(:)이 있어야 함
SCOPED_SEARCH_REGEX = re.compile(r"^([가-힣]+)\s*[:]\s*(.+)$")

@app.get("/search")
def search_bible(query: str = Query(..., description="검색어")):
    query = query.strip()
    query_clean = query.replace("절", "")
    
    final_items = []
    
    # ----------------------------------------------------
    # 1. 성경 주소 검색 (예: 출 3:1, 창 1장)
    # ----------------------------------------------------
    matches = PARSE_REGEX.findall(query_clean)
    if matches:
        for book_raw, chapter_str, verses_str in matches:
            book_short = BIBLE_MAP.get(book_raw, book_raw)
            book_full = BIBLE_MAP_REV.get(book_short, book_short) 
            
            target_chapters = []
            if '-' in chapter_str or '~' in chapter_str:
                try:
                    c_start, c_end = re.split(r'[-~]', chapter_str)
                    target_chapters = list(range(int(c_start), int(c_end) + 1))
                except: target_chapters = [chapter_str] 
            else:
                target_chapters = [chapter_str]

            for chapter in target_chapters:
                target_verses = []
                if not verses_str: # 전체 장
                    v_num = 1
                    while True:
                        key_check = f"{book_short}{chapter}:{v_num}"
                        if key_check in bible_data:
                            target_verses.append(str(v_num))
                            v_num += 1
                        else: break
                else: # 특정 절
                    parts = re.split(r'[,]', verses_str)
                    for part in parts:
                        part = part.strip()
                        if '-' in part or '~' in part:
                            try:
                                v_start, v_end = re.split(r'[-~]', part)
                                for v in range(int(v_start), int(v_end) + 1):
                                    target_verses.append(str(v))
                            except: continue
                        else: target_verses.append(part)

                found_data = []
                for v in target_verses:
                    key = f"{book_short}{chapter}:{v}"
                    text = bible_data.get(key)
                    if text: found_data.append((v, text))

                if found_data:
                    text_default = "\n".join([f"{v}. {t}" for v, t in found_data])
                    text_clean = "\n".join([t for v, t in found_data])
                    text_ref = "\n".join([f"{book_full} {chapter}:{v} - {t}" for v, t in found_data])

                    first_v = found_data[0][0]
                    last_v = found_data[-1][0]
                    count_v = len(found_data)

                    if not verses_str:
                        display_title = f"{book_full} {chapter}장 ({count_v}절)"
                        display_footer = f"{book_full} {chapter}장 {first_v}-{last_v}절"
                        ref_pure = f"{book_full} {chapter}장"
                    else:
                        display_title = f"{book_full} {chapter}:{verses_str}"
                        if count_v == 1: display_footer = f"{book_full} {chapter}장 {first_v}절"
                        else: display_footer = f"{book_full} {chapter}장 {first_v}-{last_v}절"
                        ref_pure = display_title

                    final_items.append({
                        "title": display_title,
                        "subtitle": "Enter: 전체 | Cmd: 본문만 | Opt: 주소+본문",
                        "arg": text_default,
                        "pure_ref": ref_pure,
                        "full_body": text_default,
                        "footer_text": display_footer,
                        "mods": {
                            "cmd": {"valid": True, "arg": text_clean, "subtitle": "본문만 복사"},
                            "alt": {"valid": True, "arg": text_ref, "subtitle": "주소와 함께 복사"}
                        },
                        "icon": {"path": "Images/app.png"}, 
                        "valid": True
                    })
                    # 개별 구절 리스트
                    for v, t in found_data:
                        final_items.append({
                            "title": f"{v}절",
                            "subtitle": t,
                            "arg": text_default,
                            "mods": {
                                "cmd": {"valid": True, "arg": text_clean},
                                "alt": {"valid": True, "arg": text_ref}
                            },
                            "valid": True
                        })
        if final_items:
            return {"items": final_items}

    # ----------------------------------------------------
    # 2. [NEW] 범위 한정 검색 (예: 출 : 사랑)
    # ----------------------------------------------------
    scoped_match = SCOPED_SEARCH_REGEX.match(query)
    if scoped_match:
        book_input, keyword = scoped_match.groups()
        keyword = keyword.strip()
        
        # 책 이름 변환 (출애굽기 -> 출)
        target_book_short = BIBLE_MAP.get(book_input, book_input)
        target_book_full = BIBLE_MAP_REV.get(target_book_short, target_book_short)

        if not keyword:
            return {"items": [{"title": "검색어를 입력하세요", "subtitle": f"{target_book_full}에서 검색할 단어 입력", "valid": False}]}

        count = 0
        limit = 50
        
        for key, text in bible_data.items():
            # 키(key)가 해당 책 이름으로 시작하는지 확인 (예: '출1:1'은 '출'로 시작함)
            # 정확도를 위해 '출' 뒤에 숫자가 오는지도 체크하면 좋음
            if key.startswith(target_book_short):
                 # 본문에 검색어가 있는지 확인
                 if keyword in text:
                    # 키 파싱 (출1:1)
                    m = re.match(r"([가-힣]+)([0-9]+)[:]([0-9]+)", key)
                    if m:
                        b, c, v = m.groups()
                        full_ref = f"{target_book_full} {c}:{v}"
                        
                        final_items.append({
                            "title": f"{full_ref} : {text}",
                            "subtitle": "Enter: 복사",
                            "arg": f"{full_ref} - {text}",
                            "mods": {
                                "cmd": {"valid": True, "arg": text, "subtitle": "본문만 복사"},
                                "alt": {"valid": True, "arg": full_ref, "subtitle": "주소만 복사"}
                            },
                            "icon": {"path": "Images/search.png"},
                            "valid": True
                        })
                        count += 1
                        if count >= limit: break
        
        if not final_items:
             return {"items": [{"title": "검색 결과 없음", "subtitle": f"{target_book_full}에서 '{keyword}'를 찾을 수 없습니다.", "valid": False}]}
        return {"items": final_items}

    # ----------------------------------------------------
    # 3. 성경 전체 단어 검색 (예: 사랑)
    # ----------------------------------------------------
    # 위의 두 경우가 아니면 전체 검색으로 간주
    if len(query) < 1:
        return {"items": [{"title": "검색어를 입력하세요", "subtitle": "2글자 이상 입력", "valid": False}]}
    
    count = 0
    limit = 50
    
    for key, text in bible_data.items():
        if query in text:
            m = re.match(r"([가-힣]+)([0-9]+)[:]([0-9]+)", key)
            if m:
                b_short, ch, v = m.groups()
                b_full = BIBLE_MAP_REV.get(b_short, b_short)
                full_ref = f"{b_full} {ch}:{v}"
                
                final_items.append({
                    "title": f"{full_ref} : {text}",
                    "subtitle": "Enter: 복사",
                    "arg": f"{full_ref} - {text}",
                    "mods": {
                        "cmd": {"valid": True, "arg": text, "subtitle": "본문만 복사"},
                        "alt": {"valid": True, "arg": full_ref, "subtitle": "주소만 복사"}
                    },
                    "icon": {"path": "Images/search.png"},
                    "valid": True
                })
                count += 1
                if count >= limit: break

    if not final_items:
         return {"items": [{"title": "검색 결과 없음", "subtitle": f"'{query}'에 대한 결과를 찾을 수 없습니다.", "valid": False}]}

    return {"items": final_items}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)