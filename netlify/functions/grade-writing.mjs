import { GoogleGenAI, Type } from "@google/genai";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JH = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash";

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
Chấm riêng từng tiêu chí sau đây, mỗi tiêu chí một nhận xét ngắn (1-2 câu) bằng tiếng Việt:
${rubric.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
Sau đó cho điểm tổng trên thang 0-10 và một câu tóm tắt.
Không chấm tuyệt đối theo đáp án mẫu — chấp nhận mọi cách diễn đạt đúng ngữ pháp và đúng ý.
Field "criteria" phải có đúng ${rubric.criteria.length} phần tử, theo đúng thứ tự và tên tiêu chí đã liệt kê ở trên.`;
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.NUMBER, description: "Điểm tổng 0-10" },
    criteria: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          comment: { type: Type.STRING },
        },
        required: ["name", "comment"],
      },
    },
    summary: { type: Type.STRING, description: "Tóm tắt 1 câu" },
  },
  required: ["score", "criteria", "summary"],
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
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userContent,
      config: {
        systemInstruction: systemPromptFor(rubric),
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    });

    const parsed = JSON.parse(response.text);
    parsed.partName = rubric.name;
    return new Response(JSON.stringify(parsed), { status: 200, headers: JH });
  } catch (e) {
    return new Response(JSON.stringify({ error: "grading failed", detail: String(e?.message || e) }), { status: 500, headers: JH });
  }
};
