// fetch.js
// TwitterAPI.io から自分のツイートとアカウント情報を取得し、
// 3つのCSV(tweets / metrics / account)に追記・更新する。
//
// 必要な環境変数:
//   TWITTERAPI_KEY ... TwitterAPI.io のAPIキー (GitHub Secrets から渡す)
//   X_USERNAME     ... 対象のハンドル (@抜き)。未設定なら下のDEFAULTを使う。

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWITTERAPI_KEY;
const USERNAME = process.env.X_USERNAME || "suiryuuuuu";
const BASE = "https://api.twitterapi.io";

// 出力先(リポジトリ直下の data/ フォルダ)
const DATA_DIR = path.join(__dirname, "data");
const TWEETS_CSV = path.join(DATA_DIR, "tweets.csv");
const METRICS_CSV = path.join(DATA_DIR, "metrics.csv");
const ACCOUNT_CSV = path.join(DATA_DIR, "account.csv");

if (!API_KEY) {
  console.error("環境変数 TWITTERAPI_KEY が設定されていません。");
  process.exit(1);
}

// --- CSVの値を安全に囲むためのヘルパー ---
// カンマ・改行・ダブルクォートを含む値をRFC4180準拠でエスケープする。
function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\n";
}

// ファイルが無ければヘッダー付きで作る
function ensureFile(file, header) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, header);
  }
}

// 既存tweets.csvから、登録済みのツイートIDの集合を読む(重複追記を防ぐ)
function loadExistingTweetIds() {
  const ids = new Set();
  if (!fs.existsSync(TWEETS_CSV)) return ids;
  const lines = fs.readFileSync(TWEETS_CSV, "utf8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // 先頭セル(tweet_id)だけ取り出す。idは数値文字列なので単純splitで十分。
    const firstComma = line.indexOf(",");
    const id = firstComma === -1 ? line : line.slice(0, firstComma);
    if (id) ids.add(id.replace(/^"|"$/g, ""));
  }
  return ids;
}

// fetch のラッパー(リトライ付き)
async function apiGet(endpoint, params) {
  const url = new URL(BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const maxRetry = 3;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const res = await fetch(url, { headers: { "X-API-Key": API_KEY } });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      return await res.json();
    } catch (err) {
      console.error(`リクエスト失敗 (${attempt}/${maxRetry}): ${err.message}`);
      if (attempt === maxRetry) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// ツイート配列・ユーザー情報は、エンドポイントによって入れ子の形が違うことがある。
// よくある形を順に探して取り出す。
function extractTweets(json) {
  if (Array.isArray(json?.tweets)) return json.tweets;
  if (Array.isArray(json?.data?.tweets)) return json.data.tweets;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

function extractUser(json) {
  return json?.data || json?.user || json || {};
}

// 1ツイートから数値を取り出す。フィールド名の揺れに両対応。
function pickTweetMetrics(t) {
  return {
    id: t.id || t.id_str || t.tweet_id,
    text: t.text || t.full_text || "",
    createdAt: t.createdAt || t.created_at || "",
    url: t.url || (t.id ? `https://x.com/${USERNAME}/status/${t.id}` : ""),
    likes: t.likeCount ?? t.favorite_count ?? t.favoriteCount ?? 0,
    retweets: t.retweetCount ?? t.retweet_count ?? 0,
    replies: t.replyCount ?? t.reply_count ?? 0,
    quotes: t.quoteCount ?? t.quote_count ?? 0,
    views: t.viewCount ?? t.view_count ?? t.views ?? 0,
    bookmarks: t.bookmarkCount ?? t.bookmark_count ?? 0,
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureFile(TWEETS_CSV, "tweet_id,text,created_at,url\n");
  ensureFile(
    METRICS_CSV,
    "fetched_at,tweet_id,likes,retweets,replies,quotes,views,bookmarks\n"
  );
  ensureFile(
    ACCOUNT_CSV,
    "fetched_at,followers,following,tweet_count\n"
  );

  // 取得時刻(UTC, ISO8601)。全行で共通のタイムスタンプを使う。
  const fetchedAt = new Date().toISOString();

  // --- 1) アカウント情報(フォロワー数など) ---
  let user = {};
  try {
    const userJson = await apiGet("/twitter/user/info", { userName: USERNAME });
    user = extractUser(userJson);
  } catch (err) {
    console.error("ユーザー情報の取得に失敗:", err.message);
  }

  const followers = user.followers ?? user.followersCount ?? "";
  const following = user.following ?? user.followingCount ?? "";
  const tweetCount = user.statusesCount ?? user.tweetCount ?? "";
  fs.appendFileSync(
    ACCOUNT_CSV,
    csvRow([fetchedAt, followers, following, tweetCount])
  );
  console.log(`account: followers=${followers}`);

  // --- 2) 最新ツイート ---
  let tweets = [];
  try {
    const tweetsJson = await apiGet("/twitter/user/last_tweets", {
      userName: USERNAME,
    });
    tweets = extractTweets(tweetsJson);
  } catch (err) {
    console.error("ツイート取得に失敗:", err.message);
  }
  console.log(`tweets fetched: ${tweets.length}`);

  const known = loadExistingTweetIds();
  let newMaster = 0;
  let metricRows = "";

  for (const raw of tweets) {
    const t = pickTweetMetrics(raw);
    if (!t.id) continue;

    // 本文等は初回だけマスターに追加
    if (!known.has(String(t.id))) {
      fs.appendFileSync(TWEETS_CSV, csvRow([t.id, t.text, t.createdAt, t.url]));
      known.add(String(t.id));
      newMaster++;
    }

    // 数値は毎回 metrics に追記
    metricRows += csvRow([
      fetchedAt,
      t.id,
      t.likes,
      t.retweets,
      t.replies,
      t.quotes,
      t.views,
      t.bookmarks,
    ]);
  }

  if (metricRows) fs.appendFileSync(METRICS_CSV, metricRows);
  console.log(`new master rows: ${newMaster}, metric rows added: ${tweets.length}`);
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
