import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const router = httpRouter();

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });

async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function normalizeXHandle(raw: string) {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

function randomChallengeCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function fetchRecentXPosts(xHandle: string) {
  const rawBearer = process.env.X_BEARER_TOKEN;
  if (!rawBearer) throw new Error("X verification is not configured (missing X_BEARER_TOKEN)");
  const bearer = rawBearer.includes("%") ? decodeURIComponent(rawBearer) : rawBearer;

  const q = encodeURIComponent(`from:${xHandle}`);
  const url = `https://api.x.com/2/tweets/search/recent?query=${q}&max_results=10&tweet.fields=created_at`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API error (${res.status}): ${text.slice(0, 250)}`);
  }

  const body = await res.json() as { data?: Array<{ id: string; text: string }> };
  return body.data ?? [];
}

router.route({ path: "/api/health", method: "GET", handler: httpAction(async () => jsonResponse({ ok: true })) });

router.route({
  path: "/api/agents/register",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    if (!body?.name) return jsonResponse({ ok: false, error: "name is required" }, 400);
    try {
      const result = await ctx.runMutation(api.clapApi.registerAgent, {
        name: String(body.name),
        xHandle: body.xHandle ? String(body.xHandle) : undefined,
      });
      return jsonResponse({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to register agent";
      return jsonResponse({ ok: false, error: message }, 400);
    }
  }),
});

router.route({
  path: "/api/agents/clap",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    if (!body?.agentId || typeof body.clapping !== "boolean") {
      return jsonResponse({ ok: false, error: "agentId and clapping are required" }, 400);
    }
    const resolvedAgentId = await ctx.runQuery(api.clapApi.resolveAgentId, { agentId: String(body.agentId) });
    if (!resolvedAgentId) return jsonResponse({ ok: false, error: "Agent not found" }, 404);
    const result = await ctx.runMutation(api.clapApi.setClappingState, {
      agentId: resolvedAgentId,
      clapping: body.clapping,
    });
    return jsonResponse(result);
  }),
});

router.route({
  path: "/api/agents/heartbeat",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    if (!body?.agentId) return jsonResponse({ ok: false, error: "agentId is required" }, 400);
    const resolvedAgentId = await ctx.runQuery(api.clapApi.resolveAgentId, { agentId: String(body.agentId) });
    if (!resolvedAgentId) return jsonResponse({ ok: false, error: "Agent not found" }, 404);
    const result = await ctx.runMutation(api.clapApi.heartbeat, {
      agentId: resolvedAgentId,
      clapping: typeof body.clapping === "boolean" ? body.clapping : undefined,
    });
    return jsonResponse(result);
  }),
});

router.route({
  path: "/api/stats/current",
  method: "GET",
  handler: httpAction(async (ctx) => jsonResponse({ ok: true, ...(await ctx.runQuery(api.clapApi.getCurrentStats, {})) })),
});


router.route({
  path: "/api/stats/history",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const range = (url.searchParams.get("range") ?? "day") as "hour" | "day" | "week" | "month" | "all";
    const allowed = new Set(["hour", "day", "week", "month", "all"]);
    if (!allowed.has(range)) return jsonResponse({ ok: false, error: "Invalid range" }, 400);
    const data = await ctx.runQuery(api.clapApi.getClapRateHistory, { range });
    return jsonResponse({ ok: true, ...data });
  }),
});

router.route({
  path: "/api/verifications/x/start",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    if (!body?.agentId || !body?.xHandle) {
      return jsonResponse({ ok: false, error: "agentId and xHandle are required" }, 400);
    }

    const resolvedAgentId = await ctx.runQuery(api.clapApi.resolveAgentId, { agentId: String(body.agentId) });
    if (!resolvedAgentId) return jsonResponse({ ok: false, error: "Agent not found" }, 404);

    const xHandle = normalizeXHandle(String(body.xHandle));
    if (!xHandle.match(/^[a-z0-9_]{1,15}$/)) {
      return jsonResponse({ ok: false, error: "Invalid X handle format" }, 400);
    }

    const ttlMin = Number(process.env.X_VERIFY_CHALLENGE_TTL_MIN ?? "15");
    const expiresAt = Date.now() + Math.max(1, ttlMin) * 60_000;

    try {
      const agent = await ctx.runQuery(api.clapApi.getAgentById, { agentId: resolvedAgentId });
      if (!agent) return jsonResponse({ ok: false, error: "Agent not found" }, 404);

      const code = randomChallengeCode();
      const challengeText = `I'm claiming my agent ${agent.name} on @OpenClapp Verification CLAPP-${code}`;

      const result = await ctx.runMutation(api.clapApi.createXVerificationChallenge, {
        agentId: resolvedAgentId,
        xHandle,
        challengeText,
        expiresAt,
      });
      return jsonResponse({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start verification";
      return jsonResponse({ ok: false, error: message }, 400);
    }
  }),
});

router.route({
  path: "/api/verifications/x/check",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    if (!body?.challengeId) {
      return jsonResponse({ ok: false, error: "challengeId is required" }, 400);
    }

    try {
      const challenge = await ctx.runQuery(api.clapApi.getXVerificationChallengeForCheck, { challengeId: body.challengeId });
      if (!challenge) return jsonResponse({ ok: false, error: "Challenge not found" }, 404);
      if (challenge.completedAt) return jsonResponse({ ok: false, error: "Challenge already completed" }, 400);
      if (challenge.expiresAt < Date.now()) return jsonResponse({ ok: false, error: "Challenge expired" }, 400);

      const tweets = await fetchRecentXPosts(challenge.xHandle);
      const matched = tweets.find((t) => t.text.includes(challenge.challengeText));
      if (!matched) {
        return jsonResponse({ ok: false, verified: false, error: "Verification post not found yet" }, 404);
      }

      const result = await ctx.runMutation(api.clapApi.completeXVerificationChallenge, {
        challengeId: body.challengeId,
        matchedPostUrl: `https://x.com/${challenge.xHandle}/status/${matched.id}`,
      });

      return jsonResponse({ verified: true, matchedPostUrl: `https://x.com/${challenge.xHandle}/status/${matched.id}`, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to verify X challenge";
      return jsonResponse({ ok: false, error: message }, 400);
    }
  }),
});

router.route({
  path: "/api/agents",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);

    const verifiedOnlyRaw = url.searchParams.get("verifiedOnly") ?? "0";
    const verifiedOnly = verifiedOnlyRaw === "1" || verifiedOnlyRaw === "true";

    const result = await ctx.runQuery(api.clapApi.listAgents, {
      page: Number(url.searchParams.get("page") ?? "1"),
      pageSize: Number(url.searchParams.get("pageSize") ?? "24"),
      sort: (url.searchParams.get("sort") ?? "newest") as any,
      verifiedOnly,
    });

    return jsonResponse({ ok: true, ...result });
  }),
});


router.route({
  path: "/api/agent",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const name = url.searchParams.get("name");
    const id = url.searchParams.get("id");

    if (!name && !id) {
      return jsonResponse({ ok: false, error: "name or id is required" }, 400);
    }

    if (name) {
      const byName = await ctx.runQuery(api.clapApi.getAgentByName, { name });
      if (!byName) return jsonResponse({ ok: false, error: "Agent not found" }, 404);
      return jsonResponse({ ok: true, agent: byName });
    }

    const resolvedAgentId = await ctx.runQuery(api.clapApi.resolveAgentId, { agentId: String(id) });
    if (resolvedAgentId) {
      const byId = await ctx.runQuery(api.clapApi.getAgentById, { agentId: resolvedAgentId });
      if (!byId) return jsonResponse({ ok: false, error: "Agent not found" }, 404);
      return jsonResponse({ ok: true, agent: byId });
    }

    // Backward-compatible fallback: some old clients pass id=<agentName>
    const byNameFallback = await ctx.runQuery(api.clapApi.getAgentByName, { name: String(id) });
    if (!byNameFallback) return jsonResponse({ ok: false, error: "Agent not found" }, 404);
    return jsonResponse({ ok: true, agent: byNameFallback });
  }),
});

router.route({
  path: "/api/events",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? "20");
    const events = await ctx.runQuery(api.clapApi.getTickerEvents, { limit });
    return jsonResponse({ ok: true, events });
  }),
});

router.route({
  path: "/api/admin/wipe",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    if (!body) return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
    
    try {
      const result = await ctx.runMutation(api.clapApi.deleteAllAgentsAndData, {
        confirmWipe: String(body.confirmWipe ?? ""),
      });
      return jsonResponse(result);
    } catch (error: any) {
      return jsonResponse({ ok: false, error: error.message }, 400);
    }
  }),
});

export default router;
