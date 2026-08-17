import Anthropic from "@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JH = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };

const client = new Anthropic();

// Tiết kiệm token: KHÔNG gửi lại toàn bộ bài làm, chỉ gửi kết quả đã chấm
// từng câu (điểm + tóm tắt) để AI tổng hợp nhận xét chung cho cả đề.
const SYSTEM_PROMPT = `Bạn là giám khảo tổng kết bài thi Aptis Writing.
Bạn sẽ nhận được kết quả đã chấm riêng của từng câu (điểm số + tóm tắt nhận xét), KHÔNG có bài làm gốc.
Dựa trên các kết quả này, hãy:
1. Tính điểm trung bình chung (0-10).
2. Viết nhận xét tổng thể (3-4 câu) bằng tiếng Việt: xu hướng mạnh/yếu chung qua các phần, phần nào cần cải thiện nhất.
Không lặp lại nhận xét từng câu, chỉ tổng hợp xu hướng chung.
Trả lời CHỈ bằng JSON hợp lệ theo schema, không thêm text nào khác.`;

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
    const msg = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              averageScore: { type: "number", description: "Điểm trung bình 0-10" },
              overall: { type: "string", description: "Nhận xét tổng thể" },
            },
            required: ["averageScore", "overall"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: JSON.stringify(compact) }],
    });

    const text = msg.content.find((b) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    parsed.count = compact.length;
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "summary failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
};
