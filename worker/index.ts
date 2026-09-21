/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { automationRequest, executeJob, healthResponse } from "./automation";
import { dueJob } from "./automation-policy";
import { requireAuthenticatedSiteUser } from "./site-auth";
import { queueResearch, researchStatus, runResearch } from "./hypothesis-research";
import { integrateResponse } from "./hypothesis-integration";
import { productionHealth } from './production';

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FRED_API_KEY?: string;
  ALPHA_VANTAGE_API_KEY?: string;
  AUTOMATION_SECRET?: string;
  HYPOTHESIS_ENGINE_ENABLED?: string;
  HYPOTHESIS_PRODUCTION_WEIGHT?: string;
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
    const invoke = async (inner: Request) => {
      const response = await handler.fetch(inner, env, ctx);
      if (inner.method === "POST" && new URL(inner.url).pathname === "/api/refresh" && response.ok) queueResearch(env, ctx);
      return response;
    };

    if (url.pathname === "/api/automation/run" && request.method === "POST") return automationRequest(request, env, invoke);
    if (url.pathname.startsWith("/api/")) {
      const unauthorized = requireAuthenticatedSiteUser(request);
      if (unauthorized) return unauthorized;
    }
    if (url.pathname === "/api/health" && request.method === "GET") return healthResponse(env, invoke);
    if (url.pathname === '/api/production' && request.method === 'GET') {
      try { return Response.json(await productionHealth(env),{headers:{'Cache-Control':'private, no-store'}}); }
      catch { return Response.json({status:'unavailable',error:'Production status unavailable'},{status:503}); }
    }
    if (url.pathname === "/api/hypotheses" && request.method === "GET") {
      try { return Response.json(await researchStatus(env), { headers: { "Cache-Control": "no-store" } }); }
      catch { return Response.json({ error: "Research status unavailable", currentContribution: 0 }, { status: 503 }); }
    }
    if (url.pathname === "/api/hypotheses/run" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin) return Response.json({error:"Origin required"},{status:403});
      const result = await runResearch(env, "AUTHENTICATED_RESEARCH_TEST");
      return Response.json(result, { status: result.status === "FAILED" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && ["/api/refresh", "/api/retrain"].includes(url.pathname)) {
      return integrateResponse(request, await executeJob(env, invoke, url.pathname === "/api/refresh" ? "DAILY_REFRESH" : "WEEKLY_RETRAIN", "MANUAL", { request }), env);
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

    return integrateResponse(request, await handler.fetch(request, env, ctx), env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const type = dueJob(controller.cron, controller.scheduledTime);
    if (!type) return;
    ctx.waitUntil(executeJob(env, (request) => handler.fetch(request, env, ctx), type, "CLOUDFLARE_CRON", controller)
      .then((response) => { if (!response.ok) throw new Error(`FX automation failed: HTTP ${response.status}`); if (type === "DAILY_REFRESH") queueResearch(env, ctx); }));
  },
};

export default worker;
