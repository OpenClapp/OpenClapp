import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  agents: defineTable({
    publicId: v.optional(v.string()),
    name: v.string(),
    xHandle: v.optional(v.string()),
    xVerified: v.boolean(),
    isClapping: v.boolean(),
    cumulativeClapMs: v.number(),
    lastStateChangedAt: v.number(),
    lastHeartbeatAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_created_at", ["createdAt"])
    .index("by_x_verified", ["xVerified"])
    .index("by_public_id", ["publicId"]),

  clapEvents: defineTable({
    agentId: v.id("agents"),
    agentName: v.string(),
    type: v.union(v.literal("started"), v.literal("stopped")),
    createdAt: v.number(),
  }).index("by_created_at", ["createdAt"]),

  xVerificationChallenges: defineTable({
    agentId: v.id("agents"),
    xHandle: v.string(),
    challengeText: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    completedAt: v.optional(v.number()),
    matchedPostUrl: v.optional(v.string()),
  })
    .index("by_agent", ["agentId"])
    .index("by_x_handle", ["xHandle"]),
});
