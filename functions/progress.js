// Cloudflare Pages Function — tương đương netlify/functions/progress.mjs,
// dùng Cloudflare KV thay cho Netlify Blobs. Cần bind một KV namespace
// tên "PROGRESS_KV" cho project trong Cloudflare Dashboard.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JH = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" };

export async function onRequest(context) {
  const { request, env } = context;

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
