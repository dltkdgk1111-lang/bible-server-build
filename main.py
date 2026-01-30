import sys
import os
import json
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

# ==========================================
# [중요] 윈도우 실행 에러 방지 코드 (수정됨)
# ==========================================
# --noconsole 옵션으로 실행 시 sys.stdout이 None이 되어 발생하는 에러 해결
if sys.platform.startswith('win'):
    if sys.stdout is not None:
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except AttributeError:
            pass

app = FastAPI()

# CORS 설정 (옵시디언 플러그인과 통신하기 위해 필수)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 모든 출처 허용
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 전역 변수: 성경 데이터
BIBLE_DATA = {}

def get_base_path():
    """실행 파일 위치를 안전하게 찾는 함수"""
    if getattr(sys, 'frozen', False):
        # PyInstaller로 패키징된 경우 (.exe 위치)
        return os.path.dirname(sys.executable)
    else:
        # 일반 파이썬 스크립트로 실행된 경우
        return os.path.dirname(os.path.abspath(__file__))

def load_bible():
    """bible.json 파일을 로드합니다."""
    global BIBLE_DATA
    base_path = get_base_path()
    file_path = os.path.join(base_path, "bible.json")

    print(f"Loading bible from: {file_path}")
    
    if not os.path.exists(file_path):
        print("Error: bible.json not found!")
        return

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            BIBLE_DATA = json.load(f)
        print("Bible data loaded successfully.")
    except Exception as e:
        print(f"Failed to load bible.json: {e}")

# 서버 시작 시 데이터 로드
load_bible()

# --- 데이터 모델 ---
class SearchQuery(BaseModel):
    query: str

class ReadQuery(BaseModel):
    book: str
    chapter: int
    start: int
    end: Optional[int] = None

# --- API 엔드포인트 ---

@app.get("/")
def health_check():
    """서버가 살아있는지 확인"""
    return {"status": "ok", "books_count": len(BIBLE_DATA)}

@app.post("/search")
def search_bible(q: SearchQuery):
    """
    검색 기능
    1. '사랑' -> 전체 검색
    2. '출:사랑' -> 출애굽기에서 '사랑' 검색
    """
    query_text = q.query.strip()
    results = []
    
    # "책이름: 검색어" 형태인지 확인
    target_book = None
    keyword = query_text

    if ":" in query_text:
        parts = query_text.split(":", 1)
        target_book = parts[0].strip()
        keyword = parts[1].strip()

    count = 0
    LIMIT = 100  # 너무 많이 뜨면 렉 걸리니까 제한

    for book_name, chapters in BIBLE_DATA.items():
        # 특정 책 검색일 경우 필터링 (예: '창'이 포함된 책)
        if target_book and target_book not in book_name:
            continue

        for chap_num, verses in chapters.items():
            for verse_num, content in verses.items():
                if keyword in content:
                    results.append({
                        "book": book_name,
                        "chapter": chap_num,
                        "verse": verse_num,
                        "content": content
                    })
                    count += 1
                    if count >= LIMIT:
                        return {"results": results, "message": "Too many results"}

    return {"results": results}

@app.post("/read")
def read_bible(q: ReadQuery):
    """성경 본문 읽기 (book, chapter, start~end)"""
    # 책 이름 찾기 (부분 일치 허용)
    found_book = None
    for book_name in BIBLE_DATA.keys():
        if q.book in book_name: # 예: "창" -> "창세기"
            found_book = book_name
            break
    
    if not found_book:
        raise HTTPException(status_code=404, detail="Book not found")

    chapter_str = str(q.chapter)
    if chapter_str not in BIBLE_DATA[found_book]:
        raise HTTPException(status_code=404, detail="Chapter not found")

    verses = BIBLE_DATA[found_book][chapter_str]
    result_verses = []

    # 시작절부터 끝절까지 가져오기
    start = q.start
    end = q.end if q.end else q.start # 끝절 없으면 시작절만

    for v_num in range(start, end + 1):
        v_str = str(v_num)
        if v_str in verses:
            result_verses.append({
                "verse": v_num,
                "content": verses[v_str]
            })

    return {
        "book": found_book,
        "chapter": q.chapter,
        "verses": result_verses
    }

if __name__ == "__main__":
    # 포트 8000번에서 실행
    uvicorn.run(app, host="127.0.0.1", port=8000)
