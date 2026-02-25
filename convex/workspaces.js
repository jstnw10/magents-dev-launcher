import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
const statusValidator = v.union(v.literal("active"), v.literal("archived"));
const workspaceFields = {
    id: v.string(),
    title: v.string(),
    branch: v.string(),
    baseRef: v.string(),
    baseCommitSha: v.string(),
    status: statusValidator,
    repositoryPath: v.string(),
    repositoryOwner: v.optional(v.string()),
    repositoryName: v.optional(v.string()),
    worktreePath: v.string(),
    path: v.string(),
    tunnelUrl: v.optional(v.string()),
    metroPort: v.optional(v.number()),
    sessionId: v.optional(v.string()),
    tags: v.array(v.string()),
    archived: v.optional(v.boolean()),
    archivedAt: v.optional(v.string()),
    packageManager: v.optional(v.string()),
};
const findByWorkspaceId = async (ctx, id) => {
    return await ctx.db
        .query("workspaces")
        .withIndex("by_workspace_id", (q) => q.eq("id", id))
        .first();
};
export const list = query({
    args: {},
    handler: async (ctx) => {
        const workspaces = await ctx.db.query("workspaces").collect();
        return workspaces.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    },
});
export const listActive = query({
    args: {},
    handler: async (ctx) => {
        const workspaces = await ctx.db.query("workspaces").collect();
        return workspaces
            .filter((w) => w.status === "active")
            .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    },
});
export const get = query({
    args: { id: v.string() },
    handler: async (ctx, args) => {
        return await findByWorkspaceId(ctx, args.id);
    },
});
export const upsert = mutation({
    args: workspaceFields,
    handler: async (ctx, args) => {
        const now = Date.now();
        const existing = await findByWorkspaceId(ctx, args.id);
        if (existing !== null) {
            await ctx.db.patch(existing._id, {
                ...args,
                lastUpdatedAt: now,
            });
            return existing._id;
        }
        return await ctx.db.insert("workspaces", {
            ...args,
            createdAt: now,
            lastUpdatedAt: now,
        });
    },
});
export const updateStatus = mutation({
    args: {
        id: v.string(),
        status: statusValidator,
    },
    handler: async (ctx, args) => {
        const existing = await findByWorkspaceId(ctx, args.id);
        if (existing === null) {
            throw new Error(`Workspace with id '${args.id}' not found`);
        }
        const patch = {
            status: args.status,
            lastUpdatedAt: Date.now(),
        };
        if (args.status === "archived") {
            patch.archived = true;
            patch.archivedAt = new Date().toISOString();
        }
        await ctx.db.patch(existing._id, patch);
        return existing._id;
    },
});
export const updateTunnel = mutation({
    args: {
        id: v.string(),
        tunnelUrl: v.optional(v.string()),
        metroPort: v.optional(v.number()),
        sessionId: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const existing = await findByWorkspaceId(ctx, args.id);
        if (existing === null) {
            throw new Error(`Workspace with id '${args.id}' not found`);
        }
        const patch = {
            lastUpdatedAt: Date.now(),
        };
        if (args.tunnelUrl !== undefined)
            patch.tunnelUrl = args.tunnelUrl;
        if (args.metroPort !== undefined)
            patch.metroPort = args.metroPort;
        if (args.sessionId !== undefined)
            patch.sessionId = args.sessionId;
        await ctx.db.patch(existing._id, patch);
        return existing._id;
    },
});
export const remove = mutation({
    args: {
        id: v.string(),
    },
    handler: async (ctx, args) => {
        const existing = await findByWorkspaceId(ctx, args.id);
        if (existing === null) {
            return false;
        }
        await ctx.db.delete(existing._id);
        return true;
    },
});
