/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { automationRequest, executeJob, healthResponse } from "./automation";
import { dueJob } from "./automation-policy";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FRED_API_KEY?: string;
  ALPHA_VANTAGE_API_KEY?: string;
  AUTOMATION_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const invoke = (inner: Request) => handler.fetch(inner, env, ctx);

    if (url.pathname === "/api/health" && request.method === "GET") return healthResponse(env, invoke);
    if (url.pathname === "/api/automation/run" && request.method === "POST") return automationRequest(request, env, invoke);
    if (request.method === "POST" && ["/api/refresh", "/api/retrain"].includes(url.pathname)) {
      return executeJob(env, invoke, url.pathname === "/api/refresh" ? "DAILY_REFRESH" : "WEEKLY_RETRAIN", "MANUAL", { request });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const type = dueJob(controller.cron, controller.scheduledTime);
    if (!type) return;
    ctx.waitUntil(executeJob(env, (request) => handler.fetch(request, env, ctx), type, "CLOUDFLARE_CRON", controller)
      .then((response) => { if (!response.ok) throw new Error(`FX automation failed: HTTP ${response.status}`); }));
  },
};

export default worker;
