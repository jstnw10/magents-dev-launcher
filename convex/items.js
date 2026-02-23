import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
export const list = query({
    args: {},
    handler: async (ctx) => {
        return await ctx.db.query("items").collect();
    },
});
export const add = mutation({
    args: { text: v.string() },
    handler: async (ctx, args) => {
        await ctx.db.insert("items", { text: args.text, isCompleted: false });
    },
});
export const toggle = mutation({
    args: { id: v.id("items") },
    handler: async (ctx, args) => {
        const item = await ctx.db.get(args.id);
        if (item === null) {
            throw new Error("Item not found");
        }
        await ctx.db.patch(args.id, { isCompleted: !item.isCompleted });
    },
});
export const remove = mutation({
    args: { id: v.id("items") },
    handler: async (ctx, args) => {
        await ctx.db.delete(args.id);
    },
});
