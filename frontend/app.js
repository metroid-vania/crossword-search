'use strict';

// ─── 設定 ────────────────────────────────────────────────────────────────────
// デプロイ時は実際の API パスに変更してください
const API_URL     = '../backend/api.php';
const DEBOUNCE_MS = 120;
const PAGE_SIZE   = 100;

// ─── DOM ─────────────────────────────────────────────────────────────────────
const inputEl       = document.getElementById('search-input');
const countEl       = document.getElementById('hit-count');
const resultsList   = document.getElementById('results-list');
const copyBtn       = document.getElementById('copy-btn');
const viewToggleBtn = document.getElementById('view-toggle');
const loadingEl     = document.getElementById('loading-indicator');
const backToTopBtn  = document.getElementById('back-to-top');
const clearBtn      = document.getElementById('clear-btn');
const searchAreaEl  = document.querySelector('.search-sticky-wrap');
const resultsHeaderEl = document.querySelector('.results-header');
const toastEl       = createToastElement();

// ─── 状態 ─────────────────────────────────────────────────────────────────────
let debounceTimer   = null;
let currentData     = null; // 最新の API レスポンス
let currentQuery    = '';
let currentOffset   = 0;
let hasMore         = false;
let isLoading       = false;
let abortController = null; // 進行中の fetch をキャンセルするコントローラー
let idlePrefetchId  = null; // バックグラウンドプリフェッチ用
let simpleMode      = localStorage.getItem('simpleMode') !== '0';
let isComposing     = false; // IME 変換中フラグ

// 初期状態を反映
applySimpleMode();

// ─── ユーティリティ ───────────────────────────────────────────────────────────

/** 半角・全角スペースを除去 */
function removeSpaces(str) {
  return str.replace(/[ \u3000]/g, '');
}

/** ひらがな → カタカナ */
function toKatakana(str) {
  return str.replace(/[\u3041-\u3096]/g, c =>
    String.fromCharCode(c.charCodeAt(0) + 0x60)
  );
}

/** 拗音・促音を大文字に展開（コピー用） */
function expandSmallKana(str) {
  const map = {
    'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ',
    'ッ': 'ツ',
    'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ',
  };
  return str.replace(/[ァィゥェォッャュョ]/g, c => map[c] ?? c);
}

/**
 * 検索パターンを全角表記に変換（コピー先頭の【】用）
 *   ? → ？  * → ＊  1-9 → １-９  ひらがな → カタカナ
 */
function toFullWidthPattern(str) {
  const half2full = {
    '?': '？', '*': '＊',
    '1': '１', '2': '２', '3': '３', '4': '４', '5': '５',
    '6': '６', '7': '７', '8': '８', '9': '９',
  };
  return expandSmallKana(toKatakana(str)).replace(/[?*1-9]/g, c => half2full[c] ?? c);
}

// ─── 簡易表示トグル ───────────────────────────────────────────────────────────

function applySimpleMode() {
  resultsList.classList.toggle('simple', simpleMode);
  viewToggleBtn.textContent = simpleMode ? '詳細表示' : '簡易表示';
}

viewToggleBtn.addEventListener('click', () => {
  simpleMode = !simpleMode;
  localStorage.setItem('simpleMode', simpleMode ? '1' : '0');
  applySimpleMode();
  viewToggleBtn.blur();
});

// ─── 検索 ─────────────────────────────────────────────────────────────────────

// IME 変換中は input イベントを無視し、確定後に1回だけ検索する
inputEl.addEventListener('compositionstart', () => { isComposing = true; });
inputEl.addEventListener('compositionend',   () => {
  isComposing = false;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(true), DEBOUNCE_MS);
});

inputEl.addEventListener('input', () => {
  clearBtn.hidden = inputEl.value === '';
  if (isComposing) return; // IME 変換中はスキップ
  clearTimeout(debounceTimer);
  // 入力直後に旧リクエスト・プリフェッチをキャンセル
  if (abortController) { abortController.abort(); abortController = null; }
  cancelPrefetch();
  // DOM ノードが多い場合は即解放してメモリ・描画バッファを解消
  // （少量なら stale フェードで視覚的な連続性を維持）
  if (resultsList.children.length > 60) {
    resultsList.replaceChildren();
    currentData = null;
  } else {
    resultsList.classList.add('stale');
  }
  debounceTimer = setTimeout(() => doSearch(true), DEBOUNCE_MS);
});

clearBtn.addEventListener('click', () => {
  inputEl.value = '';
  clearBtn.hidden = true;
  inputEl.focus();
  clearTimeout(debounceTimer);
  if (abortController) { abortController.abort(); abortController = null; }
  cancelPrefetch();
  resultsList.replaceChildren();
  currentData = null;
  doSearch(true);
});

// Enter キーで debounce をスキップして即時検索
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !isComposing) {
    clearTimeout(debounceTimer);
    doSearch(true);
  }
});

window.addEventListener('scroll', () => {
  backToTopBtn.classList.toggle('visible', window.scrollY >= 300);

  if (!hasMore || isLoading || !currentQuery) return;
  const threshold = 200;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - threshold;
  if (nearBottom) {
    doSearch(false);
  }
});

async function doSearch(reset) {
  const query = removeSpaces(inputEl.value.trim());

  if (reset) {
    cancelPrefetch();
    currentQuery  = query;
    currentOffset = 0;
    hasMore       = false;
    // 再検索時は結果リスト先頭が見えるように先頭へスクロール
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (query !== currentQuery) {
    return;
  }

  if (query === '') {
    setLoading(false);
    renderResults(null);
    history.replaceState(null, '', location.pathname); // URL からクエリを除去
    return;
  }

  // URL を現在のクエリで更新（ブックマーク・リロード対応）
  history.replaceState(null, '', '?q=' + encodeURIComponent(query));

  // 辞書の語長制約（2〜13文字）に基づく即時 0 件判定（API 不要）
  // ・＊を除いた文字数 ≥ 14 → 14文字以上の語は存在しない
  // ・＊なしで文字数 = 1  → 1文字の語は存在しない
  if (reset) {
    const nonStarLen = query.replace(/[*＊]/g, '').length;
    const hasStar    = nonStarLen < query.length;
    if (nonStarLen >= 14 || (!hasStar && nonStarLen < 2)) {
      renderResults({ count: 0, total: 0, words: [], hasMore: false });
      return;
    }
  }

  // セッションキャッシュがあれば即座に表示（ネットワーク待ち不要）
  if (reset) {
    const cached = cacheRead(query);
    if (cached) {
      renderResults(cached);
      // currentOffset は 0 のまま→ネットワーク取得は常に先頭から
    }
  }

  // 前のリクエストをキャンセル
  if (abortController) abortController.abort();
  abortController = new AbortController();

  try {
    isLoading = true;
    setLoading(true);
    const res = await fetch(
      `${API_URL}?q=${encodeURIComponent(query)}&offset=${currentOffset}&limit=${PAGE_SIZE}`,
      { signal: abortController.signal }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // レスポンス到着時点でクエリが変わっていたら破棄
    if (query !== currentQuery) return;
    hasMore = !!data.hasMore;
    const newWords = data.words;
    currentOffset += newWords.length;

    if (reset || !currentData) {
      currentData = { ...data };
      renderResults(currentData);
      cacheWrite(query, currentData); // 1ページ目をキャッシュ保存
    } else {
      // ページネーション：差分のみ追記（全再描画なし）
      currentData.words = currentData.words.concat(newWords);
      currentData.count = currentData.words.length;
      currentData.hasMore = hasMore;
      appendResults(newWords, currentData);
    }

  } catch (e) {
    if (e.name === 'AbortError') return; // キャンセルされたリクエストは無視
    console.error(e);
    renderError(e.message);
  } finally {
    isLoading = false;
    setLoading(false);
    // isLoading=false の後にスケジュール（前だとチェックで弾かれる）
    schedulePrefetch();
  }
}

// ─── 描画 ─────────────────────────────────────────────────────────────────────

/** 単語1件分の <li> 要素を生成 */
function buildWordItem(word) {
  const li = document.createElement('li');
  li.className = 'word-item';

  const readingBtn = document.createElement('button');
  readingBtn.type = 'button';
  readingBtn.className = 'reading reading-copy';
  readingBtn.textContent = word.reading;
  readingBtn.dataset.reading = word.reading;
  readingBtn.title = 'クリックでコピー';

  const variantsWrap = document.createElement('span');
  variantsWrap.className = 'variants';
  for (const v of word.variants) {
    const a = document.createElement('a');
    a.className = 'variant-link';
    a.href = `https://www.google.com/search?q=${encodeURIComponent(v)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = v;
    a.title = 'Googleで検索';
    variantsWrap.appendChild(a);
  }

  li.append(readingBtn, variantsWrap);
  return li;
}

/** 件数表示・コピーボタン状態を更新する共通処理 */
function updateCountDisplay(data) {
  const { count, total, hasMore: more } = data;
  const fullPattern = toFullWidthPattern(removeSpaces(inputEl.value.trim()));
  if (count === 0) {
    countEl.textContent = `【${fullPattern}】の検索結果（0件）`;
    countEl.className   = 'zero';
  } else if (more) {
    countEl.textContent = `【${fullPattern}】の検索結果（${count}件以上）`;
    countEl.className   = '';
  } else {
    countEl.textContent = `【${fullPattern}】の検索結果（${count}件）`;
    countEl.className   = '';
  }
  const isAllWords = !more && count === total;
  setCopyEnabled(count > 0 && !more && !isAllWords);
}

/** 初回・リセット時のフル描画 */
function renderResults(data) {
  currentData = data;
  resultsList.classList.remove('stale');

  if (!data) {
    countEl.textContent = '';
    countEl.className   = '';
    resultsList.innerHTML = '';
    copyBtn.hidden = true;
    viewToggleBtn.hidden = true;
    setCopyEnabled(false);
    setLoading(false);
    return;
  }
  copyBtn.hidden = false;
  viewToggleBtn.hidden = false;

  updateCountDisplay(data);

  if (data.count === 0) {
    resultsList.innerHTML = '<li class="message">該当する単語が見つかりませんでした。</li>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const word of data.words) {
    fragment.appendChild(buildWordItem(word));
  }
  resultsList.replaceChildren(fragment); // innerHTML='' + appendChild を1操作でアトミックに
}

/** ページネーション時の差分追記（リスト全再描画なし） */
function appendResults(newWords, data) {
  updateCountDisplay(data);
  const fragment = document.createDocumentFragment();
  for (const word of newWords) {
    fragment.appendChild(buildWordItem(word));
  }
  resultsList.appendChild(fragment);
}

// イベント委譲: 結果リスト全体で読みボタンのクリックを一括処理
resultsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.reading-copy');
  if (!btn) return;
  try {
    const copyReading = expandSmallKana(btn.dataset.reading);
    await copyText(copyReading);
    showToast(btn, copyReading);
  } catch (err) {
    alert('クリップボードへのコピーに失敗しました。\n' + err.message);
  }
});

function renderError(msg) {
  countEl.textContent   = '';
  resultsList.innerHTML = `<li class="message error">エラーが発生しました: ${escHtml(msg)}</li>`;
  setCopyEnabled(false);
  setLoading(false);
  currentData = null;
}

function setCopyEnabled(enabled) {
  copyBtn.disabled = !enabled;
  copyBtn.classList.toggle('disabled', !enabled);
}

// ─── バックグラウンドプリフェッチ ─────────────────────────────────────────────

/** アイドル時に次ページをバックグラウンド取得するスケジューラー */
const PREFETCH_LIMIT = 400;  // バックグラウンド取得の上限件数（DOM 蓄積量を抑制）

function schedulePrefetch() {
  if (idlePrefetchId !== null || !hasMore || isLoading || !currentQuery) return;
  if (currentOffset >= PREFETCH_LIMIT) return; // 上限到達で停止

  let fired = false;
  let ricId, timerId;

  const run = () => {
    if (fired) return;   // RIC・setTimeout どちらか一方だけ実行
    fired = true;
    if (typeof requestIdleCallback === 'function') cancelIdleCallback(ricId);
    clearTimeout(timerId);
    idlePrefetchId = null;
    if (hasMore && !isLoading && currentQuery) doSearch(false);
  };

  if (typeof requestIdleCallback === 'function') {
    // RIC が発火しない環境でも 500ms 後の setTimeout が保証する
    ricId   = requestIdleCallback(run, { timeout: 500 });
    timerId = setTimeout(run, 500);
    idlePrefetchId = { ricId, timerId };
  } else {
    idlePrefetchId = setTimeout(run, 150);
  }
}

/** スケジュール済みのプリフェッチをキャンセル */
function cancelPrefetch() {
  if (idlePrefetchId === null) return;
  if (typeof idlePrefetchId === 'object') {
    cancelIdleCallback(idlePrefetchId.ricId);
    clearTimeout(idlePrefetchId.timerId);
  } else {
    clearTimeout(idlePrefetchId);
  }
  idlePrefetchId = null;
}

let loadingTimer = null;

function setLoading(loading) {
  if (!loadingEl) return;
  if (loading) {
    if (!loadingTimer) {
      loadingTimer = setTimeout(() => { loadingEl.hidden = false; }, 100);
    }
  } else {
    clearTimeout(loadingTimer);
    loadingTimer = null;
    loadingEl.hidden = true;
  }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── sessionStorage キャッシュ ─────────────────────────────────────────────────
// リロード後も同じクエリを即座に表示するための 1 ページ目キャッシュ

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分（辞書は変わらないので長めでも安全）

function cacheWrite(query, data) {
  try {
    sessionStorage.setItem(
      'cw_' + query,
      JSON.stringify({ ts: Date.now(), data })
    );
  } catch (_) {} // quota 超過は無視
}

function cacheRead(query) {
  try {
    const raw = sessionStorage.getItem('cw_' + query);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) {
      sessionStorage.removeItem('cw_' + query);
      return null;
    }
    return data;
  } catch (_) { return null; }
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

let toastTimer     = null;
let toastHideTimer = null;
function createToastElement() {
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = 'toast';
  el.hidden = true;
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
}

function showToast(triggerEl, copiedText = '') {
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);

  const rect = triggerEl.getBoundingClientRect();
  toastEl.textContent = copiedText ? `Copied: ${copiedText}` : 'Copied!';

  // サイズ計測のため一時表示（opacity:0 のまま）
  toastEl.hidden = false;
  toastEl.classList.remove('show', 'hide');

  const toastW  = toastEl.offsetWidth;
  const btnCX   = rect.left + rect.width / 2;
  const padding = 8;
  const vw      = window.innerWidth;

  // トースト左端をビューポート内にクランプ
  const rawLeft    = btnCX - toastW / 2;
  const clampedLeft = Math.max(padding, Math.min(vw - toastW - padding, rawLeft));

  // 三角はボタン中央を常に指す（クランプ量だけオフセット補正）
  const arrowLeft = btnCX - clampedLeft;

  toastEl.style.left = clampedLeft + 'px';
  toastEl.style.top  = (rect.top - 8) + 'px';
  toastEl.style.setProperty('--arrow-left', arrowLeft + 'px');

  void toastEl.offsetWidth; // アニメーション再起動のためのreflow
  toastEl.classList.add('show');

  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.classList.add('hide');
    toastHideTimer = setTimeout(() => {
      toastEl.classList.remove('hide');
      toastEl.hidden = true;
    }, 200);
  }, 1200);
}

// ─── コピーボタン ─────────────────────────────────────────────────────────────

// ─── スティッキー検索エリア：結果ヘッダーの top を動的に同期 ──────────────────────
function syncResultsHeaderTop() {
  resultsHeaderEl.style.top = Math.ceil(searchAreaEl.getBoundingClientRect().height) + 'px';
}
syncResultsHeaderTop();
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(syncResultsHeaderTop).observe(searchAreaEl);
}

backToTopBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

copyBtn.addEventListener('click', async (e) => {
  if (copyBtn.disabled || !currentData) return;

  const { words, hasMore: more } = currentData;
  if (!words.length || more) return;

  const pattern     = inputEl.value.trim();
  const fullPattern = toFullWidthPattern(pattern);

  // 読みを展開（拗音・促音展開 + ひらがな→カタカナ）して重複除去
  const lines = words.map(w => expandSmallKana(toKatakana(w.reading)));
  const unique = [...new Set(lines)];

  const text = `【${fullPattern}】\n` + unique.join('\n');

  try {
    await copyText(text);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = original; }, 2000);
  } catch (e) {
    alert('クリップボードへのコピーに失敗しました。\n' + e.message);
  }
});

// ─── URL からの初期クエリ復元 ─────────────────────────────────────────────────
// ?q=... でページを開いた場合（ブックマーク・シェア・リロード）に自動検索
const _initQuery = new URLSearchParams(location.search).get('q') ?? '';
if (_initQuery) {
  inputEl.value = _initQuery;
  clearBtn.hidden = false;
  doSearch(true);
}
