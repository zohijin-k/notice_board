/**
 * 웹서비스설계 9주차 실습 · 백엔드 API 서버 (Node.js Express + 1,000건 대량 데이터셋)
 * 3학년 전공심화:
 *   1) 방어적 파라미터 파싱 (parseInt 10진수, 음수 방어, Math.min 100개 상한)
 *   2) ORDER BY 화이트리스트 사전 매핑 (SQL Injection 방어 & id DESC 동점자 결합)
 *   3) 오프셋 페이징 API (/api/posts) + 표준 meta Envelope
 *   4) 고성능 커서 기반(Keyset) 페이징 API (/api/posts/cursor)
 *
 * 실행 방법:
 *   1) npm install express
 *   2) node server.js
 *   3) 브라우저에서 http://localhost:3000 접속
 */

const express = require('express');
const path = require('path');
const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.disable('x-powered-by');

// 프로젝트 소스와 의존성 폴더는 공개하지 않고 게시판 화면만 제공한다.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 1,000건의 대용량 더미 게시글 데이터 생성 (1~1000)
const TOPICS = [
  'B-Tree 인덱스 구조와 LIKE %kw% 검색 튜닝 실무',
  '커서 기반(Keyset) 페이지네이션 O(log N) 탐색 원리',
  'ORDER BY SQL Injection과 화이트리스트 매핑 방어',
  'InnoDB 버퍼 풀과 LIMIT OFFSET Cache Thrashing',
  'AbortController를 이용한 비동기 Race Condition 방어',
  '300ms 디바운스(Debounce)와 프론트엔드 입력 최적화',
  'URLSearchParams와 history.pushState 뒤로가기 동기화',
  'InnoDB MVCC 메커니즘과 COUNT(*) 전수 스캔 병목',
  '복합 인덱스(Compound Index) 컬럼 순서의 황금률',
  'Redis 분산 캐시를 활용한 카운트 캐싱 아키텍처',
  'RESTful JSON 페이징 Envelope 규격 표준화',
  'ElasticSearch 역색인(Inverted Index)과 N-gram 전문 검색'
];
const AUTHORS = ['이경수', '김철수', '이영희', '박민수', '정다은', '최준호', '강서연', '윤성호'];

const POSTS = Array.from({ length: 1000 }, (_, i) => {
  const id = 1000 - i;
  const topic = TOPICS[i % TOPICS.length];
  const author = AUTHORS[i % AUTHORS.length];
  const views = Math.floor(Math.random() * 5000) + 10;
  const dateNum = String(1000 - i).padStart(4, '0');
  return {
    id,
    title: `[#${id}] ${topic}`,
    content: `게시글 ${id}번의 상세 본문 데이터입니다. DB 인덱스와 페이징 최적화를 실습합니다.`,
    author,
    views,
    createdAt: `2026-${(10 - Math.floor(i / 150)).toString().padStart(2, '0')}-${((i % 28) + 1).toString().padStart(2, '0')}`
  };
});

// null prototype 객체라 __proto__, constructor 등 상속 프로퍼티가 없다.
// 조회수 정렬은 동점일 때 id 내림차순으로 순서를 고정한다.
const SORT_WHITELIST = Object.freeze(Object.assign(Object.create(null), {
  latest: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
  views: (a, b) => (b.views !== a.views ? b.views - a.views : b.id - a.id)
}));

function scalarQuery(value) {
  return typeof value === 'string' ? value : '';
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = scalarQuery(value);
  if (!/^\d+$/.test(raw)) return fallback;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function matchesSearch(post, search) {
  return !search || post.title.toLowerCase().includes(search) || post.content.toLowerCase().includes(search);
}

// ==========================================
// 1. 오프셋 기반 페이지네이션 API
// GET /api/posts?page=1&limit=10&sort=views&search=인덱스
// ==========================================
app.get('/api/posts', (req, res) => {
  const startTime = process.hrtime();

  // 파라미터 정제 및 방어 코딩
  const page = positiveInteger(req.query.page, 1);
  const limit = positiveInteger(req.query.limit, 10, 100);
  const search = scalarQuery(req.query.search).trim().toLowerCase();
  const sortKey = scalarQuery(req.query.sort);

  // 1) 검색 필터링 (WHERE title LIKE '%search%')
  let filtered = POSTS.filter(p => matchesSearch(p, search));

  // 2) 화이트리스트 정렬 (ORDER BY ...)
  const sortComparator = Object.hasOwn(SORT_WHITELIST, sortKey)
    ? SORT_WHITELIST[sortKey]
    : SORT_WHITELIST.latest;
  filtered.sort(sortComparator);

  // 3) 오프셋 계산 및 데이터 슬라이싱
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  const diff = process.hrtime(startTime);
  const executionTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      page: safePage,
      limit,
      totalCount,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      executionTimeMs: Number(executionTimeMs)
    }
  });
});

// ==========================================
// 2. 커서 기반(Keyset) 페이지네이션 API
// GET /api/posts/cursor?cursor=950&limit=10&search=인덱스
// ==========================================
app.get('/api/posts/cursor', (req, res) => {
  const startTime = process.hrtime();

  const cursorValue = positiveInteger(req.query.cursor, null);
  const limit = positiveInteger(req.query.limit, 10, 50);
  const search = scalarQuery(req.query.search).trim().toLowerCase();

  // 검색과 커서 조건을 모두 적용한 뒤 ID 내림차순으로 고정한다.
  const candidate = POSTS
    .filter(p => matchesSearch(p, search) && (cursorValue === null || p.id < cursorValue))
    .sort((a, b) => b.id - a.id);

  // limit + 1개를 조회하여 다음 데이터 존재 여부(hasNext) 판단 (COUNT(*) 제거)
  const sliced = candidate.slice(0, limit + 1);
  const hasNext = sliced.length > limit;
  const items = hasNext ? sliced.slice(0, limit) : sliced;
  const nextCursor = items.length > 0 ? items[items.length - 1].id : null;

  const diff = process.hrtime(startTime);
  const executionTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      cursor: cursorValue,
      nextCursor,
      limit,
      hasNext,
      executionTimeMs: Number(executionTimeMs)
    }
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`====================================================`);
  console.log(`🚀 웹서비스설계 9주차 3학년 전공 실습 서버 구동 완료`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`📦 데이터: 1,000건의 인메모리 게시글 로드 완료`);
  console.log(`====================================================`);
});
