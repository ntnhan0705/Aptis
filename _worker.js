// Cloudflare Worker entry point (Workers + static assets).
// Khi có file _worker.js ở gốc, Cloudflare dùng file này làm entry chính
// thay vì tự route theo /functions — nên gộp cả 3 API vào đây, còn lại
// (mọi request khác) trả về file tĩnh qua env.ASSETS.fetch().

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JH = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };
const GEMINI_MODEL = "gemini-flash-latest";

// ---------- /progress — lưu tiến độ, dùng Cloudflare KV (binding PROGRESS_KV) ----------
async function handleProgress(request, env) {
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const code = (new URL(request.url).searchParams.get("code") || "").trim().toLowerCase();
  if (!code) return new Response('{"error":"no code"}', { status: 400, headers: JH });
  const key = "p_" + code;

  if (request.method === "GET") {
    let v = null;
    try {
      v = await env.PROGRESS_KV.get(key);
    } catch (e) {}
    return new Response(v || "{}", { status: 200, headers: JH });
  }

  if (request.method === "POST") {
    let body = "";
    try {
      body = await request.text();
      JSON.parse(body);
    } catch (e) {
      return new Response('{"ok":false}', { status: 400, headers: JH });
    }
    try {
      await env.PROGRESS_KV.put(key, body);
    } catch (e) {
      return new Response('{"ok":false}', { status: 500, headers: JH });
    }
    return new Response('{"ok":true}', { status: 200, headers: JH });
  }

  return new Response('{"error":"method"}', { status: 405, headers: JH });
}

// ---------- /grade-writing + /grade-summary — chấm bằng Gemini REST API ----------
const PART_RUBRICS = {
  Q1: {
    name: "Part 1 — Trả lời ngắn",
    criteria: ["Đúng yêu cầu câu hỏi (relevance)", "Chính tả & ngữ pháp cơ bản"],
  },
  Q2: {
    name: "Part 2 — Điền form / trả lời 3 câu ngắn",
    criteria: [
      "Trả lời đủ và đúng ý từng câu",
      "Ngữ pháp & từ vựng phù hợp",
      "Độ dài đúng khung yêu cầu",
    ],
  },
  Q3: {
    name: "Part 3 — Trả lời tin nhắn (văn phong thân mật)",
    criteria: [
      "Giọng văn thân mật, tự nhiên (informal tone)",
      "Ngữ pháp & từ vựng",
      "Mạch lạc, đủ ý trả lời",
    ],
  },
  Q4: {
    name: "Part 4 — Viết email (thân mật hoặc trang trọng)",
    criteria: [
      "Đúng văn phong yêu cầu (thân mật/trang trọng — informal/formal register)",
      "Nội dung đầy đủ theo yêu cầu đề bài",
      "Cấu trúc & mạch lạc",
      "Ngữ pháp & từ vựng",
      "Độ dài đúng khung yêu cầu",
    ],
  },
};
const DEFAULT_RUBRIC = {
  name: "Bài viết",
  criteria: ["Đúng ý câu hỏi", "Ngữ pháp & từ vựng", "Mạch lạc"],
};

function systemPromptFor(rubric) {
  return `Bạn là giám khảo chấm bài thi Aptis Writing, đang chấm phần "${rubric.name}".
Chấm riêng từng tiêu chí sau đây:
${rubric.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
Với mỗi tiêu chí:
- Nếu bài làm ĐÃ TỐT / không có lỗi đáng kể ở tiêu chí đó: để "comment" là chuỗi rỗng "" — KHÔNG khen, không viết gì.
- Nếu còn điểm cần cải thiện: viết "comment" ngắn gọn (1-2 câu) bằng tiếng Việt, nêu rõ lỗi/thiếu sót và cách sửa cụ thể. Không khen trước khi góp ý, đi thẳng vào điều cần cải thiện.
Sau đó cho điểm tổng trên thang 0-10 và một câu "summary" tóm tắt — chỉ nêu điều quan trọng nhất cần cải thiện (nếu bài đã hoàn thiện ở mọi mặt thì summary có thể ghi nhận điều đó, nhưng ưu tiên chỉ ra hướng cải thiện nếu có).
Không chấm tuyệt đối theo đáp án mẫu — chấp nhận mọi cách diễn đạt đúng ngữ pháp và đúng ý.
Field "criteria" phải có đúng ${rubric.criteria.length} phần tử (kể cả phần tử có comment rỗng), theo đúng thứ tự và tên tiêu chí đã liệt kê ở trên.`;
}

function schemaFor(rubric) {
  const n = String(rubric.criteria.length);
  return {
    type: "OBJECT",
    properties: {
      score: { type: "NUMBER", description: "Điểm tổng 0-10" },
      criteria: {
        type: "ARRAY",
        minItems: n,
        maxItems: n,
        items: {
          type: "OBJECT",
          properties: { name: { type: "STRING" }, comment: { type: "STRING" } },
          required: ["name", "comment"],
        },
      },
      summary: { type: "STRING", description: "Tóm tắt 1 câu" },
    },
    required: ["score", "criteria", "summary"],
  };
}

async function callGemini(env, systemInstruction, userText, responseSchema, maxOutputTokens) {
  const apiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: userText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema,
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens,
        },
      }),
    }
  );
  const json = await apiRes.json();
  if (!apiRes.ok) throw new Error(json?.error?.message || `HTTP ${apiRes.status}`);
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) {
    const reason = json.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`empty response from model (finishReason: ${reason})`);
  }
  const u = json.usageMetadata || {};
  return {
    parsed: JSON.parse(text),
    tokens: {
      prompt: u.promptTokenCount || 0,
      output: u.candidatesTokenCount || 0,
      thoughts: u.thoughtsTokenCount || 0,
      total: u.totalTokenCount || 0,
    },
  };
}

async function handleGradeWriting(request, env) {
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response('{"error":"method"}', { status: 405, headers: JH });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: JH });
  }

  const { question, answer, scenario, range, tag } = body || {};
  if (!question || !answer || !answer.trim()) {
    return new Response(JSON.stringify({ error: "missing question or answer" }), { status: 400, headers: JH });
  }

  const rubric = PART_RUBRICS[tag] || DEFAULT_RUBRIC;
  const userContent = [
    scenario ? `Tình huống: ${scenario}` : null,
    `Câu hỏi: ${question}`,
    range ? `Khung số từ yêu cầu: ${range[0]}-${range[1]} từ` : null,
    `Bài làm của học sinh: ${answer}`,
  ].filter(Boolean).join("\n");

  try {
    const { parsed, tokens } = await callGemini(env, systemPromptFor(rubric), userContent, schemaFor(rubric), 1024);
    parsed.partName = rubric.name;
    parsed.tokens = tokens;
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "grading failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
}

const SUMMARY_SYSTEM_PROMPT = `Bạn là giám khảo tổng kết bài thi Aptis Writing.
Bạn sẽ nhận được kết quả đã chấm riêng của từng câu (điểm số + tóm tắt nhận xét), KHÔNG có bài làm gốc.
Dựa trên các kết quả này, hãy:
1. Tính điểm trung bình chung (0-10).
2. Viết nhận xét tổng thể (3-4 câu) bằng tiếng Việt, tập trung vào ĐIỂM CẦN CẢI THIỆN: phần/kỹ năng nào yếu nhất, lỗi nào lặp lại nhiều lần qua các câu, nên ưu tiên luyện gì tiếp theo. Không cần liệt kê lại các điểm đã tốt — chỉ nhắc đến điểm mạnh nếu thực sự nổi bật và liên quan đến việc định hướng luyện tập tiếp theo.
Không lặp lại nhận xét từng câu, chỉ tổng hợp xu hướng chung.`;
const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    averageScore: { type: "NUMBER", description: "Điểm trung bình 0-10" },
    overall: { type: "STRING", description: "Nhận xét tổng thể" },
  },
  required: ["averageScore", "overall"],
};

async function handleGradeSummary(request, env) {
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response('{"error":"method"}', { status: 405, headers: JH });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: JH });
  }

  const results = Array.isArray(body?.results) ? body.results : [];
  if (!results.length) {
    return new Response(JSON.stringify({ error: "no graded results" }), { status: 400, headers: JH });
  }
  const compact = results.map((r) => ({ part: r.partName || r.tag, score: r.score, summary: r.summary }));

  try {
    const { parsed, tokens } = await callGemini(env, SUMMARY_SYSTEM_PROMPT, JSON.stringify(compact), SUMMARY_SCHEMA, 512);
    parsed.count = compact.length;
    parsed.tokens = tokens;
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "summary failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
}

// ---------- Router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/progress") return handleProgress(request, env);
    if (url.pathname === "/grade-writing") return handleGradeWriting(request, env);
    if (url.pathname === "/grade-summary") return handleGradeSummary(request, env);
    return env.ASSETS.fetch(request);
  },
};
