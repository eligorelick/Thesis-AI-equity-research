import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { connectionsView, selectConnection } from "@/ai/connections";
import { beginChatGpt, disconnectChatGpt } from "@/ai/chatgpt";
import { beginGemini, disconnectGemini } from "@/ai/gemini";
import { listChatGptModels } from "@/ai/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function response(body: unknown, status = 200) { return NextResponse.json(body, { status, headers }); }
function guard(request: Request) {
  const denied = assertSameOrigin(request);
  if (denied) return denied;
  // Local account credentials are never served through the optional LAN mode.
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/.test(request.headers.get("host") ?? "")) {
    return response({ error: "AI connections require local access on this computer." }, 403);
  }
  return null;
}

export async function GET(request: Request) {
  const denied = guard(request); if (denied) return denied;
  try { return response(connectionsView()); }
  catch { return response({ error: "AI connection storage is unavailable. Existing credentials were not replaced." }, 500); }
}

export async function POST(request: Request) {
  const denied = guard(request); if (denied) return denied;
  try {
    const text = await request.text();
    if (text.length > 8192) return response({ error: "Request is too large" }, 413);
    const body = JSON.parse(text);
    let message: string | undefined;
    const id = typeof body.id === "string" && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : undefined;
    switch (body.action) {
      case "connect-chatgpt":
        if (body.id !== undefined && !id) return response({ error: "Invalid connection" }, 400);
        await beginChatGpt(id); break;
      case "connect-gemini": await beginGemini(); break;
      case "disconnect-chatgpt":
        if (!id) return response({ error: "Invalid connection" }, 400);
        message = await disconnectChatGpt(id); break;
      case "disconnect-gemini": message = await disconnectGemini(); break;
      case "models":
        if (!id) return response({ error: "Invalid connection" }, 400);
        return response({ models: await listChatGptModels(id) });
      case "select": await selectConnection(body.selection); break;
      default: return response({ error: "Unknown connection action" }, 400);
    }
    return response({ ...connectionsView(), ...(message ? { message } : {}) });
  } catch (error) {
    const message = error instanceof Error && /^(Choose |Connect |Install |Unknown ChatGPT|ChatGPT |Gemini |AI credentials|AI connections|Too many|Invalid AI)/.test(error.message)
      ? error.message : "The connection action could not be completed. No paid request was sent.";
    return response({ error: message }, 400);
  }
}
