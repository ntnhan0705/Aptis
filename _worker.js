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

// Gọi thẳng Google Generative Language API. Chỉ được chạy bên trong
// GeminiProxy (Durable Object ghim vùng "wnam") — KHÔNG gọi trực tiếp từ
// handler ngoài, vì Worker thường chạy ở edge PoP gần người dùng và Google
// chặn theo vị trí nguồn request ("User location is not supported").
async function callGeminiDirect(env, systemInstruction, userText, responseSchema, maxOutputTokens) {
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

// Durable Object ghim vùng: buộc mọi lệnh gọi Gemini luôn xuất phát từ
// cùng một vùng (locationHint "wnam" khi lấy stub), bất kể request gốc
// tới Worker từ đâu — tránh bị Google chặn theo vị trí edge PoP.
export class GeminiProxy {
  constructor(ctx, env) {
    this.env = env;
  }
  async fetch(request) {
    const { systemInstruction, userText, responseSchema, maxOutputTokens } = await request.json();
    try {
      const result = await callGeminiDirect(this.env, systemInstruction, userText, responseSchema, maxOutputTokens);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}

async function callGemini(env, systemInstruction, userText, responseSchema, maxOutputTokens) {
  const id = env.GEMINI_PROXY.idFromName("gemini-proxy");
  const stub = env.GEMINI_PROXY.get(id, { locationHint: "wnam" });
  const res = await stub.fetch("https://gemini-proxy.internal/generate", {
    method: "POST",
    body: JSON.stringify({ systemInstruction, userText, responseSchema, maxOutputTokens }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || `proxy HTTP ${res.status}`);
  return json;
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

// ---------- /coach — AI coach: phân tích tiến độ + đề xuất lịch 7 ngày tới ----------
const COACH_SKILLS = ["listening", "reading", "writing", "speaking", "vocab", "all"];
const COACH_SYSTEM_PROMPT = `Bạn là huấn luyện viên luyện thi Aptis General (mục tiêu B2) cho một người đi làm, đang ôn bằng một ứng dụng có sẵn bộ đề.
Bạn nhận một bản tóm tắt tiến độ dạng JSON (KHÔNG có bài làm gốc): ngày hôm nay, ngày thi, quỹ thời gian mỗi ngày, số đề của từng kỹ năng, điểm từng đề (lần đầu / gần nhất / tốt nhất), Part hay sai (wrongRate = tỉ lệ câu sai), danh sách đề CHƯA LÀM LẦN NÀO, mức thuộc từ vựng, tình trạng so với lịch, lịch hiện tại 7 ngày tới, và lời khuyên lần trước (nếu có).
Nhiệm vụ:
1. "levels": ước tính trình độ CEFR hiện tại cho từng kỹ năng (A2, B1, B1+, B2, C) dựa trên điểm; ghi "Chưa đủ dữ liệu" nếu kỹ năng đó chưa có điểm.
2. "overall": 3-5 câu tiếng Việt — đang vượt hay chậm lịch, tiến bộ ra sao so với lần đầu / lần coach trước, kỹ năng nào kéo điểm xuống. Đi thẳng vào vấn đề, không khen sáo rỗng.
3. "priorities": đúng 3 ưu tiên cho 7 ngày tới, mỗi cái có "title" ngắn, "reason" (dẫn số liệu cụ thể trong JSON), "action" (việc làm cụ thể trong app).
4. "next7": lịch cho ĐÚNG 7 ngày bắt đầu từ "today" (mỗi ngày một phần tử, "date" dạng YYYY-MM-DD).
   - Tổng "minutes" của mỗi ngày không vượt quỹ thời gian của ngày đó (xem "capacity" trong JSON). Ngày thi và sau ngày thi không xếp việc.
   - Mỗi task: "skill" ∈ listening|reading|writing|speaking|vocab|all; "de" = số đề (1..tổng số đề của kỹ năng) hoặc 0 nếu không gắn đề cụ thể; "kind": "new" (đề chưa làm lần nào), "redo" (làm lại đề đã làm, ưu tiên đề điểm thấp), "drill" (luyện chuyên sâu một Part/dạng yếu, ghi rõ trong note), "mock" (thi thử đủ kỹ năng, skill = "all").
   - BẮT BUỘC: mọi đề trong "neverDone" phải được xếp hết trước ngày thi — nếu không vừa 7 ngày tới thì ưu tiên kỹ năng có nhiều đề chưa làm nhất; trong "note" của task cuối ghi đề nào còn lại để tuần sau.
   - KHỐI LƯỢNG CÂN ĐỐI: thứ Hai–Sáu mỗi ngày đúng 1 đề Listening + 1 đề Reading + 1 đề Writing hoặc Speaking (luân phiên). Cuối tuần ƯU TIÊN Writing/Speaking: thứ Bảy 1 đề Listening, Chủ nhật 1 đề Reading, còn lại ~6 đề Writing/Speaking chia đều (ngày thi thử thì task mock thay cho L/R). L/R đã làm hết thì làm lại đề điểm thấp. Mỗi ngày có 1 task vocab (~20 phút nếu còn nhóm chưa thuộc, xem vocab.groupsMastered).
   - Chỉ tạo task KIỂM TRA ĐƯỢC bằng bài nộp: mỗi task listening/reading/writing/speaking = nộp đúng 1 đề (de=0 nghĩa là 1 đề bất kỳ — muốn 2 đề thì tạo 2 task); vocab kind "new" = học thuộc nhóm từ tiếp theo (11 từ, ~20 phút, mỗi ngày tối đa 1 nhóm, ưu tiên trước khi ôn), kind "drill" = 40 lượt ôn flashcard các nhóm đã thuộc; mock = nộp 1 đề Listening + 1 Reading + 1 Speaking. Không tạo task kiểu "ôn sổ lỗi", "tổng hợp" không đo được.
   - Kỹ năng điểm cao ổn định (≥90%) chỉ cần duy trì nhẹ; dồn thời gian cho kỹ năng/Part yếu nhất. Writing và Speaking thường là nơi kéo điểm Aptis xuống.
   - Tuần cuối trước thi: giảm tải, có 1-2 buổi thi thử (mock), ngày trước thi chỉ ôn nhẹ.
   - "note" ngắn gọn bằng tiếng Việt, nói rõ cần làm gì (VD: "Làm lại, tập trung Part 3 — sai 40%").
5. "message": 1 câu động viên/nhắc nhở thực tế.`;
const COACH_SCHEMA = {
  type: "OBJECT",
  properties: {
    levels: {
      type: "OBJECT",
      properties: {
        listening: { type: "STRING" },
        reading: { type: "STRING" },
        writing: { type: "STRING" },
        speaking: { type: "STRING" },
      },
      required: ["listening", "reading", "writing", "speaking"],
    },
    overall: { type: "STRING" },
    priorities: {
      type: "ARRAY",
      minItems: "3",
      maxItems: "3",
      items: {
        type: "OBJECT",
        properties: { title: { type: "STRING" }, reason: { type: "STRING" }, action: { type: "STRING" } },
        required: ["title", "reason", "action"],
      },
    },
    next7: {
      type: "ARRAY",
      minItems: "7",
      maxItems: "7",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          tasks: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                skill: { type: "STRING", enum: COACH_SKILLS },
                de: { type: "INTEGER" },
                kind: { type: "STRING", enum: ["new", "redo", "drill", "mock"] },
                minutes: { type: "INTEGER" },
                note: { type: "STRING" },
              },
              required: ["skill", "de", "kind", "minutes", "note"],
            },
          },
        },
        required: ["date", "tasks"],
      },
    },
    message: { type: "STRING" },
  },
  required: ["levels", "overall", "priorities", "next7", "message"],
};

async function handleCoach(request, env) {
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response('{"error":"method"}', { status: 405, headers: JH });

  let raw = "";
  let body;
  try {
    raw = await request.text();
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: JH });
  }
  if (!body?.snapshot || typeof body.snapshot !== "object") {
    return new Response(JSON.stringify({ error: "missing snapshot" }), { status: 400, headers: JH });
  }
  // Snapshot chỉ là số liệu tóm tắt — chặn payload quá lớn để không đốt token.
  if (raw.length > 40000) {
    return new Response(JSON.stringify({ error: "snapshot too large" }), { status: 413, headers: JH });
  }

  try {
    const { parsed, tokens } = await callGemini(env, COACH_SYSTEM_PROMPT, JSON.stringify(body.snapshot), COACH_SCHEMA, 6144);
    parsed.tokens = tokens;
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "coach failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
}

// ---------- Router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/progress") return handleProgress(request, env);
    if (url.pathname === "/grade-writing") return handleGradeWriting(request, env);
    if (url.pathname === "/grade-summary") return handleGradeSummary(request, env);
    if (url.pathname === "/coach") return handleCoach(request, env);
    return env.ASSETS.fetch(request);
  },
};
