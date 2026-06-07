const APP_VERSION = "v0.6.0";
const QUESTIONS_PER_ROUND = 10;
const SPEED_BONUS_LIMIT_SECONDS = 15;
const BASE_POINT = 1000;
const MAX_SPEED_BONUS = 500;

// Google Apps Script のウェブアプリURLを入れると全国ランキングが有効になります。
// 例: const RANKING_API_URL = "https://script.google.com/macros/s/AKfycb.../exec";
const RANKING_API_URL = "";
const RANKING_LIMIT = 20;

const $ = (id) => document.getElementById(id);

let allProblems = [];
let genres = [];
let activeGenre = "";
let currentQuestions = [];
let currentIndex = 0;
let score = 0;
let correctCount = 0;
let roundStartedAt = 0;
let roundFinishedAt = 0;
let questionStartedAt = 0;
let timerId = null;
let results = [];
let lastRoundSummary = null;
let rankingSubmitted = false;

const truthyValues = new Set(["1", "true", "TRUE", "yes", "YES", "y", "Y", "○", "〇", "◯", "あり", "有", "on", "ON"]);
const GENRE_ORDER = ["1年生", "2年生", "3年生", "4年生", "5年生", "6年生", "BLEACH", "ファントムシータ", "四字熟語", "難読", "地名"];

window.addEventListener("DOMContentLoaded", async () => {
  $("versionLabel").textContent = APP_VERSION;
  bindEvents();
  restorePlayerName();
  prepareLoadingState();
  await registerServiceWorker();
  await loadBundledCsv();
});

function bindEvents() {
  $("btnStart").addEventListener("click", () => startRound($("genreSelect").value));
  $("btnPracticeAll").addEventListener("click", () => startRound("__ALL__"));
  $("btnSubmit").addEventListener("click", submitAnswer);
  $("btnPass").addEventListener("click", () => gradeAnswer(true));
  $("btnQuit").addEventListener("click", backToSetup);
  $("btnRetry").addEventListener("click", () => startRound(activeGenre));
  $("btnBackHome").addEventListener("click", backToSetup);
  $("btnRefreshRanking").addEventListener("click", () => loadRanking($("genreSelect").value || activeGenre || "__ALL__"));
  $("btnSubmitRanking").addEventListener("click", submitRanking);
  $("genreSelect").addEventListener("change", () => {
    refreshSetupStats();
    loadRanking($("genreSelect").value);
  });
  $("genreSelect").addEventListener("input", refreshSetupStats);
  $("answerInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAnswer();
  });
  $("playerName").addEventListener("input", () => {
    localStorage.setItem("kanji-test-player-name", sanitizeName($("playerName").value));
  });
  $("csvFile").addEventListener("change", handleCsvFile);
  $("btnDownloadTemplate").addEventListener("click", downloadTemplateCsv);
  $("btnUpdate").addEventListener("click", hardReload);
}

function restorePlayerName() {
  const saved = localStorage.getItem("kanji-test-player-name") || "";
  $("playerName").value = saved;
}

function prepareLoadingState() {
  const select = $("genreSelect");
  select.innerHTML = "";
  select.append(new Option("problems.csv を読み込み中...", ""));
  select.disabled = true;
  $("btnStart").disabled = true;
  $("btnPracticeAll").disabled = true;
  $("problemCount").textContent = "0";
  $("csvStatus").textContent = "problems.csv 読み込み中...";
  renderRankingUnavailable();
}

async function loadBundledCsv() {
  const urls = [
    `./problems.csv?v=${encodeURIComponent(APP_VERSION)}&t=${Date.now()}`,
    "./problems.csv"
  ];

  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`CSVの読み込みに失敗しました: ${res.status}`);
      const text = await res.text();
      setProblemsFromCsv(text, "problems.csv 読み込み完了");
      return;
    } catch (err) {
      lastError = err;
      console.warn("problems.csv load failed", err);
    }
  }

  console.error(lastError);
  allProblems = [];
  genres = [];
  renderGenreSelect();
  $("csvStatus").textContent = "同梱 problems.csv を読み込めませんでした。CSVファイルを選択してください。";
  $("btnPracticeAll").disabled = true;
}

function handleCsvFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      setProblemsFromCsv(String(reader.result), `${file.name} を読み込みました。`);
    } catch (err) {
      console.error(err);
      $("csvStatus").textContent = `CSV読み込みエラー: ${err.message}`;
    }
  };
  reader.readAsText(file, "utf-8");
}

function setProblemsFromCsv(csvText, statusText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error("CSVにデータ行がありません。");
  const headers = rows[0].map((h) => h.trim());
  const required = ["kanji", "yomi"];
  for (const name of required) {
    if (!headers.includes(name)) throw new Error(`必須列 ${name} がありません。`);
  }

  const flagColumns = headers.filter((h) => h.startsWith("flag_")).map((h) => ({ column: h, genre: h.replace(/^flag_/, "") }));
  const parsed = rows.slice(1).map((cols, index) => rowToProblem(headers, cols, flagColumns, index + 2)).filter(Boolean);
  if (parsed.length === 0) throw new Error("有効な問題がありません。kanji と yomi を入力してください。");

  allProblems = parsed;
  genres = Array.from(new Set(parsed.flatMap((p) => p.genres))).sort(compareGenre);
  renderGenreSelect();
  refreshSetupStats();
  $("btnPracticeAll").disabled = allProblems.length === 0;
  $("csvStatus").textContent = statusText;
  loadRanking($("genreSelect").value);
}

function rowToProblem(headers, cols, flagColumns, rowNumber) {
  const obj = {};
  headers.forEach((h, i) => obj[h] = (cols[i] ?? "").trim());
  if (!obj.kanji || !obj.yomi) return null;

  const problemGenres = [];
  for (const flag of flagColumns) {
    if (truthyValues.has(obj[flag.column]) || truthyValues.has(normalizeAlpha(obj[flag.column]))) problemGenres.push(flag.genre);
  }

  for (const key of ["genre", "genres", "tag", "tags"]) {
    if (obj[key]) splitMulti(obj[key]).forEach((g) => problemGenres.push(g));
  }

  return {
    id: obj.id || `row-${rowNumber}`,
    kanji: obj.kanji,
    yomi: obj.yomi,
    note: obj.note || obj.memo || "",
    genres: Array.from(new Set(problemGenres.filter(Boolean))),
  };
}

function normalizeAlpha(value) {
  return String(value || "").trim().toLowerCase();
}

function splitMulti(value) {
  return String(value || "").split(/[;|、,／/]/).map((s) => s.trim()).filter(Boolean);
}

function compareGenre(a, b) {
  const ia = GENRE_ORDER.indexOf(a);
  const ib = GENRE_ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  return a.localeCompare(b, "ja");
}

function renderGenreSelect() {
  const select = $("genreSelect");
  select.innerHTML = "";
  if (genres.length === 0) {
    select.append(new Option("ジャンルなし", ""));
    select.disabled = true;
    $("btnStart").disabled = true;
    renderGenreButtons();
    return;
  }
  for (const genre of genres) select.append(new Option(genre, genre));
  select.disabled = false;
  $("btnStart").disabled = false;
  const preferred = genres.includes("1年生") ? "1年生" : genres[0];
  select.value = select.value || preferred;
  renderGenreButtons();
}

function refreshSetupStats() {
  const genre = $("genreSelect").value;
  const count = getProblemsByGenre(genre).length;
  $("problemCount").textContent = count.toLocaleString();
  $("bestScore").textContent = getBestScore(genre).toLocaleString();
  $("btnStart").disabled = count === 0;
  updateGenreButtons(genre);
}

function renderGenreButtons() {
  const wrap = $("genreButtonList");
  wrap.innerHTML = "";
  for (const genre of genres) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "genre-chip";
    btn.textContent = genre;
    btn.addEventListener("click", () => {
      $("genreSelect").value = genre;
      $("genreSelect").dispatchEvent(new Event("change", { bubbles: true }));
      refreshSetupStats();
    });
    wrap.appendChild(btn);
  }
  updateGenreButtons($("genreSelect").value);
}

function updateGenreButtons(active) {
  const wrap = $("genreButtonList");
  if (!wrap) return;
  for (const btn of wrap.querySelectorAll(".genre-chip")) {
    btn.classList.toggle("active", btn.textContent === active);
  }
}

function getProblemsByGenre(genre) {
  if (genre === "__ALL__") return allProblems;
  return allProblems.filter((p) => p.genres.includes(genre));
}

function startRound(genre) {
  const pool = getProblemsByGenre(genre);
  if (pool.length === 0) {
    alert("選択したジャンルに出題できる問題がありません。");
    return;
  }

  localStorage.setItem("kanji-test-player-name", sanitizeName($("playerName").value));
  activeGenre = genre;
  currentQuestions = pickQuestions(pool, QUESTIONS_PER_ROUND);
  currentIndex = 0;
  score = 0;
  correctCount = 0;
  results = [];
  lastRoundSummary = null;
  rankingSubmitted = false;
  roundStartedAt = performance.now();
  roundFinishedAt = 0;

  showScreen("quizScreen");
  $("answerInput").value = "";
  $("feedback").textContent = "";
  $("feedback").className = "feedback";
  renderQuestion();
  startTimer();
}

function pickQuestions(pool, count) {
  const shuffled = shuffle([...pool]);
  if (shuffled.length >= count) return shuffled.slice(0, count);
  const result = [...shuffled];
  while (result.length < count) {
    result.push(...shuffle([...pool]).slice(0, count - result.length));
  }
  return result;
}

function renderQuestion() {
  const q = currentQuestions[currentIndex];
  questionStartedAt = performance.now();
  $("progressLabel").textContent = `${currentIndex + 1} / ${QUESTIONS_PER_ROUND}`;
  $("scoreLabel").textContent = score.toLocaleString();
  $("genreBadge").textContent = activeGenre === "__ALL__" ? "全ジャンル混合" : activeGenre;
  $("kanjiQuestion").textContent = q.kanji;
  $("answerInput").value = "";
  setTimeout(() => {
    try {
      $("answerInput").focus({ preventScroll: true });
    } catch (err) {
      $("answerInput").focus();
    }
  }, 0);
}

function submitAnswer() {
  if ($("answerInput").value.trim() === "") return;
  gradeAnswer(false);
}

function gradeAnswer(isPass) {
  const q = currentQuestions[currentIndex];
  const seconds = (performance.now() - questionStartedAt) / 1000;
  const userAnswer = $("answerInput").value;
  const correctAnswers = splitAnswers(q.yomi);
  const normalizedUser = normalizeReading(userAnswer);
  const isCorrect = !isPass && correctAnswers.some((a) => normalizeReading(a) === normalizedUser);

  let point = 0;
  let speedBonus = 0;
  if (isCorrect) {
    speedBonus = Math.max(0, Math.round(MAX_SPEED_BONUS * (1 - Math.min(seconds, SPEED_BONUS_LIMIT_SECONDS) / SPEED_BONUS_LIMIT_SECONDS)));
    point = BASE_POINT + speedBonus;
    score += point;
    correctCount += 1;
  }

  results.push({
    kanji: q.kanji,
    yomi: q.yomi,
    answer: isPass ? "パス" : userAnswer,
    correct: isCorrect,
    seconds,
    point,
    speedBonus,
  });

  const fb = $("feedback");
  if (isCorrect) {
    fb.textContent = `正解！ +${point}点（スピードボーナス +${speedBonus}）`;
    fb.className = "feedback ok";
  } else {
    fb.textContent = `不正解：正解は「${correctAnswers[0]}」`;
    fb.className = "feedback ng";
  }

  currentIndex += 1;
  if (currentIndex >= QUESTIONS_PER_ROUND) {
    setTimeout(finishRound, 650);
  } else {
    setTimeout(() => {
      fb.textContent = "";
      fb.className = "feedback";
      renderQuestion();
    }, 650);
  }
}

function splitAnswers(value) {
  return String(value || "").split(/[|／/、,，]/).map((s) => s.trim()).filter(Boolean);
}

function normalizeReading(value) {
  return toHiragana(String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[\s　・･ー－‐―\-\.]/g, "")
    .toLowerCase());
}

function toHiragana(value) {
  return value.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function finishRound() {
  stopTimer();
  roundFinishedAt = performance.now();
  const avg = results.reduce((sum, r) => sum + r.seconds, 0) / results.length;
  const totalTime = (roundFinishedAt - roundStartedAt) / 1000;
  const previousBest = getBestScore(activeGenre);
  const isBest = score > previousBest;
  if (isBest) setBestScore(activeGenre, score);

  lastRoundSummary = {
    genre: activeGenre === "__ALL__" ? "全ジャンル混合" : activeGenre,
    score,
    correct: correctCount,
    total: QUESTIONS_PER_ROUND,
    avgTime: Number(avg.toFixed(3)),
    totalTime: Number(totalTime.toFixed(3)),
    version: APP_VERSION,
  };

  $("resultCorrect").textContent = `${correctCount} / ${QUESTIONS_PER_ROUND}`;
  $("resultScore").textContent = score.toLocaleString();
  $("resultAvgTime").textContent = `${avg.toFixed(1)}秒`;
  $("bestNotice").classList.toggle("hidden", !isBest);
  $("rankingSubmitStatus").textContent = RANKING_API_URL ? "名前を確認してランキングに登録できます。" : "ランキングURL未設定のため、GAS URLを app.js に設定してください。";
  $("btnSubmitRanking").disabled = !RANKING_API_URL;
  renderReviewList();
  showScreen("resultScreen");
}

function renderReviewList() {
  const list = $("reviewList");
  list.innerHTML = "";
  results.forEach((r, i) => {
    const item = document.createElement("div");
    item.className = "review-item";
    item.innerHTML = `
      <div><strong>${i + 1}. ${escapeHtml(r.kanji)}</strong><br><span class="muted">正解: ${escapeHtml(splitAnswers(r.yomi)[0] || r.yomi)}</span></div>
      <div class="muted">回答: ${escapeHtml(r.answer || "未入力")} / ${r.seconds.toFixed(1)}秒</div>
      <div class="review-mark ${r.correct ? "ok" : "ng"}">${r.correct ? "○" : "×"} ${r.point}点</div>
    `;
    list.appendChild(item);
  });
}

function startTimer() {
  stopTimer();
  timerId = setInterval(() => {
    const sec = (performance.now() - roundStartedAt) / 1000;
    $("timerLabel").textContent = `${sec.toFixed(1)}秒`;
  }, 100);
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

function showScreen(id) {
  ["setupScreen", "quizScreen", "resultScreen"].forEach((screenId) => $(screenId).classList.toggle("hidden", screenId !== id));
  document.body.classList.toggle("quiz-mode", id === "quizScreen");
  window.scrollTo(0, 0);
}

function backToSetup() {
  stopTimer();
  showScreen("setupScreen");
  refreshSetupStats();
  loadRanking($("genreSelect").value);
}

function getBestScore(genre) {
  return Number(localStorage.getItem(bestKey(genre)) || "0");
}
function setBestScore(genre, value) {
  localStorage.setItem(bestKey(genre), String(value));
}
function bestKey(genre) {
  return `kanji-test-best:${genre || "none"}`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const normalized = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

function downloadTemplateCsv() {
  const csv = "id,kanji,yomi,flag_1年生,flag_2年生,flag_3年生,flag_4年生,flag_5年生,flag_6年生,flag_BLEACH,flag_ファントムシータ,flag_四字熟語,flag_難読,flag_地名,note\n1,山,やま,1,,,,,,,,,,,小学1年\n2,銀行,ぎんこう,,,,1,,,,,,,,小学4年目安\n3,卍解,ばんかい,,,,,,,1,,,,,BLEACHジャンル例\n4,第6十刃,ぐりむじょーじゃがーじゃっく,,,,,,,1,,,,,BLEACHジャンル例\n5,幻視,びじょん,,,,,,,,1,,,,ファントムシータ例\n6,一期一会,いちごいちえ,,,,,,,,,1,,,四字熟語ジャンル例\n7,紫陽花,あじさい,,,,,,,,,,1,,難読漢字ジャンル例\n8,北海道,ほっかいどう,,,,,,,,,,,1,地名ジャンル例\n";
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kanji_questions_template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("sw.js");
  } catch (err) {
    console.warn("Service Worker registration failed", err);
  }
}

async function hardReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch (err) {
    console.warn(err);
  }
  location.reload(true);
}

function sanitizeName(value) {
  return String(value || "").normalize("NFKC").replace(/[\r\n\t]/g, " ").trim().slice(0, 20);
}

function renderRankingUnavailable() {
  $("rankingStatus").textContent = RANKING_API_URL ? "ランキング取得待機中" : "ランキングURL未設定";
  $("rankingList").innerHTML = "";
}

async function loadRanking(genre) {
  if (!RANKING_API_URL) {
    renderRankingUnavailable();
    return;
  }
  const targetGenre = genre === "__ALL__" ? "全ジャンル混合" : (genre || $("genreSelect").value || "");
  if (!targetGenre) return;
  $("rankingStatus").textContent = "ランキング取得中...";
  try {
    const data = await jsonpRequest(RANKING_API_URL, { action: "list", genre: targetGenre, limit: RANKING_LIMIT });
    renderRanking(data.items || []);
    $("rankingStatus").textContent = `${targetGenre} の上位 ${Math.min(RANKING_LIMIT, (data.items || []).length)}件`;
  } catch (err) {
    console.error(err);
    $("rankingStatus").textContent = "ランキングを取得できませんでした。";
  }
}

function renderRanking(items) {
  const list = $("rankingList");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<div class="ranking-empty">まだ記録がありません。</div>';
    return;
  }
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "ranking-row";
    const rank = item.rank || index + 1;
    const avg = Number(item.avgTime || 0).toFixed(1);
    row.innerHTML = `
      <div class="ranking-rank">${rank}</div>
      <div class="ranking-name">${escapeHtml(item.name || "名無し")}</div>
      <div class="ranking-score">${Number(item.score || 0).toLocaleString()}点</div>
      <div class="ranking-meta">${Number(item.correct || 0)}/${QUESTIONS_PER_ROUND}・平均${avg}秒</div>
    `;
    list.appendChild(row);
  });
}

async function submitRanking() {
  if (!RANKING_API_URL || !lastRoundSummary) return;
  if (rankingSubmitted) {
    $("rankingSubmitStatus").textContent = "この結果は登録済みです。";
    return;
  }
  const name = sanitizeName($("playerName").value) || "名無し";
  localStorage.setItem("kanji-test-player-name", name);
  $("rankingSubmitStatus").textContent = "ランキング登録中...";
  $("btnSubmitRanking").disabled = true;
  try {
    const data = await jsonpRequest(RANKING_API_URL, {
      action: "submit",
      name,
      genre: lastRoundSummary.genre,
      score: lastRoundSummary.score,
      correct: lastRoundSummary.correct,
      total: lastRoundSummary.total,
      avgTime: lastRoundSummary.avgTime,
      totalTime: lastRoundSummary.totalTime,
      version: lastRoundSummary.version,
    });
    rankingSubmitted = true;
    $("rankingSubmitStatus").textContent = data.rank ? `登録しました。現在 ${data.rank} 位です。` : "登録しました。";
    await loadRanking(lastRoundSummary.genre);
  } catch (err) {
    console.error(err);
    $("rankingSubmitStatus").textContent = "ランキング登録に失敗しました。";
    $("btnSubmitRanking").disabled = false;
  }
}

function jsonpRequest(baseUrl, params = {}) {
  return new Promise((resolve, reject) => {
    const callbackName = `kanjiQuizJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = new URL(baseUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set("callback", callbackName);

    const script = document.createElement("script");
    const timer = setTimeout(() => cleanup(new Error("timeout")), 12000);

    function cleanup(err, data) {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      if (err) reject(err);
      else resolve(data);
    }

    window[callbackName] = (data) => cleanup(null, data || {});
    script.onerror = () => cleanup(new Error("jsonp error"));
    script.src = url.toString();
    document.body.appendChild(script);
  });
}
