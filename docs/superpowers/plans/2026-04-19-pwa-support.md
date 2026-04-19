# PWA対応 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** クロスワード辞典をインストール可能なPWAにし、静的アセットをSWでキャッシュして高速化＆オフライン時の再表示を可能にする。

**Architecture:** `frontend/` 配下に `manifest.webmanifest` と `sw.js` を配置。SW は同一オリジンの静的資産を Stale-While-Revalidate で配信し、`api.php` は Network Only でパススルー。アイコンは Pillow で元 `favicon.png` から一括生成。

**Tech Stack:** プレーン HTML/CSS/JS、Service Worker API、Web App Manifest、Python + Pillow（アイコン生成のみ）。

**Version for this iteration:** `2026041933`（既存 `2026041932` から bump）

**テスト方針:** このプロジェクトに単体テストフレームワークは無い。検証はブラウザ（`preview_*` ツール + Chrome DevTools 相当の eval）による機能確認で行う。各タスクは commit をもって完了とし、最後に一括で DevTools/Lighthouse 相当の検証を実施。

---

## Task 1: アイコン生成スクリプト作成＆実行

**Files:**
- Create: `scripts/gen-pwa-icons.py`
- Generate (scripted output): `frontend/icon-192.png`, `frontend/icon-512.png`, `frontend/icon-maskable-512.png`, `frontend/apple-touch-icon.png`

- [ ] **Step 1: `scripts/gen-pwa-icons.py` を作成**

```python
"""PWA 用アイコンを frontend/favicon.png から生成する.

使い方: python scripts/gen-pwa-icons.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "favicon.png"
OUT_DIR = ROOT / "frontend"

# maskable 用の背景色（manifest の theme_color と一致）
MASKABLE_BG = (74, 94, 199, 255)  # #4a5ec7


def save_square(img: Image.Image, size: int, path: Path) -> None:
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(ROOT)} ({size}x{size})")


def save_maskable(img: Image.Image, size: int, path: Path) -> None:
    """セーフゾーン 80% を確保し、余白を theme_color で塗る."""
    canvas = Image.new("RGBA", (size, size), MASKABLE_BG)
    inner = int(size * 0.8)
    resized = img.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(resized, (offset, offset), resized if resized.mode == "RGBA" else None)
    canvas.save(path, format="PNG", optimize=True)
    print(f"  wrote {path.relative_to(ROOT)} ({size}x{size}, maskable)")


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"source not found: {SRC}")
    img = Image.open(SRC).convert("RGBA")
    print(f"source: {SRC.relative_to(ROOT)} ({img.size[0]}x{img.size[1]})")
    save_square(img, 192, OUT_DIR / "icon-192.png")
    save_square(img, 512, OUT_DIR / "icon-512.png")
    save_square(img, 180, OUT_DIR / "apple-touch-icon.png")
    save_maskable(img, 512, OUT_DIR / "icon-maskable-512.png")
    print("done.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 実行してアイコン生成**

Run: `python scripts/gen-pwa-icons.py`
Expected: 4 行の `wrote frontend/...` 出力、最後に `done.`

- [ ] **Step 3: 生成物を確認**

Run: `ls -la frontend/icon-192.png frontend/icon-512.png frontend/icon-maskable-512.png frontend/apple-touch-icon.png`
Expected: 4ファイルが存在し、サイズが非ゼロ。

- [ ] **Step 4: コミット**

```bash
git add scripts/gen-pwa-icons.py frontend/icon-192.png frontend/icon-512.png frontend/icon-maskable-512.png frontend/apple-touch-icon.png
git commit -m "PWAアイコン生成スクリプトと生成物を追加"
```

---

## Task 2: manifest.webmanifest 作成

**Files:**
- Create: `frontend/manifest.webmanifest`

- [ ] **Step 1: `frontend/manifest.webmanifest` を作成**

```json
{
  "name": "クロスワード辞典",
  "short_name": "クロスワード辞典",
  "description": "クロスワード作成支援用の単語検索ツール",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "theme_color": "#4a5ec7",
  "background_color": "#13161c",
  "lang": "ja",
  "dir": "ltr",
  "categories": ["utilities", "education"],
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

- [ ] **Step 2: コミット**

```bash
git add frontend/manifest.webmanifest
git commit -m "Web App Manifest を追加"
```

---

## Task 3: Service Worker 作成

**Files:**
- Create: `frontend/sw.js`

- [ ] **Step 1: `frontend/sw.js` を作成**

```js
/* クロスワード辞典 Service Worker
 * 戦略:
 *   - 同一オリジンの静的 GET: Stale-While-Revalidate
 *   - api.php: Network Only（キャッシュしない）
 *   - クロスオリジン: 介入しない
 */
const VERSION = '2026041933';
const CACHE_NAME = `findword-cache-${VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/help.html',
  '/privacy.html',
  `/style.css?v=${VERSION}`,
  `/app.js?v=${VERSION}`,
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('findword-cache-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // クロスオリジンは介入しない
  if (url.pathname.endsWith('/api.php')) return;             // API はネットワーク直

  event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: false });
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) return cached;
  const net = await networkPromise;
  if (net) return net;
  // オフラインかつキャッシュ無し: ナビゲーションなら index.html で代替
  if (req.mode === 'navigate') {
    const fallback = await cache.match('/index.html');
    if (fallback) return fallback;
  }
  return new Response('', { status: 504, statusText: 'offline' });
}
```

- [ ] **Step 2: コミット**

```bash
git add frontend/sw.js
git commit -m "Service Worker を追加"
```

---

## Task 4: HTML に manifest / apple-touch-icon リンクを追加

**Files:**
- Modify: `frontend/index.html`（`<head>` 内、既存 favicon リンクの直後）
- Modify: `frontend/help.html`（同上）
- Modify: `frontend/privacy.html`（同上）

- [ ] **Step 1: `frontend/index.html` の `<head>` を編集**

`<link rel="icon" type="image/png" href="favicon.png">` の直後に以下を追加:

```html
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

- [ ] **Step 2: `frontend/help.html` に同じ追加を実施**

同じ位置（`<link rel="icon" ...>` の直後）に同じ2行を追加。

- [ ] **Step 3: `frontend/privacy.html` に同じ追加を実施**

同じ位置に同じ2行を追加。

- [ ] **Step 4: コミット**

```bash
git add frontend/index.html frontend/help.html frontend/privacy.html
git commit -m "HTML に manifest / apple-touch-icon リンクを追加"
```

---

## Task 5: Service Worker 登録スクリプトを index.html に追加

**Files:**
- Modify: `frontend/index.html`（`<script src="app.js?v=...">` の直後）

- [ ] **Step 1: `index.html` 末尾の app.js 読み込み直後に登録スクリプトを追加**

既存:
```html
<script src="app.js?v=2026041932"></script>
```

の直後に挿入:

```html
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
</script>
```

- [ ] **Step 2: コミット**

```bash
git add frontend/index.html
git commit -m "Service Worker 登録スクリプトを index.html に追加"
```

---

## Task 6: キャッシュバスティング bump

**Files:**
- Modify: `frontend/index.html`（2箇所: style.css, app.js の ?v=）
- Modify: `frontend/help.html`（1箇所: style.css）
- Modify: `frontend/privacy.html`（1箇所: style.css）

- [ ] **Step 1: 全 HTML で `2026041932` → `2026041933` に置換**

対象ファイル3つ全てで `v=2026041932` を `v=2026041933` に変更。

- [ ] **Step 2: 置換結果を検証**

Run: `grep -rn "2026041932\|2026041933" frontend/*.html`
Expected: 全4箇所が `2026041933` になっており `2026041932` が残っていない。

- [ ] **Step 3: コミット**

```bash
git add frontend/index.html frontend/help.html frontend/privacy.html
git commit -m "キャッシュバスティングを2026041933にbump"
```

---

## Task 7: ブラウザ検証

**Files:** 変更なし

- [ ] **Step 1: プレビューで index.html を再読込**

`preview_eval` で `location.href = 'http://localhost:8000/frontend/index.html'` → reload。

- [ ] **Step 2: manifest が読み込まれていることを確認**

```js
preview_eval: (async () => {
  const r = await fetch('/frontend/manifest.webmanifest');
  const j = await r.json();
  return { ok: r.ok, name: j.name, display: j.display, icons: j.icons.length };
})()
```
Expected: `{ ok: true, name: 'クロスワード辞典', display: 'standalone', icons: 3 }`

注: プレビューサーバーのルートは `/frontend/` 配下ではなくリポジトリルートのため、SW スコープ `/` は本番デプロイ時の挙動と異なる。ローカル検証では manifest 読み込みと SW 登録可否のみ確認し、キャッシュ挙動は本番側で確認する。

- [ ] **Step 3: Service Worker が登録できることを確認**

```js
preview_eval: navigator.serviceWorker.getRegistrations().then(rs => rs.length)
```
（プレビューのパス構造上、登録が通らない場合は警告のみ許容し、本番で改めて確認する。）

- [ ] **Step 4: アイコン 4 種が 200 で返ることを確認**

```js
preview_eval: Promise.all(['/frontend/icon-192.png','/frontend/icon-512.png','/frontend/icon-maskable-512.png','/frontend/apple-touch-icon.png'].map(p => fetch(p).then(r => [p, r.status])))
```
Expected: 全て `status: 200`

- [ ] **Step 5: 最終 push**

```bash
git push origin master
```

---

## 完了条件
- 全タスクのコミット（最大7件）が master に積まれている
- `origin/master` に push 済み
- プレビューで manifest JSON がパース可能、アイコン 4 種が 200
- 本番デプロイ後（このリポジトリ外のプロセス）に Lighthouse PWA 監査で installability 通過

## 非対応（スコープ外）
- オフライン時の API 結果キャッシュ
- インストールプロンプト UI
- 更新通知バナー
- プッシュ通知
