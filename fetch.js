// fetch.js
// TwitterAPI.io の Advanced Search を「日付チャンク分割」で叩き、
// @suiryuuuuu のツイートを取りこぼしなく取得して3つのCSVに記録する。
//
// なぜ日付チャンクか:
//   Advanced Search の Latest は、日付指定なしだと新しい方に偏り、
//   古いツイートが has_next_page=false で静かに打ち切られる(検索の深さの壁)。
//   since:/until: で1週間ごとの窓に区切ると、各窓は件数が少なく深さの壁に
//   当たらないため、全期間を確実に辿れる。
//
// 必要な環境変数:
//   TWITTERAPI_KEY ... TwitterAPI.io のAPIキー (GitHub Secrets から渡す)
//   X_USERNAME     ... 対象のハンドル(@抜き)。未設定なら下のDEFAULT。
//   WEEKS_BACK     ... 何週間さかのぼるか(未設定なら6週)。

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWITTERAPI_KEY;
const USERNAME = process.env.X_USERNAME || "suiryuuuuu";
const WEEKS_BACK = parseInt(process.env.WEEKS_BACK || "100", 10);
const BASE = "https://api.twitterapi.io";

// 1チャンク内のページング安全弁
const MAX_PAGES_PER_CHUNK = 10;

const DATA_DIR = path.join(__dirname, "data");
const TWEETS_CSV = path.join(DATA_DIR, "tweets.csv");
const METRICS_CSV = path.join(DATA_DIR, "metrics.csv");
const ACCOUNT_CSV = path.join(DATA_DIR, "account.csv");

if (!API_KEY) {
  console.error("環境変数 TWITTERAPI_KEY が設定されていません。");
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

async function apiGet(endpoint, params) {
  const url = new URL(BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const maxRetry = 3;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const res = await fetch(url, { headers: { "X-API-Key": API_KEY } });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      console.error(`リクエスト失敗 (${attempt}/${maxRetry}): ${err.message}`);
      if (attempt === maxRetry) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function extractTweets(json) {
  if (Array.isArray(json?.tweets)) return json.tweets;
  if (Array.isArray(json?.data?.tweets)) return json.data.tweets;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

function isRetweet(t) {
  if (t.retweeted_tweet) return true;
  if (typeof t.text === "string" && t.text.startsWith("RT @")) return true;
  return false;
}

// YYYY-MM-DD 形式(Advanced Search の since:/until: はこの形式のみ)
function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// 1つの日付チャンクをページングして全ツイートを返す
async function fetchChunk(sinceStr, untilStr) {
  // -filter:retweets でRT除外。返信や雑談はそのまま含まれる。
  const query = `from:${USERNAME} since:${sinceStr} until:${untilStr} -filter:retweets`;
  let tweets = [];
  let cursor = "";
  const usedCursors = new Set();

  for (let page = 0; page < MAX_PAGES_PER_CHUNK; page++) {
    let json;
    try {
      json = await apiGet("/twitter/tweet/advanced_search", {
        query,
        queryType: "Latest",
        cursor,
      });
    } catch (err) {
      console.error(`  [${sinceStr}〜${untilStr}] 取得失敗:`, err.message);
      break;
    }
    const pageTweets = extractTweets(json);
    tweets = tweets.concat(pageTweets);

    const hasNext = json?.has_next_page;
    const nextCursor = json?.next_cursor || "";
    if (!hasNext || !nextCursor || usedCursors.has(nextCursor)) break;
    usedCursors.add(nextCursor);
    cursor = nextCursor;
  }
  console.log(`  チャンク ${sinceStr}〜${untilStr}: ${tweets.length}件`);
  return tweets;
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

  // --- 今日から WEEKS_BACK 週ぶん、1週間ごとの窓で検索する ---
  let allTweets = [];
  const now = new Date();
  for (let w = 0; w < WEEKS_BACK; w++) {
    const until = new Date(now.getTime() - w * 7 * 86400000);
    const since = new Date(now.getTime() - (w + 1) * 7 * 86400000);
    // until は排他的なので、当日分も拾えるよう最新チャンクは +1日 する
    const untilStr = ymd(new Date(until.getTime() + 86400000));
    const sinceStr = ymd(since);
    const chunk = await fetchChunk(sinceStr, untilStr);
    allTweets = allTweets.concat(chunk);
  }

  // 重複除去(チャンク境界で重なることがある)
  const seen = new Set();
  allTweets = allTweets.filter((t) => {
    const id = t.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  console.log(`全チャンク統合: 重複除去後 合計 ${allTweets.length}件`);

  // --- フォロワー数などは author 情報から取る ---
  const me = allTweets.find(
    (t) => t.author?.userName?.toLowerCase() === USERNAME.toLowerCase()
  );
  const author = me?.author || allTweets[0]?.author || {};
  fs.appendFileSync(
    ACCOUNT_CSV,
    csvRow([
      fetchedAt,
      author.followers ?? "",
      author.following ?? "",
      author.statusesCount ?? "",
    ])
  );
  console.log(`account: followers=${author.followers ?? "?"}`);

  // --- 本文マスターと数値を振り分け ---
  const known = loadExistingTweetIds();
  let newMaster = 0;
  let kept = 0;
  let skippedRT = 0;
  let metricRows = "";

  for (const t of allTweets) {
    if (isRetweet(t)) {
      skippedRT++;
      continue;
    }
    const id = t.id;
    if (!id) continue;
    kept++;

    if (!known.has(String(id))) {
      fs.appendFileSync(
        TWEETS_CSV,
        csvRow([id, t.text || "", t.createdAt || "", t.url || ""])
      );
      known.add(String(id));
      newMaster++;
    }

    metricRows += csvRow([
      fetchedAt,
      id,
      t.likeCount ?? 0,
      t.retweetCount ?? 0,
      t.replyCount ?? 0,
      t.quoteCount ?? 0,
      t.viewCount ?? 0,
      t.bookmarkCount ?? 0,
    ]);
  }

  if (metricRows) fs.appendFileSync(METRICS_CSV, metricRows);
  console.log(
    `集計: 対象ツイート ${kept}件 / RT除外 ${skippedRT}件 / 新規マスター ${newMaster}件`
  );
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});