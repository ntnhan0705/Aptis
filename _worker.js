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
async function callGeminiDirect(env, systemInstruction, userText, responseSchema, maxOutputTokens, audio) {
  const apiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: audio ? [{ inline_data: { mime_type: audio.mime, data: audio.data } }, { text: userText }] : [{ text: userText }] }],
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
    const { systemInstruction, userText, responseSchema, maxOutputTokens, audio } = await request.json();
    try {
      const result = await callGeminiDirect(this.env, systemInstruction, userText, responseSchema, maxOutputTokens, audio);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}

async function callGemini(env, systemInstruction, userText, responseSchema, maxOutputTokens, audio) {
  const id = env.GEMINI_PROXY.idFromName("gemini-proxy");
  const stub = env.GEMINI_PROXY.get(id, { locationHint: "wnam" });
  const res = await stub.fetch("https://gemini-proxy.internal/generate", {
    method: "POST",
    body: JSON.stringify(audio ? { systemInstruction, userText, responseSchema, maxOutputTokens, audio } : { systemInstruction, userText, responseSchema, maxOutputTokens }),
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
   - KHỐI LƯỢNG: thứ Hai–Sáu mỗi ngày 1 task vocab (gói từ ~25 phút) + 1 đề Listening + 1 đề Reading + 2 đề Writing — KHÔNG xếp Speaking vào ngày thường. Thứ Bảy và Chủ nhật CHỈ xếp Speaking (khoảng 3 đề/ngày, mỗi đề ~60 phút; Speaking là kỹ năng yếu nhất nên có khung riêng), không xếp vocab, Listening, Reading, Writing vào cuối tuần. Thi thử tách theo kỹ năng: Speaking thi bấm giờ vào cuối tuần, Listening/Reading/Writing thi bấm giờ vào ngày thường (không dùng task mock skill "all"). L/R đã làm hết thì làm lại đề điểm thấp.
   - Chỉ tạo task KIỂM TRA ĐƯỢC bằng bài nộp: mỗi task listening/reading/writing/speaking = nộp đúng 1 đề (de=0 nghĩa là 1 đề bất kỳ — muốn 2 đề thì tạo 2 task); vocab = gói từ vựng hằng ngày (kind "new", de=0, ~25 phút): app tự lấy 40–45 từ B2+ (≥8 từ mới) — từ đến hạn ôn theo lặp lại ngắt quãng + từ mới của chính các đề trong ngày — mỗi ngày thường đúng 1 task vocab (cuối tuần không có). Không tạo task kiểu "ôn sổ lỗi", "tổng hợp" không đo được.
   - DỰ BÁO: planStatus.forecast = dự báo đến ngày thi (pacePct = % việc làm đề xong đúng hạn, projectedPct = % lộ trình xong nếu giữ tốc độ, lateCount/lateMin = việc trễ, extraMinPerDay7 = phút cần thêm mỗi ngày để bù trong 7 ngày). Nếu đang trễ: nói rõ trong overall con số trễ (%) và cách bù; xếp các đề trễ vào next7 (ưu tiên Writing/Speaking) mà không vượt quỹ thời gian từng ngày — nếu không đủ chỗ thì thay bớt đề làm lại L/R bằng đề trễ. Gói từ vựng của ngày đã qua KHÔNG phải việc trễ (từ đến hạn tự dồn sang gói mới), đừng nhắc tới.
   - PHÚT MỖI ĐỀ: dùng realMinutesPerSet / timePerTask (đo từ thời gian làm thực tế của người học) làm "minutes" cho task L/R/W/S thay vì 50/45 mặc định. Nếu một ngày còn dư thời gian ≥ phút của 1 đề thì thêm đề (ưu tiên đề trễ, rồi Writing/Speaking chưa làm hoặc điểm thấp).
   - THỜI GIAN THỰC TẾ: skills.<kỹ năng>.timing là số liệu các lần làm ở chế độ thi bấm giờ theo Part (timeUsedPct = % thời gian cho phép đã dùng, accuracy = % đúng; Writing là điểm AI ×10). Part dùng ≥90% thời gian mà accuracy < 80% là Part KHÓ NHẤT với người học — nêu rõ trong overall/priorities và xếp drill cho Part đó. Part làm nhanh và đúng cao thì chỉ duy trì. Nếu timing = null hoặc lastTimed đã cũ hơn 7 ngày, ghi trong note của task L/R/W là "chọn ⏱ Thi bấm giờ".
   - Kỹ năng điểm cao ổn định (≥90%) chỉ cần duy trì nhẹ; dồn thời gian cho kỹ năng/Part yếu nhất. Writing và Speaking thường là nơi kéo điểm Aptis xuống.
   - Tuần cuối trước thi: mỗi kỹ năng 1–2 lần thi bấm giờ như thật (Speaking vào cuối tuần), ngày trước thi chỉ 1 đề Speaking ôn nhẹ.
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

// ---------- /grade-speaking — chấm bài nói Aptis bằng Gemini (nghe file ghi âm thật) ----------
const SPEAK_CRITERIA = [
  "Hoàn thành nhiệm vụ (trả lời đúng & đủ mọi ý câu hỏi, đúng dạng bài của Part, đủ thời lượng)",
  "Ngữ pháp (độ đa dạng cấu trúc & độ chính xác)",
  "Từ vựng (độ phong phú, dùng đúng ngữ cảnh, đủ để diễn đạt chủ đề)",
  "Phát âm (rõ ràng, trọng âm, ngữ điệu — người nghe hiểu dễ không)",
  "Trôi chảy & liên kết (ít ngập ngừng, ý nối mạch, dùng từ nối)",
];
// Thang chấm của Aptis: Part 1–3 chấm 0–5, Part 4 chấm 0–6; mỗi band ứng với một mức CEFR
const SPEAK_BANDS = {
  P1: { max: 5, task: "Part 1 — trả lời câu hỏi về bản thân/đời sống, ~30 giây. Mức trần của Part này là B1.",
    cefr: ["A0", "A1", "A1", "A2", "A2", "B1"],
    desc: `5 (B1 trở lên): trả lời đúng trọng tâm, có lý do/ví dụ; câu đơn & ghép phần lớn đúng; từ vựng đủ cho chủ đề quen thuộc; phát âm dễ hiểu; ít ngập ngừng.
4 (A2.2): trả lời đúng câu hỏi bằng vài câu đơn nối với nhau; có lỗi nhưng không gây khó hiểu; phát âm hiểu được dù đôi chỗ phải cố.
3 (A2.1): trả lời được nhưng ngắn, chủ yếu cụm từ/câu đơn học thuộc; lỗi nhiều; ngập ngừng rõ.
2 (A1.2): chỉ vài cụm từ rời rạc, khó hiểu ở nhiều chỗ.
1 (A1.1): một vài từ đơn lẻ, gần như không truyền đạt được ý.
0: không nói, lạc đề hoàn toàn hoặc không phải tiếng Anh.` },
  P2: { max: 5, task: "Part 2 — tả một bức tranh rồi trả lời 2 câu hỏi liên quan (nêu trải nghiệm, ý kiến), mỗi câu ~45 giây.",
    cefr: ["A1", "A2", "A2", "B1", "B1+", "B2"],
    desc: `5 (B2 trở lên): trả lời đủ ý, phát triển thành đoạn có lý lẽ; cấu trúc phức (mệnh đề quan hệ, điều kiện, bị động…) phần lớn chính xác; từ vựng phong phú, chính xác; phát âm rõ, ngữ điệu tự nhiên; trôi chảy, liên kết tốt.
4 (B1.2): trả lời đủ ý, nói thành đoạn; có vài cấu trúc phức, lỗi không gây khó hiểu; từ vựng đủ cho chủ đề, đôi khi phải nói vòng; phát âm dễ hiểu; có ngập ngừng nhưng dùng từ nối mạch lạc.
3 (B1.1): trả lời đúng nhưng chưa phát triển ý; chủ yếu câu đơn/ghép; lỗi khá thường xuyên; từ vựng hạn chế, lặp từ; ngập ngừng nhiều.
2 (A2.2): trả lời một phần, câu đơn ngắn; lỗi nhiều, đôi chỗ khó hiểu.
1 (A2.1): chỉ vài cụm từ liên quan đến câu hỏi.
0: không nói hoặc không liên quan.` },
  P4: { max: 6, task: "Part 4 — 1 phút chuẩn bị, nói liền 2 phút trả lời 3 câu hỏi về một chủ đề trừu tượng (trải nghiệm → cảm nhận → ý kiến). Phải trả lời đủ các câu được hỏi và có bố cục.",
    cefr: ["A1", "A2", "B1", "B1+", "B2", "B2+", "C"],
    desc: `6 (C1 trở lên): trả lời trọn vẹn mọi câu, lập luận chặt chẽ, cấu trúc & từ vựng rộng và chính xác, rất trôi chảy.
5 (B2.2): đủ các câu, phát triển ý rõ có ví dụ; cấu trúc phức đa dạng, lỗi hiếm; từ vựng phong phú; trôi chảy, liên kết tốt.
4 (B2.1): đủ các câu, nói thành bài có bố cục; nhiều cấu trúc phức, lỗi không gây khó hiểu; từ vựng đủ rộng; đôi chỗ ngập ngừng.
3 (B1.2): trả lời được nhưng chưa sâu, hoặc bỏ sót 1 ý; có cấu trúc phức nhưng còn lỗi; từ vựng đủ dùng, có lặp; ngập ngừng khá nhiều.
2 (B1.1): trả lời được một phần, chủ yếu câu đơn; lỗi thường xuyên; không giữ được thời lượng.
1 (A2): vài câu ngắn rời rạc liên quan đến chủ đề.
0: không nói hoặc không liên quan.` },
};
SPEAK_BANDS.P3 = { ...SPEAK_BANDS.P2, task: "Part 3 — so sánh 2 bức tranh (giống/khác) rồi trả lời 2 câu hỏi liên quan (suy đoán, ý kiến), mỗi câu ~45 giây." };
function speakPrompt(P) {
  const B = SPEAK_BANDS[P] || SPEAK_BANDS.P2;
  return `Bạn là giám khảo Aptis General Speaking. Chấm như kỳ thi thật theo thang band của Part, KHÔNG so với bất kỳ bài mẫu nào — người học được nói theo ý riêng, miễn đúng câu hỏi.
${B.task}
Bạn nhận: câu hỏi, thời lượng yêu cầu, thời lượng thực tế, bản chữ do trình duyệt nhận dạng (hay sai, chỉ để tham khảo) và FILE GHI ÂM. Hãy NGHE file ghi âm để chấm.

THANG BAND của Part này (0–${B.max}) — chọn band mô tả đúng nhất bài nói:
${B.desc}

Rồi chấm riêng 5 tiêu chí, mỗi tiêu chí 0–5, nhất quán với band đã chọn:
${SPEAK_CRITERIA.map((c, i) => (i + 1) + '. ' + c).join('\n')}
Với mỗi tiêu chí: nếu đã tốt thì "comment" là ""; nếu cần cải thiện thì 1–2 câu tiếng Việt nêu lỗi cụ thể (trích từ/câu người học nói) và cách sửa, không khen trước khi góp ý.
Quy tắc: nói ngắn hơn nhiều so với thời lượng yêu cầu → hạ band, trừ tiêu chí 1 và 5. Lạc đề / không trả lời câu hỏi → tối đa band 2. Bỏ sót ý được hỏi → trừ tiêu chí 1.
Nếu không có file ghi âm: tiêu chí Phát âm cho score = -1, comment = "Không có file ghi âm", các tiêu chí khác chấm theo bản chữ.
Trả về:
- "band": số nguyên 0–${B.max};
- "transcript": những gì bạn nghe được (tiếng Anh);
- "summary": 1 câu tiếng Việt — điều quan trọng nhất để lên band tiếp theo;
- "pronunciation": tối đa 5 từ phát âm chưa đúng, mỗi phần tử {"word","tip"} (tip tiếng Việt ngắn: cách đọc, trọng âm);
- "better": bản trả lời tốt hơn bằng tiếng Anh, giữ ý của người nói, cao hơn một band, độ dài hợp thời lượng, câu dễ nói.`;
}
const SPEAK_SCHEMA = {
  type: "OBJECT",
  properties: {
    band: { type: "INTEGER" },
    transcript: { type: "STRING" },
    criteria: {
      type: "ARRAY", minItems: "5", maxItems: "5",
      items: { type: "OBJECT", properties: { name: { type: "STRING" }, score: { type: "NUMBER" }, comment: { type: "STRING" } }, required: ["name", "score", "comment"] },
    },
    summary: { type: "STRING" },
    pronunciation: {
      type: "ARRAY", maxItems: "5",
      items: { type: "OBJECT", properties: { word: { type: "STRING" }, tip: { type: "STRING" } }, required: ["word", "tip"] },
    },
    better: { type: "STRING" },
  },
  required: ["band", "transcript", "criteria", "summary", "pronunciation", "better"],
};
const AUDIO_MIME = /^audio\/(wav|x-wav|mp3|mpeg|aac|ogg|flac|webm)$/;

async function handleGradeSpeaking(request, env) {
  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response('{"error":"method"}', { status: 405, headers: JH });
  let raw = "", body;
  try { raw = await request.text(); body = JSON.parse(raw); }
  catch { return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: JH }); }
  // ~3 phút WAV 16 kHz mono ≈ 7.7 MB base64 — chặn payload quá lớn
  if (raw.length > 12_000_000) return new Response(JSON.stringify({ error: "audio too large" }), { status: 413, headers: JH });
  const { question, part, expectedSec, durationSec, transcript, audio } = body || {};
  if (!question || (!transcript && !audio)) {
    return new Response(JSON.stringify({ error: "missing question or recording" }), { status: 400, headers: JH });
  }
  const aud = audio && audio.data && AUDIO_MIME.test(audio.mime || "") ? { mime: audio.mime, data: audio.data } : undefined;
  const userText = [
    `Part: ${part || "?"}`,
    `Câu hỏi: ${question}`,
    expectedSec ? `Thời lượng yêu cầu: khoảng ${expectedSec} giây` : null,
    durationSec ? `Thời lượng thực tế: ${Math.round(durationSec)} giây` : null,
    `Bản chữ trình duyệt nhận dạng: ${transcript || "(không có)"}`,
    aud ? "Có file ghi âm đính kèm." : "Không có file ghi âm.",
  ].filter(Boolean).join("\n");
  try {
    const P = /^P[1-4]$/.test(part) ? part : "P2", B = SPEAK_BANDS[P];
    const { parsed, tokens } = await callGemini(env, speakPrompt(P), userText, SPEAK_SCHEMA, 2048, aud);
    // điểm suy ra từ band: overall 0–10, CEFR theo bảng band của Part
    const band = Math.max(0, Math.min(B.max, Math.round(+parsed.band || 0)));
    parsed.band = band; parsed.bandMax = B.max; parsed.part = P;
    parsed.overall = Math.round(band / B.max * 20) / 2;
    parsed.cefr = B.cefr[band];
    parsed.tokens = tokens;
    parsed.hadAudio = !!aud;
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "grading failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
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
    if (url.pathname === "/grade-speaking") return handleGradeSpeaking(request, env);
    return env.ASSETS.fetch(request);
  },
};
