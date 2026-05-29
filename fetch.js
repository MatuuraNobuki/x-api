// fetch.js
// Sorsa API の /user-tweets で @suiryuuuuu のタイムラインを取得し、
// 3つのCSV(tweets / metrics / account)に追記・更新する。
//
// なぜ Sorsa /user-tweets か:
//   TwitterAPI.io は last_tweets(ページング不安定) も advanced_search(検索の
//   歯抜け) も全件取れなかった。Sorsa の user-tweets はタイムライン直接取得で、
//   検証では別ツールの全48件+αを1ページで取りこぼしゼロでカバーできた。
//
// 必要な環境変数:
//   SORSA_API_KEY ... Sorsa のAPIキー (GitHub Secrets から渡す)
//   X_USERNAME    ... 対象のハンドル(@抜き)。未設定なら下のDEFAULT。
//   MAX_PAGES     ... 取得ページ数の上限(未設定なら5。1ページ約20件)。

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.SORSA_API_KEY;
const USERNAME = process.env.X_USERNAME || "suiryuuuuu";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "5", 10);
const BASE_URL = "https://api.sorsa.io/v3";

const DATA_DIR = path.join(__dirname, "data");
const TWEETS_CSV = path.join(DATA_DIR, "tweets.csv");
const METRICS_CSV = path.join(DATA_DIR, "metrics.csv");
const ACCOUNT_CSV = path.join(DATA_DIR, "account.csv");

if (!API_KEY) {
  console.error("環境変数 SORSA_API_KEY が設定されていません。");
  process.exit(1);
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\n";
}
function ensureFile(file, header) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header);
}

function loadExistingTweetIds() {
  const ids = new Set();
  if (!fs.existsSync(TWEETS_CSV)) return ids;
  const lines = fs.readFileSync(TWEETS_CSV, "utf8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const firstComma = line.indexOf(",");
    const id = firstComma === -1 ? line : line.slice(0, firstComma);
    if (id) ids.add(id.replace(/^"|"$/g, ""));
  }
  return ids;
}

// Sorsa は POST + ヘッダー ApiKey。リトライ付き。
async function fetchPage(cursor) {
  const body = { username: USERNAME };
  if (cursor) body.next_cursor = cursor;

  const maxRetry = 3;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/user-tweets`, {
        method: "POST",
        headers: { ApiKey: API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      console.error(`リクエスト失敗 (${attempt}/${maxRetry}): ${err.message}`);
      if (attempt === maxRetry) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// フィールド名の揺れに両対応(Playground簡略形 と ドキュメントのcount形)
function num(t, ...keys) {
  for (const k of keys) {
    if (t[k] !== undefined && t[k] !== null) return t[k];
  }
  return 0;
}
function str(t, ...keys) {
  for (const k of keys) {
    if (t[k] !== undefined && t[k] !== null) return t[k];
  }
  return "";
}

function isRetweet(t) {
  // Sorsa: RTは retweeted_status に元ツイートが入る(nullでなければRT)
  if (t.retweeted_status) return true;
  if (t.isRetweet === true || t.is_retweet === true) return true;
  if (t.retweeted_tweet) return true; // 他形式の保険
  const text = str(t, "full_text", "content", "text");
  if (typeof text === "string" && text.startsWith("RT @")) return true;
  return false;
}

// このツイートの著者ハンドル(@抜き)を取り出す。
// 本番Sorsa: user.username。Playground簡略形: トップレベル handle。両対応。
function authorHandle(t) {
  const a = (t.user && typeof t.user === "object") ? t.user
          : (t.author && typeof t.author === "object") ? t.author
          : null;
  let h = "";
  if (a) h = str(a, "username", "userName", "screen_name", "handle");
  if (!h) h = str(t, "handle"); // Playground簡略形のフォールバック
  return String(h).replace(/^@/, "").toLowerCase();
}

// 本人の投稿か(他人のいいね・引用元などを除外するため)。
// 著者が判定できない場合は安全側に倒して除外する(混入を確実に防ぐ)。
function isOwnTweet(t) {
  return authorHandle(t) === USERNAME.toLowerCase();
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureFile(TWEETS_CSV, "tweet_id,text,created_at,url\n");
  ensureFile(
    METRICS_CSV,
    "fetched_at,tweet_id,likes,retweets,replies,quotes,views,bookmarks\n"
  );
  ensureFile(ACCOUNT_CSV, "fetched_at,followers,following,tweet_count\n");

  const fetchedAt = new Date().toISOString();

  // --- ページングしながらタイムラインを集める ---
  let allTweets = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let data;
    try {
      data = await fetchPage(cursor);
    } catch (err) {
      console.error("取得に失敗:", err.message);
      break;
    }
    const pageTweets = Array.isArray(data?.tweets) ? data.tweets : [];
    allTweets = allTweets.concat(pageTweets);
    cursor = data?.next_cursor || null;
    console.log(
      `page ${page + 1}: ${pageTweets.length}件 (累計 ${allTweets.length}) next_cursor=${cursor ? "あり" : "なし"}`
    );
    if (!cursor) {
      console.log("  完了: タイムライン終端に到達。");
      break;
    }
  }

  // 重複除去
  const seen = new Set();
  allTweets = allTweets.filter((t) => {
    const id = t.id || t.id_str;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  console.log(`取得完了: 重複除去後 合計 ${allTweets.length}件`);

  // --- フォロワー数などは author/user 情報から取る ---
  // (Sorsaは author を埋め込むが、簡略形だと文字列のことがある。両対応で探す)
  let author = {};
  for (const t of allTweets) {
    if (!isOwnTweet(t)) continue; // 本人のツイートのauthorだけ使う
    const a = (t.user && typeof t.user === "object") ? t.user
            : (t.author && typeof t.author === "object") ? t.author : null;
    if (a && (a.followers ?? a.followers_count) != null) {
      author = a;
      break;
    }
  }
  fs.appendFileSync(
    ACCOUNT_CSV,
    csvRow([
      fetchedAt,
      num(author, "followers_count", "followers"),
      num(author, "followings_count", "following"),
      num(author, "tweets_count", "statuses_count", "statusesCount", "tweet_count"),
    ])
  );
  console.log(
    `account: followers=${num(author, "followers_count", "followers") || "?"}`
  );

  // --- 本文マスターと数値を振り分け ---
  const known = loadExistingTweetIds();
  let newMaster = 0;
  let kept = 0;
  let skippedRT = 0;
  let skippedOther = 0;
  const otherAuthors = new Set();
  let metricRows = "";

  for (const t of allTweets) {
    if (isRetweet(t)) {
      skippedRT++;
      continue;
    }
    // 他人の投稿(いいね・引用元など)を除外
    if (!isOwnTweet(t)) {
      skippedOther++;
      otherAuthors.add(authorHandle(t));
      continue;
    }
    const id = t.id || t.id_str;
    if (!id) continue;
    kept++;

    const text = str(t, "content", "full_text", "text");
    const createdAt = str(t, "created_at", "date", "createdAt");
    const url = str(t, "link", "url");

    if (!known.has(String(id))) {
      fs.appendFileSync(TWEETS_CSV, csvRow([id, text, createdAt, url]));
      known.add(String(id));
      newMaster++;
    }

    metricRows += csvRow([
      fetchedAt,
      id,
      num(t, "likes", "likes_count", "likeCount", "favorite_count"),
      num(t, "retweets", "retweet_count", "retweetCount"),
      num(t, "replies", "reply_count", "replyCount"),
      num(t, "quotes", "quote_count", "quoteCount"),
      num(t, "views", "view_count", "viewCount"),
      num(t, "bookmarks", "bookmark_count", "bookmarkCount"),
    ]);
  }

  if (metricRows) fs.appendFileSync(METRICS_CSV, metricRows);
  console.log(
    `集計: 対象 ${kept}件 / RT除外 ${skippedRT}件 / 他人の投稿除外 ${skippedOther}件 / 新規マスター ${newMaster}件`
  );
  if (otherAuthors.size > 0) {
    console.log(`  除外した他人の著者: ${[...otherAuthors].join(", ")}`);
  }
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});