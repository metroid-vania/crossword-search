# クロスワード単語検索 Webアプリ 仕様書

> エージェント/未来の自分への引継ぎ用ドキュメント。
> 検索仕様・データ・UI のいずれを触る場合も、まずこのファイルに目を通すこと。

## プロジェクト概要
SKK-JISYO.L（GPL）を加工した辞書データを使った
クロスワードパズル作成支援用の単語検索 Web アプリ。

- 本番 URL: <https://findword.crossword-builder.com/>
- 状態: **本番稼働中**（プロトタイプではなく実データで運用中）
- リポジトリ: <https://github.com/metroid-vania/crossword-search>

## ライセンス
- 辞書データ：SKK-JISYO.L（GPL v2 or later）
- Web アプリ全体は GPL v3 で公開（GPL v2+ と互換）
- 詳細・改変告知は [`NOTICE.md`](NOTICE.md)
- フッターに SKK 辞書 / skk-dev/dict / crossword-builder.com へのリンクとライセンス表記を設置

## 技術構成
- バックエンド：PHP + SQLite（ConoHa WING にデプロイ）
- フロントエンド：**静的 HTML + vanilla JavaScript + 自作 CSS**（ビルドツール／npm／フレームワーク不使用）
- データ：`words.txt`（UTF-8、約 153,310 行）→ `words.db`（SQLite）
- PWA 対応（`sw.js`、`manifest.webmanifest`）
- アクセス解析：Google Analytics + Microsoft Clarity（本番ドメインのみ有効）

## ファイル構成

```
crossword-search/
├── frontend/                 静的ファイル（クライアント側はすべてここ）
│   ├── index.html            画面構造（≈ 230 行）
│   ├── app.js                検索ロジック・UI 制御（≈ 1,100 行 / vanilla JS）
│   ├── style.css             デザイントークン＋コンポーネント（≈ 1,300 行）
│   ├── help.html             使い方ガイド
│   ├── privacy.html          プライバシーポリシー
│   ├── sw.js                 Service Worker（PWA）
│   ├── manifest.webmanifest  PWA マニフェスト
│   └── .htaccess             静的アセットの長期キャッシュ設定
├── backend/                  PHP（コードのみ Git 管理、words.db は対象外）
│   ├── api.php               検索 API（フロントが fetch）
│   ├── import.php            words.txt → words.db 構築スクリプト
│   └── search_cli.php        CLI から検索を試すためのデバッグツール
├── words.txt                 辞書本体（GPL、配布対象外 / .gitignore）
├── words_addition.txt        独自追加語（GPL v2+、Git 管理）
├── scripts/                  メンテ用スクリプト
├── docs/                     補助ドキュメント
├── README.md                 公開向け README
├── NOTICE.md                 GPL 著作権・改変告知
└── CLAUDE.md                 このファイル（エージェント向け仕様書）
```

## データフォーマット
カタカナ /表記1/表記2/.../
例：アイアン /iron/
- 2 文字以上の見出し語のみ取り込む
- 表記バリエーションは先頭 10 件まで

## 検索ロジック（重要）

### 検索画面の仕様
- ひとつの検索ボックスで入力を完結させる。

### 正規化
- ひらがな → カタカナに変換
- 表記ゆれ吸収：ァィゥェォッャュョ → ア行・ツ・ヤ行に統一
  （検索時のみ。表示は元のカタカナのまま）

### ワイルドカード
- `?` / `？`：任意の 1 文字
- `*` / `＊`：任意の 0 文字以上
- 半角・全角どちらも同様に処理
- ワイルドカードなし → 完全一致で検索

### 数字ワイルドカード（1〜9、全角可）
- 同じ数字 = 同じ文字に対応
- 違う数字 = 必ず違う文字（重要）
- 例：１？２？ → アイカギ○、アイアイ✕
- バックトラッキングで実装

### 検索結果
- リアルタイム検索（120ms debounce）
- ヒット件数を表示
- API は `offset` / `limit` によるページングと任意の `len` / `minLen` 文字数絞り込みに対応し、追加ページの有無を `hasMore` で返す
- `*` / `＊` を含む検索では、UI から 2〜7 文字・8文字以上の長さで絞り込める
- 0 件時は、条件を緩めた候補が API でヒット確認できた場合のみ「もしかして？」として表示する
- 「まとめてコピー」ボタン：
  - 0 件・追加ページあり（`hasMore`）の間は非表示/無効
  - 全件ロード済みの検索結果のみコピー可能
  - コピー内容の先頭に【検索パターン全角表記】を付加
  - 重複行は 1 行にまとめる

### コピー時の文字変換
- 拗音・促音を大文字に展開してコピー
  （ファックス → フアツクス、ジュン → ジユン）
- ひらがな → カタカナ変換も適用

## SQLite テーブル設計
- テーブル名：`words`
- カラム：`id`, `reading`（表示用カタカナ）, `normalized`（検索用正規化済み文字列）, `len`（検索用文字数）, `variants`（JSON 配列、最大 10 件）
- インデックス：`normalized`、`len, normalized`
- メタ情報：`meta(key, value)` に総件数 `total_words` を保存

## デザインシステム（重要）

**shadcn/ui new-york スタイルに寄せた CSS-only 実装**。React や shadcn 本体は使用していない（依存ゼロ方針を維持）。詳細は [`frontend/style.css`](frontend/style.css) の `:root` 周辺コメント参照。

### スタック
- フォント：**Inter**（英数のみ `frontend/fonts/inter-latin.woff2` で自前配信）+ システム日本語フォントへフォールバック
  - `font-feature-settings: "cv11", "ss01", "ss03"` で shadcn の字形に近づけている
- カラー基調：**zinc**（new-york new york デフォルト）
- ブランドプライマリ：indigo `#4a5ec7`（変更しないこと）
- スピナー：**lucide Loader2** の SVG パスを使用（`<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`）、回転 0.8s linear

### トークン規約
`:root` に 2 系統のトークンを定義している:

1. **`--clr-*`（レガシー）**: 既存 CSS との互換を保つために残置。新しい記述では原則使わないが、参照箇所がまだ多いので削除はしないこと。
2. **shadcn 命名（推奨）**: `--background` / `--foreground` / `--card` / `--card-foreground` / `--primary` / `--primary-foreground` / `--secondary` / `--muted` / `--muted-foreground` / `--accent` / `--accent-foreground` / `--destructive` / `--border` / `--input` / `--ring`

新規コンポーネント追加時は shadcn 命名側を優先して使う。

### 角丸・シャドウスケール
- `--radius` = 8px（card / area）
- `--radius-md` = 6px（button / input）
- `--radius-sm` = 4px（chip 内訳要素）
- `--shadow-xs / -sm / / -md / -lg`（控えめ → 強め）

### コンポーネント慣例
- **入力欄**: 1px ボーダー＋focus で `box-shadow: 0 0 0 3px var(--ring)` の ring
- **ボタン全般**: focus-visible で同じ ring パターンを当てる
- **ghost icon button**（クリア/コピー/テーマ/ヘルプ）: 透明背景、ホバーで `var(--accent)`
- **outline button**（候補チップ／suggestion 等）: 1px `var(--border)`、ホバーで `var(--accent)` + プライマリ縁
- **default button**（エラー時のリトライ等）: プライマリ塗り
- **ToggleGroup**（詳細/簡易表示切替）: 細ボーダー＋区切り線、active で塗りつぶし
- **Card**（結果カード／凡例カード）: 1px ボーダー＋`--shadow-xs`
- **Badge**（variant pill）: `var(--secondary)` 背景、ホバーで `var(--accent)` + プライマリ縁
- **Toast / Sonner**: 反転色（ライトモードで濃い背景、ダークモードで明色背景）

### ダークモード
- OS 設定追従（`prefers-color-scheme: dark`）＋ ヘッダーのトグルで `data-theme="dark|light"` 明示指定可
- 明示指定は `localStorage.theme` に保存
- 色値はトークン側で完結。コンポーネント CSS は基本的にトークン参照のみで両モードに対応する

## フロントエンドの状態
- **本番稼働中**。バックエンド API（`backend/api.php`）と接続済み。
- 検索結果は `fetch()` で JSON を取得して描画する実装になっている。
- ダミーデータでの動作確認フェーズは終了済み（過去の記述は削除）。

## キャッシュ戦略
- 静的アセット（`*.js`, `*.css`, `*.png`）は `.htaccess` で 1 年（`max-age=31536000, immutable`）キャッシュ
- `index.html` には `?v=YYYYMMDDXX` 形式のクエリでキャッシュバスティング
- **CSS や JS を変更したらこのバスター文字列を必ず更新する**（[index.html](frontend/index.html) 内の `app.js?v=...` / `style.css?v=...`）

## 開発フロー

### ローカル起動
```bash
# プロジェクトルートから
php -S localhost:8000 -t .
# → http://localhost:8000/frontend/
```

または `.claude/launch.json` 定義の "PHP Dev Server (全体)" を Claude Code 経由で起動可能。

### DB 更新
`words.txt` / `words_addition.txt` を変更したら:
```bash
php backend/import.php
```
（`/import-words-db` スキル経由でも同等）

### デプロイ
ConoHa WING への FTP/SSH アップロード（手順は管理者運用）。CI は未構成。

## コミットメッセージ運用
- **1 行タイトルのみ**。本文での詳細説明は不要。
- 日本語可。プレフィックス（`fix:` `feat:` 等）は付けない流儀。
- 例: `shadcn/ui new-york 寄せの土台：Inter フォント追加・トークン整備・スピナーを Loader2 に差し替え`

## 不採用済みの機能（再提案しない）
過去に試して没にした機能。再度提案しないこと:
- 検索履歴チップ（履歴を表示する UI）
- コピー済みハイライト
- ハプティックフィードバック
- URL 共有機能
- 五十音ジャンプナビ

## 注意事項
- `words.txt` / `words.db` はリポジトリに含めない（`.gitignore`）
- React や npm への移行は明示要望がない限り行わない（依存ゼロ方針）
- Tailwind を導入する場合も同様（CSS-only で shadcn 風を再現済）
