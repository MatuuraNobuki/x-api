// fetch.js
// TwitterAPI.io から @suiryuuuuu のツイートを取得し、
// 3つのCSV(tweets / metrics / account)に追記・更新する。
//
//  - リツイート(retweeted_tweet が null でないもの)は除外する
//  - has_next_page / next_cursor を使ってページングし、上限まで集める
//  - フォロワー数はツイート内の author 情報から取る(別API呼び出し不要)
//
// 必要な環境変数:
//   TWITTERAPI_KEY ... TwitterAPI.io のAPIキー (GitHub Secrets から渡す)
//   X_USERNAME     ... 対象のハンドル(@抜き)。未設定なら下のDEFAULT。

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWITTERAPI_KEY;
const USERNAME = process.env.X_USERNAME || "suiryuuuuu";
const BASE = "https://api.twitterapi.io";

// ページングの最大ページ数。空ページを挟むことがあるので余裕をもたせる。
// (直近の投稿を取り切るのが目的。多すぎ＝古い投稿まで毎時取得＝割高 なので程々に)
const MAX_PAGES = 12;

const DATA_DIR = path.join(__dirname, "data");
const TWEETS_CSV = path.join(DATA_DIR, "tweets.csv");
const METRICS_CSV = path.join(DATA_DIR, "metrics.csv");
const ACCOUNT_CSV = path.join(DATA_DIR, "account.csv");

if (!API_KEY) {
  console.error("環境変数 TWITTERAPI_KEY が設定されていません。");
  process.exit(1);
}

// --- CSVエスケープ(カンマ・改行・引用符をRFC4180準拠で処理) ---
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

// 既存tweets.csvから登録済みツイートIDを読む(本文の重複追記を防ぐ)
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

// fetch のラッパー(リトライ付き)
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

// 1ページ分のツイート配列を取り出す(実レスポンスは data.tweets)
function extractTweets(json) {
  if (Array.isArray(json?.data?.tweets)) return json.data.tweets;
  if (Array.isArray(json?.tweets)) return json.tweets;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

// リツイート判定: retweeted_tweet が存在すればRT。保険で本文の "RT @" も見る。
function isRetweet(t) {
  if (t.retweeted_tweet) return true;
  if (typeof t.text === "string" && t.text.startsWith("RT @")) return true;
  return false;
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

  // --- ページングしながら全ツイートを集める ---
  // このAPIはページごとの件数が不安定で、途中で0件ページを返すことがある。
  // has_next_page と next_cursor がある限り、空ページが来ても数回は粘って先を試す。
  let allTweets = [];
  let cursor = "";
  let prevCursor = null;
  let emptyStreak = 0;
  const MAX_EMPTY_STREAK = 3; // 連続で空ページがこの回数続いたら本当に終わりと判断

  for (let page = 0; page < MAX_PAGES; page++) {
    let json;
    try {
      json = await apiGet("/twitter/user/last_tweets", {
        userName: USERNAME,
        cursor,
      });
    } catch (err) {
      console.error("ツイート取得に失敗:", err.message);
      break;
    }
    const pageTweets = extractTweets(json);
    allTweets = allTweets.concat(pageTweets);

    const hasNext = json?.has_next_page;
    const nextCursor = json?.next_cursor || "";
    console.log(
      `page ${page + 1}: ${pageTweets.length}件 (累計 ${allTweets.length}) ` +
        `has_next_page=${hasNext} next_cursor="${nextCursor.slice(0, 8)}..."`
    );

    // 空ページの連続をカウント(一時的な空きと本当の終端を区別する)
    if (pageTweets.length === 0) {
      emptyStreak++;
      if (emptyStreak >= MAX_EMPTY_STREAK) {
        console.log(`  停止: 空ページが${MAX_EMPTY_STREAK}回連続。終端と判断。`);
        break;
      }
    } else {
      emptyStreak = 0;
    }

    // 次に進むカーソルが無ければ終わり
    if (!nextCursor) {
      console.log("  停止: next_cursor が空。これ以上辿れない。");
      break;
    }
    // カーソルが前回と同じ = 同じページをループする異常。打ち切る。
    if (nextCursor === prevCursor) {
      console.log("  停止: next_cursor が前回と同じ。無限ループ回避のため打ち切り。");
      break;
    }
    // has_next_page が false でも、cursor があり中身が取れている間は念のため進む。
    // (このAPIは has_next_page を早めに false にすることがあるため)
    if (!hasNext && pageTweets.length === 0) {
      console.log("  停止: has_next_page=false かつ空ページ。終端と判断。");
      break;
    }

    prevCursor = nextCursor;
    cursor = nextCursor;
  }
  // 重複ツイート(ページ境界で混じることがある)をID基準で除去
  const seen = new Set();
  allTweets = allTweets.filter((t) => {
    const id = t.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  console.log(`ページング終了: 重複除去後 合計 ${allTweets.length}件`);

  // --- フォロワー数などは author 情報から取る(自分のツイートのauthorを使う) ---
  const me = allTweets.find((t) => t.author?.userName?.toLowerCase() === USERNAME.toLowerCase());
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

  // --- RTを除外して、本文マスターと数値を振り分け ---
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