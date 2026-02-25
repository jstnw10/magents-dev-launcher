import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
const statusValidator = v.union(v.literal("done"), v.literal("running"), v.literal("idle"), v.literal("error"));
const agentFields = {
    id: v.string(),
    name: v.string(),
    projectName: v.string(),
    workspace: v.string(),
    metroServerUrl: v.string(),
    status: statusValidator,
    parentId: v.optional(v.string()),
    model: v.string(),
    provider: v.string(),
};
const findByAgentId = async (ctx, id) => {
    return await ctx.db
        .query("agents")
        .filter((q) => q.eq(q.field("id"), id))
        .first();
};
export const list = query({
    args: {},
    handler: async (ctx) => {
        const agents = await ctx.db.query("agents").collect();
        return agents.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    },
});
export const get = query({
    args: { id: v.string() },
    handler: async (ctx, args) => {
        return await findByAgentId(ctx, args.id);
    },
});
export const create = mutation({
    args: agentFields,
    handler: async (ctx, args) => {
        const existing = await findByAgentId(ctx, args.id);
        if (existing !== null) {
            throw new Error(`Agent with id '${args.id}' already exists`);
        }
        const now = Date.now();
        return await ctx.db.insert("agents", {
            ...args,
            createdAt: now,
            lastUpdatedAt: now,
        });
    },
});
export const upsert = mutation({
    args: agentFields,
    handler: async (ctx, args) => {
        const now = Date.now();
        const existing = await findByAgentId(ctx, args.id);
        if (existing !== null) {
            await ctx.db.patch(existing._id, {
                ...args,
                lastUpdatedAt: now,
            });
            return existing._id;
        }
        return await ctx.db.insert("agents", {
            ...args,
            createdAt: now,
            lastUpdatedAt: now,
        });
    },
});
export const update = mutation({
    args: {
        id: v.string(),
        name: v.optional(v.string()),
        projectName: v.optional(v.string()),
        workspace: v.optional(v.string()),
        metroServerUrl: v.optional(v.string()),
        status: v.optional(statusValidator),
        parentId: v.optional(v.string()),
        model: v.optional(v.string()),
        provider: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const existing = await findByAgentId(ctx, args.id);
        if (existing === null) {
            throw new Error(`Agent with id '${args.id}' not found`);
        }
        const patch = {
            lastUpdatedAt: Date.now(),
        };
        if (args.name !== undefined)
            patch.name = args.name;
        if (args.projectName !== undefined)
            patch.projectName = args.projectName;
        if (args.workspace !== undefined)
            patch.workspace = args.workspace;
        if (args.metroServerUrl !== undefined)
            patch.metroServerUrl = args.metroServerUrl;
        if (args.status !== undefined)
            patch.status = args.status;
        if (args.parentId !== undefined)
            patch.parentId = args.parentId;
        if (args.model !== undefined)
            patch.model = args.model;
        if (args.provider !== undefined)
            patch.provider = args.provider;
        await ctx.db.patch(existing._id, patch);
        return existing._id;
    },
});
export const toggle = mutation({
    args: {
        id: v.string(),
    },
    handler: async (ctx, args) => {
        const existing = await findByAgentId(ctx, args.id);
        if (existing === null) {
            throw new Error(`Agent with id '${args.id}' not found`);
        }
        const nextStatus = existing.status === "done" ? "idle" : "done";
        await ctx.db.patch(existing._id, {
            status: nextStatus,
            lastUpdatedAt: Date.now(),
        });
        return existing._id;
    },
});
export const setStatus = mutation({
    args: {
        id: v.string(),
        status: statusValidator,
    },
    handler: async (ctx, args) => {
        const existing = await findByAgentId(ctx, args.id);
        if (existing === null) {
            throw new Error(`Agent with id '${args.id}' not found`);
        }
        await ctx.db.patch(existing._id, {
            status: args.status,
            lastUpdatedAt: Date.now(),
        });
        return existing._id;
    },
});
export const remove = mutation({
    args: {
        id: v.string(),
    },
    handler: async (ctx, args) => {
        const existing = await findByAgentId(ctx, args.id);
        if (existing === null) {
            return false;
        }
        await ctx.db.delete(existing._id);
        return true;
    },
});
