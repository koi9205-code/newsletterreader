'use strict';

/* ══════════════════════════════════════════════════════════
   설정 — Google Cloud Console에서 발급받은 클라이언트 ID를 넣으세요
   (설정 방법은 사이트 첫 화면 안내 참고)
   ══════════════════════════════════════════════════════════ */
const CLIENT_ID = '261464330563-419lokk7m99pq7rfp5j7vsmll9i702j1.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify';
const PAGE_SIZE = 20;

/* ── 상태 ────────────────────────────────────────────────── */
const state = {
  accessToken: null,
  tokenClient: null,
  emails: [],
  nextPageToken: null,
  filterMode: 'all',   // 'all' | 'bookmark'
  searchQuery: '',
  activeId: null,
  loading: false,
};

/* ── DOM 참조 ────────────────────────────────────────────── */
const el = {};
[
  'screenSetup', 'screenLogin', 'screenApp', 'originHint',
  'loginBtn', 'loginError', 'refreshBtn', 'themeBtn',
  'sidebarBadge', 'searchInput', 'searchClear', 'tabAll', 'tabBookmark',
  'emailList', 'loadMoreBtn', 'reader', 'emptyState',
].forEach(id => { el[id] = document.getElementById(id); });

/* ── 색상 팔레트 (에디토리얼 톤 유지) ───────────────────── */
const AVATAR_COLORS = ['#2B6E52', '#1A4D8F', '#7B2D8B', '#5C3D99', '#8B4A1E', '#B71C1C', '#2D6A6E', '#8A5A1E'];
function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/* ── 화면 전환 ───────────────────────────────────────────── */
function showScreen(name) {
  el.screenSetup.hidden = name !== 'setup';
  el.screenLogin.hidden = name !== 'login';
  el.screenApp.hidden = name !== 'app';
}

function isConfigured() {
  return CLIENT_ID && CLIENT_ID.indexOf('REPLACE_WITH') === -1;
}

/* ── Google 로그인 (Google Identity Services) ───────────── */
function ensureTokenClient(cb) {
  if (state.tokenClient) { cb(); return; }
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    setTimeout(() => ensureTokenClient(cb), 200);
    return;
  }
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: handleTokenResponse,
  });
  cb();
}

function handleTokenResponse(resp) {
  el.loginBtn.disabled = false;
  if (resp.error) {
    el.loginError.textContent = '로그인에 실패했어요. 다시 시도해주세요. (' + resp.error + ')';
    return;
  }
  state.accessToken = resp.access_token;
  el.loginError.textContent = '';
  showScreen('app');
  loadList(true);
}

function handleAuthExpired() {
  state.accessToken = null;
  el.loginError.textContent = '로그인이 만료됐어요. 다시 연결해주세요.';
  showScreen('login');
}

/* ── Gmail API 호출 ──────────────────────────────────────── */
async function gmailFetch(path, opts) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me' + path, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + state.accessToken }, (opts && opts.headers) || {}),
  }));
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error('인증이 만료되었습니다.');
  }
  if (!res.ok) {
    throw new Error('Gmail 요청 실패 (' + res.status + ')');
  }
  if (res.status === 204) return null;
  return res.json();
}

function buildQuery() {
  // 이 계정은 뉴스레터 전용이므로 받은편지함 전체를 그대로 보여줌
  // (Gmail의 프로모션 탭 분류는 비공식 ML 기준이라 신뢰하지 않음)
  let q = 'in:inbox';
  if (state.filterMode === 'bookmark') q += ' is:starred';
  if (state.searchQuery.trim()) q += ' ' + state.searchQuery.trim();
  return q;
}

/* ── 발신자 헤더 파싱 ────────────────────────────────────── */
function parseFrom(value) {
  if (!value) return { name: '(알 수 없음)', email: '' };
  const m = value.match(/^(.*?)\s*<(.+)>$/);
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim();
    return { name: name || m[2], email: m[2] };
  }
  return { name: value.split('@')[0], email: value };
}

/* ── 날짜 표시 ───────────────────────────────────────────── */
function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay) {
    let h = d.getHours(); const period = h < 12 ? '오전' : '오후';
    h = h % 12; if (h === 0) h = 12;
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${period} ${h}:${m}`;
  }
  if (isYesterday) return '어제';
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return `${diffDays}일 전`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/* ── HTML 이스케이프 ─────────────────────────────────────── */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ── Base64URL 디코드 (UTF-8 안전) ───────────────────────── */
function b64urlDecode(data) {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ── 메일 본문(payload)에서 텍스트/HTML 파트 찾기 ───────── */
function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body && payload.body.data) return payload.body.data;
  if (payload.parts) {
    for (const p of payload.parts) {
      const found = findPart(p, mimeType);
      if (found) return found;
    }
  }
  return null;
}

function extractBodyHtml(message) {
  const htmlData = findPart(message.payload, 'text/html');
  if (htmlData) return b64urlDecode(htmlData);
  const plainData = findPart(message.payload, 'text/plain');
  if (plainData) {
    return `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(b64urlDecode(plainData))}</pre>`;
  }
  return '<p style="color:#999">본문을 표시할 수 없어요.</p>';
}

/* ── 목록 불러오기 ───────────────────────────────────────── */
async function loadList(reset) {
  if (state.loading) return;
  state.loading = true;
  el.refreshBtn.classList.add('spinning');

  if (reset) {
    state.emails = [];
    state.nextPageToken = null;
    state.activeId = null;
    el.screenApp.classList.remove('reading');
    el.emailList.innerHTML = '<div class="list-empty">불러오는 중...</div>';
  }

  try {
    const q = buildQuery();
    let listUrl = `/messages?maxResults=${PAGE_SIZE}&q=${encodeURIComponent(q)}`;
    if (!reset && state.nextPageToken) listUrl += `&pageToken=${state.nextPageToken}`;

    const listRes = await gmailFetch(listUrl);
    const ids = (listRes.messages || []).map(m => m.id);
    state.nextPageToken = listRes.nextPageToken || null;

    if (ids.length === 0 && state.emails.length === 0) {
      renderList();
      updateLoadMoreState();
      return;
    }

    const metas = await Promise.all(ids.map(id =>
      gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)
    ));

    const newEmails = metas.map(msg => {
      const headers = {};
      (msg.payload.headers || []).forEach(h => { headers[h.name] = h.value; });
      const from = parseFrom(headers.From);
      const labelIds = msg.labelIds || [];
      return {
        id: msg.id,
        sender: from.name,
        senderEmail: from.email,
        subject: headers.Subject || '(제목 없음)',
        snippet: msg.snippet || '',
        dateRaw: headers.Date,
        date: formatDate(headers.Date),
        labelIds,
        read: !labelIds.includes('UNREAD'),
        bookmarked: labelIds.includes('STARRED'),
        color: colorFromString(from.name || from.email),
      };
    });

    state.emails = state.emails.concat(newEmails);
    renderList();
    updateLoadMoreState();
  } catch (err) {
    if (state.emails.length === 0) {
      el.emailList.innerHTML = `<div class="list-empty error">목록을 불러오지 못했어요<br>${escapeHtml(err.message)}</div>`;
    }
  } finally {
    state.loading = false;
    el.refreshBtn.classList.remove('spinning');
  }
}

function updateLoadMoreState() {
  if (state.nextPageToken) {
    el.loadMoreBtn.disabled = false;
    el.loadMoreBtn.textContent = '이전 뉴스레터 더 보기';
  } else {
    el.loadMoreBtn.disabled = true;
    el.loadMoreBtn.textContent = state.emails.length ? '더 이상 없어요' : '';
  }
}

/* ── 목록 렌더링 ─────────────────────────────────────────── */
function renderList() {
  el.sidebarBadge.textContent = state.emails.length;

  if (state.emails.length === 0) {
    const msg = state.searchQuery.trim()
      ? `<strong style="color:var(--text-2)">"${escapeHtml(state.searchQuery)}"</strong>에 대한 결과가 없어요`
      : (state.filterMode === 'bookmark'
          ? '북마크한 뉴스레터가 없어요<br>별 아이콘을 눌러 저장해보세요'
          : '뉴스레터가 없어요');
    el.emailList.innerHTML = `<div class="list-empty">${msg}</div>`;
    return;
  }

  el.emailList.innerHTML = state.emails.map(e => `
    <div class="email-item${state.activeId === e.id ? ' active' : ''}" data-id="${e.id}">
      <div class="avatar" style="background:${e.color}">${escapeHtml(e.sender.slice(0, 1))}</div>
      <div class="item-body">
        <div class="item-row1">
          <span class="item-sender ${e.read ? 'is-read' : 'unread'}">${escapeHtml(e.sender)}</span>
          <div class="item-meta">
            <button class="item-star${e.bookmarked ? ' active' : ''}" data-star="${e.id}" title="${e.bookmarked ? '북마크 해제' : '북마크'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="${e.bookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </button>
            <span class="unread-dot${e.read ? ' hidden' : ''}"></span>
            <span class="item-date">${e.date}</span>
          </div>
        </div>
        <div class="item-subject ${e.read ? 'is-read' : 'unread'}">${escapeHtml(e.subject)}</div>
        <div class="item-snippet">${escapeHtml(e.snippet)}</div>
      </div>
    </div>
  `).join('');
}

/* ── 이벤트 위임: 목록 클릭 ──────────────────────────────── */
el.emailList.addEventListener('click', (evt) => {
  const starBtn = evt.target.closest('[data-star]');
  if (starBtn) {
    evt.stopPropagation();
    toggleBookmark(starBtn.dataset.star);
    return;
  }
  const item = evt.target.closest('.email-item');
  if (item) openEmail(item.dataset.id);
});

/* ── 북마크(Gmail 별표) 토글 ─────────────────────────────── */
async function toggleBookmark(id) {
  const email = state.emails.find(e => e.id === id);
  if (!email) return;
  const wasBookmarked = email.bookmarked;
  email.bookmarked = !wasBookmarked;
  renderList();
  if (state.activeId === id) updateReaderBookmarkBtn(email);

  try {
    await gmailFetch(`/messages/${id}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wasBookmarked ? { removeLabelIds: ['STARRED'] } : { addLabelIds: ['STARRED'] }),
    });
  } catch (err) {
    email.bookmarked = wasBookmarked; // 롤백
    renderList();
    if (state.activeId === id) updateReaderBookmarkBtn(email);
  }
}

/* ── 이메일 열기 ─────────────────────────────────────────── */
async function openEmail(id) {
  state.activeId = id;
  renderList();
  el.screenApp.classList.add('reading');

  const email = state.emails.find(e => e.id === id);
  if (!email) return;

  el.reader.innerHTML = `
    <div class="reader-info">
      <button class="reader-back" id="readerBackBtn" aria-label="목록으로">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="reader-avatar" style="background:${email.color}">${escapeHtml(email.sender.slice(0, 1))}</div>
      <div class="reader-text">
        <div class="reader-subject">${escapeHtml(email.subject)}</div>
        <div class="reader-from"><strong>${escapeHtml(email.sender)}</strong> &lt;${escapeHtml(email.senderEmail)}&gt; &nbsp;·&nbsp; ${email.date}</div>
      </div>
      <div class="reader-acts">
        <button class="btn-act" id="unreadBtn" title="읽지 않음으로 표시">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6 10-6"/>
          </svg>
          안읽음으로
        </button>
        <button class="btn-act${email.bookmarked ? ' active' : ''}" id="bookmarkBtn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="${email.bookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          ${email.bookmarked ? '북마크됨' : '북마크'}
        </button>
        <a class="btn-act" href="https://mail.google.com/mail/u/0/#all/${id}" target="_blank" rel="noopener">↗ 원본 열기</a>
      </div>
    </div>
    <div class="reader-body">
      <div class="reader-loading" id="readerLoading">불러오는 중...</div>
      <iframe class="reader-frame" id="emailFrame" sandbox="allow-same-origin allow-popups" style="opacity:0"></iframe>
    </div>
  `;

  document.getElementById('bookmarkBtn').addEventListener('click', () => toggleBookmarkFromReader(id));
  document.getElementById('unreadBtn').addEventListener('click', () => toggleUnreadFromReader(id));
  document.getElementById('readerBackBtn').addEventListener('click', () => el.screenApp.classList.remove('reading'));

  try {
    const message = await gmailFetch(`/messages/${id}?format=full`);
    const html = extractBodyHtml(message);
    const frame = document.getElementById('emailFrame');
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0}img{max-width:100%!important;height:auto!important}a{word-break:break-word}</style></head><body>${html}</body></html>`);
    doc.close();
    frame.style.opacity = '1';
    const loadingEl = document.getElementById('readerLoading');
    if (loadingEl) loadingEl.remove();
  } catch (err) {
    const loadingEl = document.getElementById('readerLoading');
    if (loadingEl) loadingEl.textContent = '본문을 불러오지 못했어요.';
  }

  if (!email.read) {
    email.read = true;
    renderList();
    try {
      await gmailFetch(`/messages/${id}/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      });
    } catch (err) { /* 읽음 처리 실패해도 읽기 자체는 계속 가능하도록 무시 */ }
  }
}

function toggleBookmarkFromReader(id) {
  toggleBookmark(id);
}

async function toggleUnreadFromReader(id) {
  const email = state.emails.find(e => e.id === id);
  if (!email) return;
  email.read = false;
  renderList();
  updateReaderUnreadBtn();
  try {
    await gmailFetch(`/messages/${id}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds: ['UNREAD'] }),
    });
  } catch (err) {
    email.read = true;
    renderList();
  }
}

function updateReaderBookmarkBtn(email) {
  const btn = document.getElementById('bookmarkBtn');
  if (!btn) return;
  btn.classList.toggle('active', email.bookmarked);
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="${email.bookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
    ${email.bookmarked ? '북마크됨' : '북마크'}
  `;
}

function updateReaderUnreadBtn() {
  // 현재 디자인상 안읽음 버튼은 상태를 표시하지 않고 동작만 하므로 별도 갱신 불필요
}

/* ── 검색 ────────────────────────────────────────────────── */
let searchDebounce = null;
el.searchInput.addEventListener('input', () => {
  const value = el.searchInput.value;
  el.searchClear.classList.toggle('show', value.length > 0);
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = value;
    loadList(true);
  }, 350);
});

el.searchClear.addEventListener('click', () => {
  el.searchInput.value = '';
  el.searchClear.classList.remove('show');
  state.searchQuery = '';
  loadList(true);
});

/* ── 탭 (전체 / 북마크) ──────────────────────────────────── */
el.tabAll.addEventListener('click', () => setFilter('all'));
el.tabBookmark.addEventListener('click', () => setFilter('bookmark'));
function setFilter(mode) {
  if (state.filterMode === mode) return;
  state.filterMode = mode;
  el.tabAll.classList.toggle('active', mode === 'all');
  el.tabBookmark.classList.toggle('active', mode === 'bookmark');
  loadList(true);
}

/* ── 더 보기 / 새로고침 ──────────────────────────────────── */
el.loadMoreBtn.addEventListener('click', () => loadList(false));
el.refreshBtn.addEventListener('click', () => loadList(true));

/* ── 테마 전환 ───────────────────────────────────────────── */
el.themeBtn.addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (!current) root.setAttribute('data-theme', dark ? 'light' : 'dark');
  else if (current === 'dark') root.setAttribute('data-theme', 'light');
  else root.setAttribute('data-theme', 'dark');
});

/* ── 로그인 버튼 ─────────────────────────────────────────── */
el.loginBtn.addEventListener('click', () => {
  el.loginBtn.disabled = true;
  ensureTokenClient(() => state.tokenClient.requestAccessToken());
});

/* ── 초기화 ──────────────────────────────────────────────── */
function init() {
  el.originHint.textContent = location.origin;
  if (!isConfigured()) {
    showScreen('setup');
    return;
  }
  showScreen('login');
}

init();
