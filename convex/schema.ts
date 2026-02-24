import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  agents: defineTable({
    id: v.string(),
    name: v.string(),
    projectName: v.string(),
    workspace: v.string(),
    metroServerUrl: v.string(),
    status: v.union(
      v.literal("done"),
      v.literal("running"),
      v.literal("idle"),
      v.literal("error"),
    ),
    parentId: v.optional(v.string()),
    model: v.string(),
    provider: v.string(),
    createdAt: v.number(),
    lastUpdatedAt: v.number(),
  }),
});
