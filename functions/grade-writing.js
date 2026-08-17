// Cloudflare Pages Function — tương đương netlify/functions/grade-writing.mjs.
// Gọi thẳng Gemini REST API bằng fetch (không dùng @google/genai) vì
// Cloudflare Pages Functions chạy trên Workers runtime, không phải Node.js.
// Cần biến môi trường GEMINI_API_KEY trong Cloudflare Dashboard.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JH = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };

const MODEL = "gemini-flash-latest";

// Mỗi Part trong đề Aptis Writing có tiêu chí chấm khác nhau — Part 1 chỉ cần
// đúng ý (1-5 từ), Part 4 cần đúng văn phong trang trọng/thân mật + lập luận.
const PART_RUBRICS = {
  Q1: {
    name: "Part 1 — Trả lời ngắn",
    criteria: [
      "Đúng yêu cầu câu hỏi (relevance)",
      "Chính tả & ngữ pháp cơ bản",
    ],
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
          properties: {
            name: { type: "STRING" },
            comment: { type: "STRING" },
          },
          required: ["name", "comment"],
        },
      },
      summary: { type: "STRING", description: "Tóm tắt 1 câu" },
    },
    required: ["score", "criteria", "summary"],
  };
}

export async function onRequestOptions() {
  return new Response("", { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

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
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPromptFor(rubric) }] },
          contents: [{ parts: [{ text: userContent }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schemaFor(rubric),
            // Tắt "thinking" — tác vụ chấm điểm ngắn, không cần suy luận dài.
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 1024,
          },
        }),
      }
    );

    const json = await apiRes.json();
    if (!apiRes.ok) {
      throw new Error(json?.error?.message || `HTTP ${apiRes.status}`);
    }

    const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) {
      const reason = json.candidates?.[0]?.finishReason || "unknown";
      throw new Error(`empty response from model (finishReason: ${reason})`);
    }

    const parsed = JSON.parse(text);
    parsed.partName = rubric.name;
    const u = json.usageMetadata || {};
    parsed.tokens = {
      prompt: u.promptTokenCount || 0,
      output: u.candidatesTokenCount || 0,
      thoughts: u.thoughtsTokenCount || 0,
      total: u.totalTokenCount || 0,
    };
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "grading failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
}
