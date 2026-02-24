import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

function normalizeXHandle(raw: string) {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

function clampPct(value: number) {
  return Math.max(0, Math.min(100, value));
}

function computeAgentPct(agent: {
  createdAt: number;
  cumulativeClapMs: number;
  isClapping: boolean;
  lastStateChangedAt: number;
}, now: number) {
  const elapsed = Math.max(1, now - agent.createdAt);
  const liveClapMs = agent.isClapping ? Math.max(0, now - agent.lastStateChangedAt) : 0;
  return clampPct(((agent.cumulativeClapMs + liveClapMs) / elapsed) * 100);
}

export const registerAgent = mutation({
  args: {
    name: v.string(),
    xHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      name: args.name.trim(),
      xHandle: args.xHandle ? normalizeXHandle(args.xHandle) : undefined,
      xVerified: false,
      isClapping: false,
      cumulativeClapMs: 0,
      lastStateChangedAt: now,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { agentId };
  },
});

export const setClappingState = mutation({
  args: {
    agentId: v.id("agents"),
    clapping: v.boolean(),
  },
  handler: async (ctx, { agentId, clapping }) => {
    const now = Date.now();
    const agent = await ctx.db.get(agentId);
    if (!agent) throw new Error("Agent not found");

    let cumulativeClapMs = agent.cumulativeClapMs;
    if (agent.isClapping && !clapping) {
      cumulativeClapMs += Math.max(0, now - agent.lastStateChangedAt);
    }

    const changed = agent.isClapping !== clapping;
    await ctx.db.patch(agentId, {
      isClapping: clapping,
      cumulativeClapMs,
      lastStateChangedAt: changed ? now : agent.lastStateChangedAt,
      lastHeartbeatAt: now,
      updatedAt: now,
    });

    if (changed) {
      await ctx.db.insert("clapEvents", {
        agentId,
        agentName: agent.name,
        type: clapping ? "started" : "stopped",
        createdAt: now,
      });
    }

    return { ok: true, changed };
  },
});

export const heartbeat = mutation({
  args: {
    agentId: v.id("agents"),
    clapping: v.optional(v.boolean()),
  },
  handler: async (ctx, { agentId, clapping }) => {
    const now = Date.now();
    const agent = await ctx.db.get(agentId);
    if (!agent) throw new Error("Agent not found");

    if (typeof clapping === "boolean") {
      let cumulativeClapMs = agent.cumulativeClapMs;
      if (agent.isClapping && !clapping) {
        cumulativeClapMs += Math.max(0, now - agent.lastStateChangedAt);
      }
      const changed = agent.isClapping !== clapping;

      await ctx.db.patch(agentId, {
        isClapping: clapping,
        cumulativeClapMs,
        lastStateChangedAt: changed ? now : agent.lastStateChangedAt,
        lastHeartbeatAt: now,
        updatedAt: now,
      });

      if (changed) {
        await ctx.db.insert("clapEvents", {
          agentId,
          agentName: agent.name,
          type: clapping ? "started" : "stopped",
          createdAt: now,
        });
      }
      return { ok: true, changed };
    }

    await ctx.db.patch(agentId, { lastHeartbeatAt: now, updatedAt: now });
    return { ok: true, changed: false };
  },
});

export const getCurrentStats = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const agents = await ctx.db.query("agents").collect();
    const total = agents.length;
    const clappingNow = agents.filter((a) => a.isClapping).length;

    const withPct = agents.map((a) => ({ ...a, clapPct: computeAgentPct(a, now) }));

    const groupPct = (subset: typeof withPct) => {
      if (!subset.length) return 0;
      const totals = subset.reduce(
        (acc, agent) => {
          const elapsed = Math.max(1, now - agent.createdAt);
          const liveClapMs = agent.isClapping ? Math.max(0, now - agent.lastStateChangedAt) : 0;
          acc.elapsed += elapsed;
          acc.clap += agent.cumulativeClapMs + liveClapMs;
          return acc;
        },
        { elapsed: 0, clap: 0 },
      );
      return clampPct((totals.clap / Math.max(1, totals.elapsed)) * 100);
    };

    const verified = withPct.filter((a) => a.xVerified);
    const unverified = withPct.filter((a) => !a.xVerified);
    const clappingNowVerified = verified.filter((a) => a.isClapping).length;
    const clappingNowUnverified = unverified.filter((a) => a.isClapping).length;

    return {
      totalAgents: total,
      totalAgentsVerified: verified.length,
      totalAgentsUnverified: unverified.length,
      clappingNow,
      clappingNowVerified,
      clappingNowUnverified,
      currentClappingPct: total ? (clappingNow / total) * 100 : 0,
      currentClappingPctVerified: verified.length ? (clappingNowVerified / verified.length) * 100 : 0,
      currentClappingPctUnverified: unverified.length ? (clappingNowUnverified / unverified.length) * 100 : 0,
      lifetimeClappingPctOverall: groupPct(withPct),
      lifetimeClappingPctVerified: groupPct(verified),
      lifetimeClappingPctUnverified: groupPct(unverified),
    };
  },
});

export const listAgents = query({
  args: {
    sort: v.optional(
      v.union(
        v.literal("newest"),
        v.literal("oldest"),
        v.literal("highest_clap"),
        v.literal("lowest_clap"),
      ),
    ),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
    verifiedOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = Math.max(1, args.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 24));
    const sort = args.sort ?? "newest";
    const verifiedOnly = Boolean(args.verifiedOnly);

    const agents = await ctx.db.query("agents").collect();

    const normalized = agents
      .filter((a) => (verifiedOnly ? a.xVerified : true))
      .map((a) => ({
        _id: a._id,
        name: a.name,
        xHandle: a.xHandle,
        xVerified: a.xVerified,
        isClapping: a.isClapping,
        createdAt: a.createdAt,
        clapPct: computeAgentPct(a, now),
      }));

    normalized.sort((a, b) => {
      if (sort === "oldest") return a.createdAt - b.createdAt;
      if (sort === "highest_clap") return b.clapPct - a.clapPct;
      if (sort === "lowest_clap") return a.clapPct - b.clapPct;
      return b.createdAt - a.createdAt;
    });

    const total = normalized.length;
    const start = (page - 1) * pageSize;
    const items = normalized.slice(start, start + pageSize);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items,
    };
  },
});

export const getAgentById = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const now = Date.now();
    const agent = await ctx.db.get(agentId);
    if (!agent) return null;
    return {
      _id: agent._id,
      name: agent.name,
      xHandle: agent.xHandle,
      xVerified: agent.xVerified,
      isClapping: agent.isClapping,
      clapPct: computeAgentPct(agent, now),
      createdAt: agent.createdAt,
      lastHeartbeatAt: agent.lastHeartbeatAt,
    };
  },
});


export const getClapRateHistory = query({
  args: { range: v.union(v.literal("hour"), v.literal("day"), v.literal("week"), v.literal("month"), v.literal("all")) },
  handler: async (ctx, { range }) => {
    const now = Date.now();
    const totalAgents = (await ctx.db.query("agents").collect()).length;
    const agentsNow = await ctx.db.query("agents").collect();
    const currentClappingNow = agentsNow.filter((a) => a.isClapping).length;

    const windows: Record<string, number> = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      all: 3650 * 24 * 60 * 60 * 1000,
    };

    const lookbackMs = windows[range];
    const fromTs = now - lookbackMs;

    const events = await ctx.db.query("clapEvents").withIndex("by_created_at").order("desc").take(5000);
    const filtered = events.filter((e) => e.createdAt >= fromTs);

    let running = currentClappingNow;
    const reversePoints: Array<{ ts: number; clappingNow: number; pct: number }> = [
      { ts: now, clappingNow: running, pct: totalAgents ? (running / totalAgents) * 100 : 0 },
    ];

    for (const e of filtered) {
      running += e.type === "started" ? -1 : 1;
      running = Math.max(0, Math.min(totalAgents, running));
      reversePoints.push({
        ts: e.createdAt,
        clappingNow: running,
        pct: totalAgents ? (running / totalAgents) * 100 : 0,
      });
    }

    const points = reversePoints.reverse();
    const maxPoints = range === "hour" ? 120 : range === "day" ? 200 : 260;
    const stride = Math.max(1, Math.ceil(points.length / maxPoints));
    const sampled = points.filter((_, i) => i % stride === 0 || i === points.length - 1);

    return { range, totalAgents, points: sampled };
  },
});

export const createXVerificationChallenge = mutation({
  args: {
    agentId: v.id("agents"),
    xHandle: v.string(),
    challengeText: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");

    const normalizedHandle = normalizeXHandle(args.xHandle);
    const existingOwner = await ctx.db
      .query("agents")
      .withIndex("by_x_verified")
      .filter((q) => q.and(q.eq(q.field("xVerified"), true), q.eq(q.field("xHandle"), normalizedHandle)))
      .first();

    if (existingOwner && existingOwner._id !== args.agentId) {
      throw new Error("That X handle is already linked to another verified agent");
    }

    const now = Date.now();
    const challengeId = await ctx.db.insert("xVerificationChallenges", {
      agentId: args.agentId,
      xHandle: normalizedHandle,
      challengeText: args.challengeText,
      createdAt: now,
      expiresAt: args.expiresAt,
    });

    await ctx.db.patch(args.agentId, {
      xHandle: normalizedHandle,
      updatedAt: now,
    });

    return { challengeId, challengeText: args.challengeText, xHandle: normalizedHandle, expiresAt: args.expiresAt };
  },
});

export const getXVerificationChallengeForCheck = query({
  args: { challengeId: v.id("xVerificationChallenges") },
  handler: async (ctx, { challengeId }) => {
    return await ctx.db.get(challengeId);
  },
});

export const completeXVerificationChallenge = mutation({
  args: {
    challengeId: v.id("xVerificationChallenges"),
    matchedPostUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const challenge = await ctx.db.get(args.challengeId);
    if (!challenge) throw new Error("Challenge not found");
    if (challenge.completedAt) throw new Error("Challenge already completed");
    if (challenge.expiresAt < Date.now()) throw new Error("Challenge expired");

    const existingOwner = await ctx.db
      .query("agents")
      .withIndex("by_x_verified")
      .filter((q) => q.and(q.eq(q.field("xVerified"), true), q.eq(q.field("xHandle"), challenge.xHandle)))
      .first();

    if (existingOwner && existingOwner._id !== challenge.agentId) {
      throw new Error("That X handle is already linked to another verified agent");
    }

    const now = Date.now();
    await ctx.db.patch(challenge._id, {
      completedAt: now,
      matchedPostUrl: args.matchedPostUrl,
    });

    await ctx.db.patch(challenge.agentId, {
      xHandle: challenge.xHandle,
      xVerified: true,
      updatedAt: now,
    });

    return { ok: true, agentId: challenge.agentId, xHandle: challenge.xHandle };
  },
});


export const deleteAllButNAgents = mutation({
  args: { keep: v.number() },
  handler: async (ctx, { keep }) => {
    const k = Math.max(0, Math.floor(keep));
    const agents = await ctx.db.query("agents").collect();
    agents.sort((a, b) => b.createdAt - a.createdAt);
    const keepIds = new Set(agents.slice(0, k).map((a) => a._id));

    for (const e of await ctx.db.query("clapEvents").collect()) {
      if (!keepIds.has(e.agentId)) await ctx.db.delete(e._id);
    }

    for (const c of await ctx.db.query("xVerificationChallenges").collect()) {
      if (!keepIds.has(c.agentId)) await ctx.db.delete(c._id);
    }

    let deleted = 0;
    for (const a of agents) {
      if (!keepIds.has(a._id)) {
        await ctx.db.delete(a._id);
        deleted += 1;
      }
    }

    return { ok: true, kept: Math.min(k, agents.length), deleted };
  },
});

export const getTickerEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(100, Math.max(1, args.limit ?? 20));
    const events = await ctx.db.query("clapEvents").withIndex("by_created_at").order("desc").take(limit);
    return await Promise.all(events.map(async (e) => {
      const agent = await ctx.db.get(e.agentId);
      return { ...e, xVerified: Boolean(agent?.xVerified) };
    }));
  },
});

export const deleteAllAgentsAndData = mutation({
  args: { confirmWipe: v.string() },
  handler: async (ctx, args) => {
    if (args.confirmWipe !== "YES_DELETE_EVERYTHING") {
      throw new Error("Must pass confirmWipe: 'YES_DELETE_EVERYTHING' to proceed");
    }

    // Delete all clap events
    const events = await ctx.db.query("clapEvents").collect();
    for (const event of events) {
      await ctx.db.delete(event._id);
    }

    // Delete all verification challenges
    const challenges = await ctx.db.query("xVerificationChallenges").collect();
    for (const challenge of challenges) {
      await ctx.db.delete(challenge._id);
    }

    // Delete all agents
    const agents = await ctx.db.query("agents").collect();
    for (const agent of agents) {
      await ctx.db.delete(agent._id);
    }

    return {
      ok: true,
      deleted: {
        agents: agents.length,
        events: events.length,
        challenges: challenges.length,
      },
    };
  },
});
