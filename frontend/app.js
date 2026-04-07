'use strict';

// ─── 設定 ────────────────────────────────────────────────────────────────────
// デプロイ時は実際の API パスに変更してください
const API_URL     = '../backend/api.php';
const DEBOUNCE_MS = 120;
const PAGE_SIZE   = 100;

// ─── DOM ─────────────────────────────────────────────────────────────────────
const inputEl    = document.getElementById('search-input');
const countEl    = document.getElementById('hit-count');
const resultsList = document.getElementById('results-list');
const copyBtn      = document.getElementById('copy-btn');
const viewToggleBtn = document.getElementById('view-toggle');
const loadingEl  = document.getElementById('loading-indicator');
const backToTopBtn = document.getElementById('back-to-top');
const clearBtn   = document.getElementById('clear-btn');
const toastEl    = createToastElement();

// ─── 状態 ─────────────────────────────────────────────────────────────────────
let debounceTimer = null;
let currentData   = null; // 最新の API レスポンス
let currentQuery  = '';
let currentOffset = 0;
let hasMore       = false;
let isLoading     = false;
let abortController = null; // 進行中の fetch をキャンセルするコントローラー
let simpleMode    = localStorage.getItem('simpleMode') !== '0';

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
  return toKatakana(str).replace(/[?*1-9]/g, c => half2full[c] ?? c);
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

inputEl.addEventListener('input', () => {
  clearBtn.hidden = inputEl.value === '';
  clearTimeout(debounceTimer);
  // 入力直後に旧リクエストをキャンセル（デバウンス中に古い結果が返るのを防ぐ）
  if (abortController) { abortController.abort(); abortController = null; }
  debounceTimer = setTimeout(() => doSearch(true), DEBOUNCE_MS);
});

clearBtn.addEventListener('click', () => {
  inputEl.value = '';
  clearBtn.hidden = true;
  inputEl.focus();
  clearTimeout(debounceTimer);
  doSearch(true);
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
    currentQuery = query;
    currentOffset = 0;
    hasMore = false;
  } else if (query !== currentQuery) {
    return;
  }

  if (query === '') {
    setLoading(false);
    renderResults(null);
    return;
  }

  // 前のリクエストをキャンセル
  if (abortController) abortController.abort();
  abortController = new AbortController();

  try {
    isLoading = true;
    setLoading(true);
    const res  = await fetch(
      `${API_URL}?q=${encodeURIComponent(query)}&offset=${currentOffset}&limit=${PAGE_SIZE}`,
      { signal: abortController.signal }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // レスポンス到着時点でクエリが変わっていたら破棄
    if (query !== currentQuery) return;
    hasMore = !!data.hasMore;
    currentOffset += data.words.length;

    if (reset || !currentData) {
      currentData = { ...data };
    } else {
      currentData.words = currentData.words.concat(data.words);
      currentData.count = currentData.words.length;
      currentData.hasMore = hasMore;
    }
    renderResults(currentData);
  } catch (e) {
    if (e.name === 'AbortError') return; // キャンセルされたリクエストは無視
    console.error(e);
    renderError(e.message);
  } finally {
    isLoading = false;
    setLoading(false);
  }
}

// ─── 描画 ─────────────────────────────────────────────────────────────────────

function renderResults(data) {
  currentData = data;

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

  const { count, total, words } = data;
  const { hasMore: more } = data;
  const fullPattern = toFullWidthPattern(removeSpaces(inputEl.value.trim()));

  // 件数表示
  if (count === 0) {
    countEl.textContent = `【${fullPattern}】の検索結果（0件ヒット）`;
    countEl.className   = 'zero';
  } else if (more) {
    countEl.textContent = `【${fullPattern}】の検索結果（${count}件以上ヒット）`;
    countEl.className   = '';
  } else {
    countEl.textContent = `【${fullPattern}】の検索結果（${count}件ヒット）`;
    countEl.className   = '';
  }

  // コピーボタン：0件 or 全件（件数が多すぎる）はグレーアウト
  const isAllWords = !more && count === total;
  setCopyEnabled(count > 0 && !more && !isAllWords);

  // 結果リスト描画
  if (count === 0) {
    resultsList.innerHTML = '<li class="message">該当する単語が見つかりませんでした。</li>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const word of words) {
    const li = document.createElement('li');
    li.className = 'word-item';

    const readingBtn = document.createElement('button');
    readingBtn.type = 'button';
    readingBtn.className = 'reading reading-copy';
    readingBtn.textContent = word.reading;
    readingBtn.title = `クリックでコピー（${expandSmallKana(word.reading)}）`;
    readingBtn.addEventListener('click', async (e) => {
      try {
        const copyReading = expandSmallKana(word.reading);
        await copyText(copyReading);
        showToast(readingBtn);
      } catch (e) {
        alert('クリップボードへのコピーに失敗しました。\n' + e.message);
      }
    });

    const variantsWrap = document.createElement('span');
    variantsWrap.className = 'variants';
    for (let i = 0; i < word.variants.length; i++) {
      const v = word.variants[i];
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
    fragment.appendChild(li);
  }
  resultsList.innerHTML = '';
  resultsList.appendChild(fragment);
}

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

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

let toastTimer = null;
function createToastElement() {
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = 'toast';
  el.hidden = true;
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
}

function showToast(triggerEl) {
  const mainRect = document.querySelector('main').getBoundingClientRect();
  const rowRect  = triggerEl.closest('.word-item').getBoundingClientRect();
  toastEl.textContent = 'Copied!';
  toastEl.style.left = rowRect.left + 'px';
  toastEl.style.top  = (rowRect.top - 6) + 'px';
  toastEl.hidden = false;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.hidden = true;
  }, 1200);
}

// ─── コピーボタン ─────────────────────────────────────────────────────────────

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
