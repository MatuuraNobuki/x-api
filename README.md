# x-tracker

`@suiryuuuuu` のツイートとアカポ情報を1時間ごとに取得し、CSVに蓄積する仕組み。
GitHub Actions 上で完全自動で動く。自分のPCは不要。

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
GitHubで新しいリポジトリを作成(privateでもpublicでも可)。
このフォルダの中身一式(`fetch.js` と `.github/`)をpushする。

### 2. APIキーをSecretsに登録する
リポジトリの **Settings → Secrets and variables → Actions → New repository secret**
- Name: `TWITTERAPI_KEY`
- Secret: TwitterAPI.io のAPIキーを貼り付け

※キーは絶対にコードに直接書かないこと。Secretsに入れれば公開リポジトリでも安全。

### 3. Actionsの書き込み権限を確認する
**Settings → Actions → General → Workflow permissions** で
「Read and write permissions」を選択して保存。
(CSVをコミットするのに必要)

### 4. 手動で1回テスト実行する
**Actions タブ → fetch-x-metrics → Run workflow** を押す。
緑のチェックがついたら成功。`data/` にCSVが3つできているはず。

### 5. あとは放置
以後は毎時0分前後に自動実行され、CSVに追記され続ける。

## Claudeのプロジェクトナレッジへの連携

CSVが更新されてもClaude側は自動更新されない。分析したいタイミングで
`data/` のCSVをダウンロードし、プロジェクトナレッジに(再)アップロードする。

## 肥大化対策(いずれ必要になったら)

`metrics.csv` は1時間ごとに増える(1か月で数万行)。
重いのは数値ではなく行数なので、増えすぎたら
「古い行を `metrics_YYYY-MM.csv` に退避して本体は直近30日だけ残す」運用にする。
本文(tweets.csv)とアカウント情報(account.csv)は軽いので当面そのままでよい。

## 仕様メモ

- リツイートは除外する(`retweeted_tweet` が null でないものを弾く)。
  自分のオリジナル投稿・返信・引用だけが記録される。
- 1回の取得で複数ページを辿る(`has_next_page`/`next_cursor`)。
  上限は fetch.js の MAX_PAGES(初期値6ページ ≒ 100件強)。投稿が増えたら増やす。
- フォロワー数は各ツイートに含まれる author 情報から取得する。
  そのため別途ユーザー情報APIを叩く必要はない(呼び出し回数が減って割安)。

## 注意点

- GitHub Actions の cron は正確な毎時0分ではなく、数分〜十数分ずれることがある。
  各行に取得時刻(fetched_at)を記録しているので分析上は問題ない。
- APIが0件返しても最低15クレジット課金される(ごく僅か)。
- フィールド名はAPI側の仕様変更で変わる可能性がある。
  その場合 fetch.js の数値取り出し部分(likeCount など)を調整する。
