import { GoogleGenAI, Type } from "@google/genai";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JH = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-flash-latest";

// Tiết kiệm token: KHÔNG gửi lại toàn bộ bài làm, chỉ gửi kết quả đã chấm
// từng câu (điểm + tóm tắt) để AI tổng hợp nhận xét chung cho cả đề.
const SYSTEM_PROMPT = `Bạn là giám khảo tổng kết bài thi Aptis Writing.
Bạn sẽ nhận được kết quả đã chấm riêng của từng câu (điểm số + tóm tắt nhận xét), KHÔNG có bài làm gốc.
Dựa trên các kết quả này, hãy:
1. Tính điểm trung bình chung (0-10).
2. Viết nhận xét tổng thể (3-4 câu) bằng tiếng Việt: xu hướng mạnh/yếu chung qua các phần, phần nào cần cải thiện nhất.
Không lặp lại nhận xét từng câu, chỉ tổng hợp xu hướng chung.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    averageScore: { type: Type.NUMBER, description: "Điểm trung bình 0-10" },
    overall: { type: Type.STRING, description: "Nhận xét tổng thể" },
  },
  required: ["averageScore", "overall"],
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response('{"error":"method"}', { status: 405, headers: JH });

  let body;
  try {
    body = await req.json();
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
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: JSON.stringify(compact),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 512,
      },
    });

    if (!response.text) {
      const reason = response.candidates?.[0]?.finishReason || "unknown";
      throw new Error(`empty response from model (finishReason: ${reason})`);
    }

    const parsed = JSON.parse(response.text);
    parsed.count = compact.length;
    const u = response.usageMetadata || {};
    parsed.tokens = {
      prompt: u.promptTokenCount || 0,
      output: u.candidatesTokenCount ?? u.responseTokenCount ?? 0,
      thoughts: u.thoughtsTokenCount || 0,
      total: u.totalTokenCount || 0,
    };
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "summary failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
};
