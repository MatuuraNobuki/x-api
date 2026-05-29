# x-tracker

`@suiryuuuuu` のツイートを1時間ごとに取得し、CSVに蓄積する仕組み。
GitHub Actions 上で完全自動で動く。自分のPCは不要。
データ取得には Sorsa API(タイムライン直接取得)を使う。

## ファイル構成

```
x-tracker/
├─ fetch.js                      … 取得・CSV更新スクリプト(Node.js)
├─ .github/workflows/fetch.yml   … 1時間ごとに実行する設定
└─ data/                         … 実行後に自動生成されるCSV
   ├─ tweets.csv    … ツイート本文・投稿日時・URL(1ツイート1行、変化しない情報)
   ├─ metrics.csv   … いいね/RT/返信/引用/表示/ブクマ(観測のたびに追記)
   └─ account.csv   … フォロワー数・フォロー数・総ツイート数(1時間に1行)
```

## 初回セットアップ(5ステップ)

### 1. リポジトリを作る
GitHubで新しいリポジトリを作成。このフォルダの中身一式をpushする。

### 2. APIキーをSecretsに登録する
リポジトリの Settings → Secrets and variables → Actions → New repository secret
- Name: `SORSA_API_KEY`
- Secret: Sorsa(api.sorsa.io)のAPIキー

### 3. Actionsの書き込み権限を確認する
Settings → Actions → General → Workflow permissions で
「Read and write permissions」を選択して保存。

### 4. 手動で1回テスト実行する
Actions タブ → fetch-x-metrics → Run workflow。
緑のチェックがついたら成功。data/ にCSVが3つできる。

### 5. あとは放置
以後は毎時0分前後に自動実行され、CSVに追記され続ける。

## Claudeのプロジェクトナレッジへの連携

CSVが更新されてもClaude側は自動更新されない。分析したいタイミングで
data/ のCSVをダウンロードし、プロジェクトナレッジに(再)アップロードする。

## 仕様メモ

- Sorsa API の POST /v3/user-tweets を使う。ヘッダー ApiKey で認証。
  タイムライン直接取得なので、検索方式と違い取りこぼしが起きにくい。
  (検証で別ツールの全48件+雑談/返信を1ページで完全カバーできた)
- リツイートは除外(isRetweet フラグ等で判定)。返信・雑談は含む。
- 1ページ約20件。MAX_PAGES(初期値5)ぶん辿る。直近100件程度をカバー。
  もっと過去まで欲しい場合は fetch.yml の MAX_PAGES を増やす。
- フォロワー数は各ツイートに埋め込まれた author 情報から取得。

## 肥大化対策(いずれ必要になったら)

metrics.csv は1時間ごとに増える。重いのは行数なので、増えすぎたら
古い行を metrics_YYYY-MM.csv に退避し、本体は直近30日だけ残す。

## 注意点

- GitHub Actions の cron は正確な毎時0分ではなく、数分〜十数分ずれることがある。
  各行に取得時刻(fetched_at)を記録しているので分析上は問題ない。
- フィールド名はAPI側の仕様で変わる可能性がある。fetch.js は名前の揺れに
  両対応させているが、もし数値が全部0なら num()/str() の候補名を調整する。