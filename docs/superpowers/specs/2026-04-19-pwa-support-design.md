# PWA対応 設計

- 日付: 2026-04-19
- スコープ: **B. 標準**（manifest + Service Worker / 静的資産キャッシュ）
- 目的: ホーム画面インストール可能化、静的アセットの高速化＆オフライン時に前回表示の維持

## 成果物

### 1. `frontend/manifest.webmanifest`
| フィールド | 値 |
|---|---|
| name | クロスワード辞典 |
| short_name | クロスワード辞典 |
| start_url | `/` |
| scope | `/` |
| display | `standalone` |
| orientation | `portrait` |
| theme_color | `#4a5ec7`（既存の theme-color と一致） |
| background_color | `#13161c`（ダーク基調、スプラッシュの視覚一貫性） |
| lang | `ja` |
| dir | `ltr` |
| categories | `["utilities", "education"]` |
| icons | 後述 4種 |

### 2. アイコン生成（Pillow スクリプト 1回実行）
元画像: `frontend/favicon.png` (512x512)

生成物を `frontend/` 配下に配置:
- `icon-192.png` (192x192, any)
- `icon-512.png` (512x512, any) ← 既存 favicon をコピー相当
- `icon-maskable-512.png` (512x512, maskable: セーフゾーン考慮で 80% に縮小し中央配置、背景は `#4a5ec7`)
- `apple-touch-icon.png` (180x180, iOS 用、余白なし)

生成スクリプト: `scripts/gen-pwa-icons.py`（リポジトリに保存、再生成可能）

### 3. `frontend/sw.js` — Service Worker
- **キャッシュ名**: `findword-cache-<VERSION>` （`VERSION` は既存バスティング値と同一文字列）
- **プリキャッシュ対象**（install 時に `cache.addAll`）:
  - `/`
  - `/index.html`
  - `/help.html`
  - `/privacy.html`
  - `/style.css?v=<VERSION>`
  - `/app.js?v=<VERSION>`
  - `/favicon.png`
  - `/icon-192.png`
  - `/icon-512.png`
  - `/icon-maskable-512.png`
  - `/apple-touch-icon.png`
  - `/manifest.webmanifest`
- **戦略**:
  - 同一オリジンの GET / static assets: **Stale-While-Revalidate**
  - `api.php` への fetch: **Network Only**（キャッシュしない、オフライン時は通常のネットワークエラー）
  - クロスオリジン（GA/Clarity 等）: SW 介入しない（pass-through）
- **アクティベーション**: `skipWaiting()` + `clients.claim()` でサイレント更新
- **古いキャッシュの削除**: activate 時に `findword-cache-*` で `VERSION` 不一致を削除

### 4. HTML 変更
3ファイル（`index.html` / `help.html` / `privacy.html`）の `<head>` に追加:
```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

`index.html` の `app.js` 読み込み直後に SW 登録スクリプトを追加:
```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js');
  });
}
```

### 5. バージョン管理
- 既存の `?v=YYYYMMDDNN` 方式を踏襲
- SW の `VERSION` 定数を HTML と手動で合わせる（キャッシュバスティング更新時に `sw.js` も同値に bump）
- 今回の投入バージョン: `2026041933`

## デプロイ注意点（ConoHa WING）
- `manifest.webmanifest` の MIME タイプは `application/manifest+json` 想定。`.webmanifest` 拡張子は大半のサーバで自動設定されるが、必要なら `.htaccess` で明示指定。
- `sw.js` は **ドキュメントルートに配置** する（`/frontend/` 以下ではなく、スコープ `/` を取るため）。ConoHa 側のデプロイ構成に合わせる。
- 本リポジトリ上は `frontend/sw.js` として配置し、デプロイ時にサイトルートへ配備されることを前提とする。

## 非スコープ（やらないこと）
- オフライン時の検索API結果キャッシュ（スコープC）
- インストールプロンプト UI（beforeinstallprompt）。ブラウザ標準 UI に任せる
- プッシュ通知
- バックグラウンド同期
- 更新通知バナー（サイレント更新で十分）

## テスト観点
1. Chrome DevTools Application → Manifest で manifest が読み込めること
2. Application → Service Workers で登録状態が `activated and is running`
3. ネットワークオフライン状態で再読込し、index.html が表示されること
4. Lighthouse PWA 監査で installability が通ること
5. iOS Safari でホーム画面に追加 → 起動時に standalone 表示（URLバーなし）
6. バージョン bump 後、旧キャッシュが activate で削除されていること（DevTools で確認）

## 実装手順（概要）
1. `scripts/gen-pwa-icons.py` 作成 → 実行 → アイコン4種生成
2. `frontend/manifest.webmanifest` 作成
3. `frontend/sw.js` 作成
4. 3 HTML に manifest/apple-touch-icon リンク追加
5. `index.html` に SW 登録スクリプト追加
6. キャッシュバスティング `2026041932` → `2026041933` に bump
7. ローカル検証（DevTools / Lighthouse）
