import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { TRPCError } from "@trpc/server";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  /**
   * TEMPLATE: Domain Entity Router
   * Replace with your actual business operations.
   * Pattern: create, list, getById, update, delete
   */
  domainEntity: router({
    create: protectedProcedure
      .input(z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.enum(["active", "inactive", "archived"]).optional(),
        metadata: z.record(z.any()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return await db.createDomainEntity({
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          status: input.status,
          metadata: input.metadata,
        });
      }),

    list: protectedProcedure.query(async ({ ctx }) => {
      return await db.getDomainEntities(ctx.user.id);
    }),

    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const entity = await db.getDomainEntityById(input.id);
        if (!entity || entity.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        return entity;
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["active", "inactive", "archived"]).optional(),
        metadata: z.record(z.any()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const entity = await db.getDomainEntityById(input.id);
        if (!entity || entity.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const updateData: any = {};
        if (input.title !== undefined) updateData.title = input.title;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.status !== undefined) updateData.status = input.status;
        if (input.metadata !== undefined) updateData.metadata = input.metadata;

        return await db.updateDomainEntity(input.id, updateData);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const entity = await db.getDomainEntityById(input.id);
        if (!entity || entity.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        return await db.deleteDomainEntity(input.id);
      }),
  }),
});

export type AppRouter = typeof appRouter;
