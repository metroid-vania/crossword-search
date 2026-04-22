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
const viewToggleGroup = document.getElementById('view-toggle-group');
const btnDetail       = document.getElementById('btn-detail');
const btnSimple       = document.getElementById('btn-simple');
const loadingEl     = document.getElementById('loading-indicator');
const backToTopBtn  = document.getElementById('back-to-top');
const clearBtn      = document.getElementById('clear-btn');
const copyAllBtn    = document.getElementById('copy-all-btn');
const guideEl       = document.getElementById('search-guide');
const footerEl      = document.querySelector('footer');
const searchAreaEl    = document.querySelector('.search-sticky-wrap');
const resultsHeaderEl = document.querySelector('.results-header');
const mainEl          = document.querySelector('main');
const srStatusEl      = document.getElementById('sr-status'); // SR 向け aria-live 通知
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
let hasNetworkError = false; // 直前の検索がネットワークエラーで失敗したか（online 復帰時の自動リトライ判定用）
let simpleMode      = localStorage.getItem('simpleMode') === '1';
let isComposing       = false; // IME 変換中フラグ
let viewportResizing  = false; // キーボード開閉中フラグ（infinite scroll 誤発火防止）
let viewportResizeTimer = null;
let prevVH = window.visualViewport ? window.visualViewport.height : window.innerHeight;

// 初期状態は applySimpleMode() の定義後に反映（ICON_* 定数依存のため）

// ─── ユーティリティ ───────────────────────────────────────────────────────────

/** 半角・全角スペースを除去、連続する＊/*を1文字に圧縮 */
function removeSpaces(str) {
  return str.replace(/[ \u3000]/g, '').replace(/[*＊]+/g, '＊');
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
 * マッチング用の正規化：全角ワイルドカード/数字 → 半角、ひら→カタ、小→大
 * バックエンドの normalizeQuery / normalized 列と一致させる
 */
function normalizeForMatch(str) {
  const wcMap = {
    '？':'?','＊':'*',
    '１':'1','２':'2','３':'3','４':'4','５':'5',
    '６':'6','７':'7','８':'8','９':'9',
  };
  const half = str.replace(/[？＊１-９]/g, c => wcMap[c] ?? c);
  return expandSmallKana(toKatakana(half));
}

/**
 * ローカルでの単語マッチ（バックエンド matchPattern と同じセマンティクス）
 *   reading: 単語の読み（元のカタカナ、未正規化）
 *   pattern: 正規化済みパターン文字列
 * 戻り値: マッチすれば true
 */
function matchReading(reading, pattern) {
  const w = [...expandSmallKana(reading)]; // 小→大で照合側を揃える
  const p = [...pattern];
  return matchHelper(w, 0, p, 0, {}, {});
}

function matchHelper(w, wp, p, pp, d2c, c2d) {
  if (pp === p.length) return wp === w.length;
  const ch = p[pp];
  if (ch === '*') {
    for (let i = wp; i <= w.length; i++) {
      if (matchHelper(w, i, p, pp + 1, { ...d2c }, { ...c2d })) return true;
    }
    return false;
  }
  if (wp >= w.length) return false;
  const wc = w[wp];
  if (ch === '?') return matchHelper(w, wp + 1, p, pp + 1, d2c, c2d);
  if (ch >= '1' && ch <= '9') {
    if (ch in d2c) {
      if (d2c[ch] !== wc) return false;
      return matchHelper(w, wp + 1, p, pp + 1, d2c, c2d);
    }
    if (wc in c2d && c2d[wc] !== ch) return false;
    return matchHelper(
      w, wp + 1, p, pp + 1,
      { ...d2c, [ch]: wc },
      { ...c2d, [wc]: ch },
    );
  }
  return ch === wc && matchHelper(w, wp + 1, p, pp + 1, d2c, c2d);
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

// ─── 表示切替 ────────────────────────────────────────────────────────────────

function applySimpleMode() {
  resultsList.classList.toggle('simple', simpleMode);
  btnDetail.classList.toggle('active', !simpleMode);
  btnSimple.classList.toggle('active', simpleMode);
}
applySimpleMode(); // 初期状態を反映

btnDetail.addEventListener('click', () => {
  simpleMode = false;
  localStorage.setItem('simpleMode', '0');
  applySimpleMode();
  btnDetail.blur();
});

btnSimple.addEventListener('click', () => {
  simpleMode = true;
  localStorage.setItem('simpleMode', '1');
  applySimpleMode();
  btnSimple.blur();
});


// ─── 検索 ─────────────────────────────────────────────────────────────────────

// IME 変換中は input イベントを無視し、確定後に1回だけ検索する
// 変換中はワイルドカードチップも無効化する（iOS Safari で IME を強制確定できないため、
// 変換中にチップをタップさせない方が確実）
// ペースト時の自動クリーンアップ
// 検索に意味のある文字（ひらがな/カタカナ/半角・全角数字/ワイルドカード）のみ残す
inputEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const raw = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  const cleaned = raw.replace(/[^\u3040-\u309F\u30A0-\u30FF0-9\uFF10-\uFF19?？*＊]/g, '');
  if (!cleaned) return; // クリーンアップ後が空なら何もしない（元の値を保持）

  // execCommand は deprecated だが、undo 履歴に正しく積まれるので優先
  if (document.execCommand && document.execCommand('insertText', false, cleaned)) {
    return;
  }
  // フォールバック: 手動で選択範囲を置換
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? inputEl.value.length;
  inputEl.value = inputEl.value.slice(0, start) + cleaned + inputEl.value.slice(end);
  const pos = start + cleaned.length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
});

inputEl.addEventListener('compositionstart', () => {
  isComposing = true;
  document.getElementById('wc-chips')?.classList.add('disabled');
});
inputEl.addEventListener('compositionend', () => {
  isComposing = false;
  document.getElementById('wc-chips')?.classList.remove('disabled');
  // 同クエリなら再検索不要（iOSキーボードcloseによる compositionend 誤発火対策）
  if (removeSpaces(inputEl.value.trim()) === currentQuery && currentData !== null) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(true), DEBOUNCE_MS);
});

inputEl.addEventListener('input', () => {
  const isEmpty = inputEl.value === '';
  clearBtn.hidden = isEmpty;
  guideEl.hidden = !isEmpty; // ガイドは入力が空のときだけ表示
  updateFabVisibility();     // スマホFAB：入力状態に応じて表示/非表示を更新
  if (isEmpty) {
    viewToggleGroup.hidden = true;
    resultsHeaderEl.hidden = true;
    mainEl.classList.remove('has-results');
    countEl.textContent = '';
    countEl.className   = '';
    resultsList.replaceChildren();
    currentData = null;
    updateCopyAllBtn(null);
    clearAnnouncement();
  } // 入力が空になったら即座に非表示
  if (isComposing) return; // IME 変換中はスキップ

  // 同クエリなら再検索不要（iOSキーボードcloseによる input 誤発火対策）
  const q = removeSpaces(inputEl.value.trim());
  if (q !== '' && q === currentQuery && currentData !== null) {
    resultsList.classList.remove('stale');
    countEl.classList.remove('stale');
    return;
  }

  clearTimeout(debounceTimer);
  // 入力直後に旧リクエスト・プリフェッチをキャンセル
  if (abortController) { abortController.abort(); abortController = null; }
  cancelPrefetch();
  // DOM ノードが多い場合は即解放してメモリ・描画バッファを解消
  // （少量なら stale フェードで視覚的な連続性を維持）
  // currentData 自体は保持する（doSearch の楽観フィルタで使う）
  if (resultsList.children.length > 60) {
    resultsList.replaceChildren();
  } else {
    resultsList.classList.add('stale');
  }
  if (currentData !== null) countEl.classList.add('stale'); // 件数の更新待ちをフェードで示す
  debounceTimer = setTimeout(() => doSearch(true), DEBOUNCE_MS);
});

clearBtn.addEventListener('click', () => {
  inputEl.value = '';
  clearBtn.hidden = true;
  guideEl.hidden = false;
  resultsHeaderEl.hidden = true;
  mainEl.classList.remove('has-results');
  updateFabVisibility(); // スマホFAB：入力クリア時に非表示へ
  inputEl.focus();
  clearTimeout(debounceTimer);
  if (abortController) { abortController.abort(); abortController = null; }
  cancelPrefetch();
  resultsList.replaceChildren();
  currentData = null;
  updateCopyAllBtn(null);
  doSearch(true);
});

// ─── すべてコピー ──────────────────────────────────────────────────────────
if (copyAllBtn) {
  copyAllBtn.addEventListener('click', async () => {
    if (!currentData || currentData.count === 0 || currentData.hasMore) return;
    const pattern = toFullWidthPattern(removeSpaces(inputEl.value.trim()));
    // 読みを拗音・促音展開してから重複排除（変換後に同じになるケースもあるため）
    const seen = new Set();
    const readings = [];
    for (const w of currentData.words) {
      const r = expandSmallKana(w.reading);
      if (!seen.has(r)) { seen.add(r); readings.push(r); }
    }
    const text = `【${pattern}】\n${readings.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast(copyAllBtn, 'すべてコピーしました', false, true);
    } catch (e) {
      showToast(copyAllBtn, 'コピーに失敗しました', true);
    }
  });
}

// ─── スマホ用ワイルドカード挿入チップ ───────────────────────────────────────
// タップで ？ / ＊ / １〜９ をカーソル位置に挿入。フォーカスは入力欄に維持する。
// 入力欄が非フォーカス（≒キーボード非表示）のときは CSS 側で無効化。
inputEl.addEventListener('focus', () => {
  document.body.classList.add('input-focused');
});
inputEl.addEventListener('blur', () => {
  document.body.classList.remove('input-focused');
});

const wcChipsEl = document.getElementById('wc-chips');
if (wcChipsEl) {
  // pointerdown でフォーカスが input から外れるのを防ぐ
  wcChipsEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.wc-chip')) e.preventDefault();
  });
  wcChipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.wc-chip');
    if (!chip) return;
    const ch = chip.dataset.insert;
    if (!ch) return;
    insertAtCursor(inputEl, ch);
  });
}

/**
 * 入力欄のカーソル位置に文字列を挿入（選択範囲があれば置換）
 * IME 変換中はチップ自体が無効化される設計のため、composition 状態を考慮する必要はない。
 */
function insertAtCursor(el, text) {
  el.focus();
  const start  = el.selectionStart ?? el.value.length;
  const end    = el.selectionEnd   ?? el.value.length;
  const before = el.value.slice(0, start);
  const after  = el.value.slice(end);
  el.value = before + text + after;
  const pos = start + text.length;
  try { el.setSelectionRange(pos, pos); } catch (_) { /* iOS で稀にエラー */ }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Enter キーで debounce をスキップして即時検索
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !isComposing) {
    // スマホ：同クエリの場合は再検索しない（iOSキーボードcloseによる誤発火対策）
    const q = removeSpaces(inputEl.value.trim());
    if (isMobile() && q === currentQuery && currentData !== null) return;
    clearTimeout(debounceTimer);
    doSearch(true);
  }
});

// フォームsubmit（iOSの「完了」キー含む）でキーボードを閉じる
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (isMobile()) inputEl.blur();
});

// blur時にsubmitを発火してブラウザのオートコンプリート履歴に値を保存する
inputEl.addEventListener('blur', () => {
  if (isComposing) return;
  if (!inputEl.value.trim()) return;
  const form = document.getElementById('search-form');
  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  } else {
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }
});

// ネットワーク復帰時に、直前のネットワークエラーを自動リトライ
window.addEventListener('online', () => {
  if (!hasNetworkError) return;
  if (!inputEl.value.trim()) return;
  doSearch(true);
});

// PC：Esc キーで検索欄へ即ジャンプ
// 「トップにいる かつ 検索欄にフォーカス中」のときのみ何もしない
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || isMobile()) return;
  if (window.scrollY === 0 && document.activeElement === inputEl) return;
  e.preventDefault();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  inputEl.focus();
  inputEl.select();
});

function updateFabBottom() {
  if (!isMobile() || !footerEl) return;
  const vh        = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const footerTop = footerEl.getBoundingClientRect().top;
  const visible   = Math.max(0, vh - footerTop);
  backToTopBtn.style.bottom = Math.max(20, visible + 20) + 'px';
}

// スマホ：入力に文字がある かつ 検索エリアが画面外に出たら FAB を表示
// （scrollY 判定だと iOS キーボード開時の自動スクロールで誤発火するため、
//   実際に検索欄が見えなくなったかで判定する）
function updateFabVisibility() {
  if (!isMobile()) return;
  const hasInput = inputEl.value !== '';
  const rect = searchAreaEl.getBoundingClientRect();
  const searchOffscreen = rect.bottom < 0;
  backToTopBtn.classList.toggle('visible', hasInput && searchOffscreen);
}

window.addEventListener('scroll', () => {
  // スマホ：スクロール量・入力状態に応じてFABを表示
  updateFabVisibility();
  updateFabBottom();

  // scroll イベント内でビューポート高さの変化を検出（キーボード開閉を確実に捕捉）
  if (isMobile()) {
    const currentVH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (currentVH !== prevVH) {
      prevVH = currentVH;
      viewportResizing = true;
      clearTimeout(viewportResizeTimer);
      viewportResizeTimer = setTimeout(() => { viewportResizing = false; }, 800);
    }
  }

  if (!hasMore || isLoading || !currentQuery || viewportResizing) return;
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
    return;
  }

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

  // メモリキャッシュ（query×offset 単位）があればネットワーク不要で即描画
  const memHit = memCacheGet(query, currentOffset);
  if (memHit) {
    // 在りし日の fetch があればキャンセル（帯域と CPU を節約）
    if (abortController) { abortController.abort(); abortController = null; }
    const newWords = memHit.words;
    hasMore = !!memHit.hasMore;
    currentOffset += newWords.length;
    hasNetworkError = false;
    if (reset || !currentData) {
      currentData = { ...memHit };
      renderResults(currentData);
    } else {
      currentData.words = currentData.words.concat(newWords);
      currentData.count = currentData.words.length;
      currentData.hasMore = hasMore;
      appendResults(newWords, currentData);
    }
    isLoading = false;
    setLoading(false);
    schedulePrefetch();
    return;
  }

  // セッションキャッシュ（リロード復元用）：即時表示して API でも更新取得
  if (reset) {
    const cached = cacheRead(query);
    if (cached) {
      renderResults(cached);
    } else {
      // 楽観サブセット描画：前結果を新クエリでローカルフィルタして仮表示
      // （API 確定まで stale 表示）
      const optimistic = tryOptimisticFilter(query);
      if (optimistic) {
        renderResults(optimistic);
        resultsList.classList.add('stale');
        countEl.classList.add('stale');
      }
    }
  }

  // 前のリクエストをキャンセル
  if (abortController) abortController.abort();
  abortController = new AbortController();

  const requestOffset = currentOffset; // メモリキャッシュのキーに使う

  try {
    isLoading = true;
    setLoading(true);
    const res = await fetch(
      `${API_URL}?q=${encodeURIComponent(query)}&offset=${requestOffset}&limit=${PAGE_SIZE}`,
      { signal: abortController.signal }
    );
    if (!res.ok) {
      // API は 4xx/5xx でも {"error":"..."} の JSON を返す
      let apiMsg = null;
      try { apiMsg = (await res.json())?.error ?? null; } catch (_) {}
      const err = new Error(apiMsg || `HTTP ${res.status}`);
      err.status     = res.status;
      err.apiMessage = apiMsg;
      throw err;
    }
    const data = await res.json();
    // レスポンス到着時点でクエリが変わっていたら破棄
    if (query !== currentQuery) return;
    hasNetworkError = false; // 成功したのでフラグ解除
    hasMore = !!data.hasMore;
    const newWords = data.words;
    currentOffset += newWords.length;

    // メモリキャッシュへページ単位で保存
    memCacheSet(query, requestOffset, data);

    if (reset || !currentData) {
      currentData = { ...data };
      renderResults(currentData);
      cacheWrite(query, currentData); // 1ページ目を sessionStorage にも保存
    } else {
      // ページネーション：差分のみ追記（全再描画なし）
      currentData.words = currentData.words.concat(newWords);
      currentData.count = currentData.words.length;
      currentData.hasMore = hasMore;
      appendResults(newWords, currentData);
    }

  } catch (e) {
    if (e.name === 'AbortError') return; // キャンセルされたリクエストは無視
    if (query !== currentQuery) return;  // 既にユーザーが別のクエリに移っていれば無視
    console.error(e);
    renderError(classifyError(e));
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
  const { count, hasMore: more } = data;
  const fullPattern = toFullWidthPattern(removeSpaces(inputEl.value.trim()));
  const patternHtml = `<span class="pattern">${escHtml(fullPattern)}</span>`;
  const countHtml   = `<span class="count">${count}${more ? '件以上' : '件'}</span>`;
  countEl.innerHTML = `【${patternHtml}】の検索結果（${countHtml}）`;
  countEl.classList.remove('stale');
  countEl.classList.toggle('zero', count === 0);
  announceCount(count, more);
  updateCopyAllBtn(data);
}

/** すべてコピーボタンの表示/有効状態を更新 */
function updateCopyAllBtn(data) {
  if (!copyAllBtn) return;
  // データなし／0件／全件未ロード（hasMore）は非表示
  if (!data || data.count === 0 || data.hasMore) {
    copyAllBtn.hidden = true;
    copyAllBtn.disabled = true;
    return;
  }
  copyAllBtn.hidden = false;
  copyAllBtn.disabled = false;
  copyAllBtn.title = '検索結果をすべてコピー';
}

/** スクリーンリーダー向け：検索結果件数を通知する */
function announceCount(count, more) {
  if (!srStatusEl) return;
  const msg = count === 0
    ? '該当する単語はありません'
    : `${count}件${more ? '以上' : ''}見つかりました`;
  // 同一文字列だと再通知されないため、一度空にしてから設定する
  srStatusEl.textContent = '';
  // 非同期化することで aria-live の確実な再発火を狙う
  setTimeout(() => { srStatusEl.textContent = msg; }, 30);
}

/** スクリーンリーダー通知をクリア */
function clearAnnouncement() {
  if (srStatusEl) srStatusEl.textContent = '';
}

/** 初回・リセット時のフル描画 */
function renderResults(data) {
  currentData = data;
  resultsList.classList.remove('stale');

  if (!data) {
    countEl.textContent = '';
    countEl.className   = '';
    resultsList.innerHTML = '';
    viewToggleGroup.hidden = true;
    resultsHeaderEl.hidden = true;
    mainEl.classList.remove('has-results');
    guideEl.hidden = false;
    updateCopyAllBtn(null);
    clearAnnouncement();
    setLoading(false);
    return;
  }

  resultsHeaderEl.hidden = false;
  mainEl.classList.add('has-results');
  guideEl.hidden = true;

  updateCountDisplay(data);

  if (data.count === 0) {
    viewToggleGroup.hidden = true; // 0件ならトグルは意味がないので隠す
    resultsList.innerHTML = '<li class="message">該当する単語が見つかりませんでした。</li>';
    suggestCandidates(currentQuery); // バックグラウンドで代替候補を取得し、見つかれば表示
    return;
  }

  viewToggleGroup.hidden = false;

  const fragment = document.createDocumentFragment();
  for (const word of data.words) {
    fragment.appendChild(buildWordItem(word));
  }
  resultsList.replaceChildren(fragment);
}

// ─── 0件時の代替候補提案（「もしかして？」） ─────────────────────────────────
// 入力パターンで 0 件だったとき、末尾に ＊ を付ける・1 文字削る・数字を ？ に
// 置き換える、などのバリエーションを API で並列チェックしてヒットする候補だけ表示。
function buildCandidates(q) {
  const out = [];
  const hasStar = /[*＊]/.test(q);
  const chars   = [...q];

  if (!hasStar) {
    out.push(q + '＊');      // 末尾ワイルドカード
    out.push('＊' + q);      // 先頭ワイルドカード
  }
  if (chars.length > 2) {
    out.push(chars.slice(0, -1).join('')); // 末尾1文字削除
  }
  if (/[1-9１-９]/.test(q)) {
    out.push(q.replace(/[1-9１-９]/g, '？')); // 数字ワイルドカード → ？
  }

  // 重複除去・元クエリと同一のものを除外・50文字超を除外
  return [...new Set(out)].filter(c => c !== q && c.length > 0 && c.length <= 50);
}

async function suggestCandidates(originalQuery) {
  const candidates = buildCandidates(originalQuery);
  if (candidates.length === 0) return;

  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        const res = await fetch(`${API_URL}?q=${encodeURIComponent(c)}&limit=1`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.count > 0 ? c : null;
      } catch (_) {
        return null;
      }
    })
  );

  // ユーザーが入力を変えていた・検索結果が変わっていたら表示しない
  if (removeSpaces(inputEl.value.trim()) !== originalQuery) return;
  if (currentData && currentData.count !== 0) return;

  const hits = results.filter(Boolean).slice(0, 3);
  if (hits.length === 0) return;

  renderSuggestions(hits);
}

function renderSuggestions(patterns) {
  const li = document.createElement('li');
  li.className = 'suggestions';

  const title = document.createElement('div');
  title.className = 'suggestions-title';
  title.textContent = 'もしかして？';
  li.appendChild(title);

  const row = document.createElement('div');
  row.className = 'suggestions-row';
  for (const p of patterns) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggestion-btn';
    btn.textContent = p;
    btn.addEventListener('click', () => {
      inputEl.value = p;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.focus();
    });
    row.appendChild(btn);
  }
  li.appendChild(row);
  resultsList.appendChild(li);
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
    console.error(err);
    showToast(btn, 'コピーに失敗しました', true);
  }
});

/** エラーを種別分け（ネットワーク / サーバー / クライアント / 不明） */
function classifyError(e) {
  // fetch 自体が失敗（DNS/CORS/ネットワーク断）→ TypeError
  if (e.name === 'TypeError' || !navigator.onLine) {
    return { kind: 'network' };
  }
  if (typeof e.status === 'number') {
    if (e.status >= 500) return { kind: 'server', message: e.apiMessage };
    if (e.status >= 400) return { kind: 'client', message: e.apiMessage };
  }
  return { kind: 'unknown', message: e.message };
}

function renderError(info) {
  // online 復帰時の自動リトライ対象はネットワークエラーのみ
  hasNetworkError = info.kind === 'network';

  // ヘッダーと件数表示はクリア（エラー時は混乱を避ける）
  countEl.textContent = '';
  countEl.className   = '';
  resultsHeaderEl.hidden = false;
  mainEl.classList.add('has-results');
  guideEl.hidden         = true;
  viewToggleGroup.hidden = true;
  updateCopyAllBtn(null);
  clearAnnouncement();

  let title, hint, showRetry;
  switch (info.kind) {
    case 'network':
      title     = 'ネットワークに接続できません。';
      hint      = '通信状況を確認して再度お試しください。';
      showRetry = true;
      break;
    case 'server':
      title     = 'サーバーでエラーが発生しました。';
      hint      = info.message || 'しばらく待ってから再度お試しください。';
      showRetry = true;
      break;
    case 'client':
      title     = info.message || 'リクエストに問題があります。';
      hint      = '入力内容を見直してください。';
      showRetry = false; // 同じクエリでの再試行は無意味
      break;
    default:
      title     = '予期しないエラーが発生しました。';
      hint      = info.message ? `詳細: ${info.message}` : '';
      showRetry = true;
  }

  const li = document.createElement('li');
  li.className = 'message error';

  const titleEl = document.createElement('div');
  titleEl.className = 'error-title';
  titleEl.textContent = title;
  li.appendChild(titleEl);

  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'error-hint';
    hintEl.textContent = hint;
    li.appendChild(hintEl);
  }

  if (showRetry) {
    const btn = document.createElement('button');
    btn.type        = 'button';
    btn.className   = 'error-retry';
    btn.textContent = '再試行';
    btn.addEventListener('click', () => doSearch(true));
    li.appendChild(btn);
  }

  resultsList.replaceChildren(li);
  setLoading(false);
  currentData = null;
}

// ─── 楽観サブセットフィルタ ──────────────────────────────────────────────────
// 前回の結果（currentData）を新クエリでローカルマッチして即表示する。
// マッチャのセマンティクスは PHP 側と同じなので、結果は常に正しい（偽陽性なし）。
// ただし currentData が部分ロード（hasMore）の場合は真のマッチのうち一部しか
// 拾えないため、API 確定で差し替えられるまで stale 表示とする。
function tryOptimisticFilter(newQuery) {
  if (!currentData || !Array.isArray(currentData.words) || currentData.words.length === 0) {
    return null;
  }
  const norm = normalizeForMatch(newQuery);
  if (!norm) return null;

  // 再帰爆発回避：* が多いパターンはローカル実行しない（バックエンドも制限あり）
  const starCount = (norm.match(/\*/g) || []).length;
  if (starCount > 3) return null;

  // 計算量制約：対象ワード数が多すぎるなら諦める
  if (currentData.words.length > 1000) return null;

  const matched = [];
  for (const w of currentData.words) {
    if (matchReading(w.reading, norm)) matched.push(w);
  }
  if (matched.length === 0) return null; // 0 件なら仮表示せず既存 stale に任せる
  return {
    count: matched.length,
    total: currentData.total,
    words: matched,
    hasMore: false, // ローカルフィルタ結果は「この集合内で完結」扱い
  };
}

// ─── バックグラウンドプリフェッチ ─────────────────────────────────────────────

/** アイドル時に次ページをバックグラウンド取得するスケジューラー */
// 大量結果は CSS の content-visibility でオフスクリーンを遅延描画するので
// DOM 上限を設けずに API の hasMore が尽きるまで取り切る
const PREFETCH_LIMIT = 10000; // API 側の OFFSET 上限（安全側の打ち切り）

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

// ─── キャッシュ（LRU メモリ + sessionStorage） ────────────────────────────────
// メモリ: クエリ×offset 粒度で保存（戻る・同クエリ再訪時の追加ページもゼロ待ち）
// sessionStorage: リロード復元用、1 ページ目のみ（容量節約）

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分（辞書は変わらないので長めでも安全）
const MEM_CACHE_MAX = 50;            // ~50 エントリ（100件×平均300Bで 1.5MB 程度）
const memCache = new Map();          // Map は挿入順を保つので LRU の土台に使える

function memKey(query, offset) { return `${query}@${offset}`; }

function memCacheGet(query, offset) {
  const k = memKey(query, offset);
  if (!memCache.has(k)) return null;
  const v = memCache.get(k);
  if (Date.now() - v.ts > CACHE_TTL_MS) {
    memCache.delete(k);
    return null;
  }
  // LRU: 参照時に末尾へ移動
  memCache.delete(k);
  memCache.set(k, v);
  return v.data;
}

function memCacheSet(query, offset, data) {
  const k = memKey(query, offset);
  memCache.set(k, { ts: Date.now(), data });
  if (memCache.size > MEM_CACHE_MAX) {
    // 最古（先頭）を落とす
    memCache.delete(memCache.keys().next().value);
  }
}

function cacheWrite(query, data) {
  // 1 ページ目のみ sessionStorage にも保存（リロード復元用）
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

function showToast(triggerEl, copiedText = '', isError = false, noPrefix = false) {
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);

  const rect = triggerEl.getBoundingClientRect();
  if (isError) {
    toastEl.textContent = copiedText || 'エラー';
  } else if (noPrefix) {
    toastEl.textContent = copiedText || 'コピーしました';
  } else {
    toastEl.textContent = copiedText ? `コピーしました: ${copiedText}` : 'コピーしました';
  }
  toastEl.classList.toggle('error', isError);

  // サイズ計測のため一時表示（opacity:0 のまま）
  toastEl.hidden = false;
  toastEl.classList.remove('show', 'hide', 'below');

  const toastW  = toastEl.offsetWidth;
  const toastH  = toastEl.offsetHeight;
  const btnCX   = rect.left + rect.width / 2;
  const padding = 8;
  const vw      = window.innerWidth;

  // 通常はボタンの上に表示。上に十分な余白がなければ下に出す
  // （スティッキーヘッダー内のボタンをタップしたときなどのケース）
  const showBelow = rect.top < toastH + padding + 8;

  // トースト左端をビューポート内にクランプ
  const rawLeft    = btnCX - toastW / 2;
  const clampedLeft = Math.max(padding, Math.min(vw - toastW - padding, rawLeft));

  // 三角はボタン中央を常に指す（クランプ量だけオフセット補正）
  const arrowLeft = btnCX - clampedLeft;

  toastEl.style.left = clampedLeft + 'px';
  toastEl.style.top  = showBelow ? (rect.bottom + 8) + 'px' : (rect.top - 8) + 'px';
  toastEl.style.setProperty('--arrow-left', arrowLeft + 'px');
  toastEl.classList.toggle('below', showBelow);

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

// ─── デバイス判定 ─────────────────────────────────────────────────────────────
/** タッチデバイス（スマホ・タブレット）かどうかを返す */
const isMobile = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// ─── スティッキー検索エリア：結果ヘッダーの top を動的に同期 ──────────────────────
function syncResultsHeaderTop() {
  // スマホは検索エリアが非sticky なので offset 不要
  if (isMobile()) {
    resultsHeaderEl.style.top = '0';
    return;
  }
  resultsHeaderEl.style.top = Math.ceil(searchAreaEl.getBoundingClientRect().height) + 'px';
}
syncResultsHeaderTop();
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(syncResultsHeaderTop).observe(searchAreaEl);
}

// ─── 下にスクロールしたかを検知して body.is-scrolled を付与 ───────────────────
// （PC表示時、最上部にいる間は検索エリア上部を 48px、スクロール後は 24px に縮小）
function updateIsScrolled() {
  const scrolled = window.scrollY > 0;
  const prev = document.body.classList.contains('is-scrolled');
  if (prev === scrolled) return;
  document.body.classList.toggle('is-scrolled', scrolled);
  // 検索エリアの高さが padding-top 変化で瞬時に変わるので、
  // 件数表示ヘッダーの sticky top も同タイミングで同期し、ズレ・揺れを防ぐ
  syncResultsHeaderTop();
}
updateIsScrolled();
window.addEventListener('scroll', updateIsScrolled, { passive: true });

// スマホ時はボタンの aria-label を「続けて検索」に更新
if (isMobile()) {
  backToTopBtn.setAttribute('aria-label', '続けて検索');
}

// スマホ：初期表示時 & キーボード開閉時にFAB位置を更新
updateFabBottom();
if (isMobile() && window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateFabBottom);
}


backToTopBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // スマホ：スクロール完了後に検索入力欄へフォーカス
  if (isMobile()) {
    inputEl.focus();
    inputEl.select();
  }
});


// ─── 初期状態（クエリなし）：ヘッダー非表示 ──────────────────────────────────────
resultsHeaderEl.hidden = true;

