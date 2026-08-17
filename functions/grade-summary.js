// Cloudflare Pages Function — tương đương netlify/functions/grade-summary.mjs.
// Gọi thẳng Gemini REST API bằng fetch. Cần biến môi trường GEMINI_API_KEY.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JH = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };

const MODEL = "gemini-flash-latest";

// Tiết kiệm token: KHÔNG gửi lại toàn bộ bài làm, chỉ gửi kết quả đã chấm
// từng câu (điểm + tóm tắt) để AI tổng hợp nhận xét chung cho cả đề.
const SYSTEM_PROMPT = `Bạn là giám khảo tổng kết bài thi Aptis Writing.
Bạn sẽ nhận được kết quả đã chấm riêng của từng câu (điểm số + tóm tắt nhận xét), KHÔNG có bài làm gốc.
Dựa trên các kết quả này, hãy:
1. Tính điểm trung bình chung (0-10).
2. Viết nhận xét tổng thể (3-4 câu) bằng tiếng Việt, tập trung vào ĐIỂM CẦN CẢI THIỆN: phần/kỹ năng nào yếu nhất, lỗi nào lặp lại nhiều lần qua các câu, nên ưu tiên luyện gì tiếp theo. Không cần liệt kê lại các điểm đã tốt — chỉ nhắc đến điểm mạnh nếu thực sự nổi bật và liên quan đến việc định hướng luyện tập tiếp theo.
Không lặp lại nhận xét từng câu, chỉ tổng hợp xu hướng chung.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    averageScore: { type: "NUMBER", description: "Điểm trung bình 0-10" },
    overall: { type: "STRING", description: "Nhận xét tổng thể" },
  },
  required: ["averageScore", "overall"],
};

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

  const results = Array.isArray(body?.results) ? body.results : [];
  if (!results.length) {
    return new Response(JSON.stringify({ error: "no graded results" }), { status: 400, headers: JH });
  }

  // Payload cực gọn: chỉ tag, tên phần, điểm, tóm tắt — không gửi câu hỏi/bài làm gốc.
  const compact = results.map((r) => ({
    part: r.partName || r.tag,
    score: r.score,
    summary: r.summary,
  }));

  try {
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: JSON.stringify(compact) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: SCHEMA,
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 512,
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
    parsed.count = compact.length;
    const u = json.usageMetadata || {};
    parsed.tokens = {
      prompt: u.promptTokenCount || 0,
      output: u.candidatesTokenCount || 0,
      thoughts: u.thoughtsTokenCount || 0,
      total: u.totalTokenCount || 0,
    };
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "summary failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
}
