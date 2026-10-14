/**
 * Route-catalog pool failover for account-less providers.
 *
 * `opencodeft` (OpenCode Free) is the deployment's one account-less,
 * `ipScopedRateLimit` provider: it has no credential, the upstream counts
 * requests per egress address, and the gateway gives it a pool group so each
 * request leaves from a different residential IP. Its rate limit is therefore a
 * property of the *pool*, not of an account — a 429 means "this egress address
 * is done", and the next attempt must leave by a different one.
 *
 * The bug this suite pins: the account-less branch emitted exactly one pooled
 * candidate (all N pool ids on a single candidate) plus one "global fallback"
 * candidate whose `tenant_id` is the provider's own `NULL` tenant, so it
 * resolved no pools at all and dispatched from the gateway's own address — the
 * one the upstream had just refused. Dispatch picks a *single* pool inside a
 * candidate's pool set (`tryAcquireAvailablePool`), so one pooled candidate
 * meant one pooled attempt, followed by a hopeless direct one: a pool 429 was
 * effectively unretryable.
 *
 * The contract asserted here is the one the attempt loop consumes: the builder
 * must emit the pooled candidate once per usable attempt (bounded by
 * `CARTETHYIA_ROUTE_MAX_ATTEMPTS`) so the loop has pooled candidates to walk,
 * and the direct fallback must stay LAST so it remains the final resort instead
 * of the second attempt.
 *
 * Everything runs against the real `createDatabaseSnapshotBuilder`, so the SQL,
 * the pool-tenant fan-out, and the `requires_account` projection are all the
 * deployed ones.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/postgres";
import { createDatabaseSnapshotBuilder } from "../../src/transport/routing/route-catalog";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";
import { dbDescribe, getTestPool } from "../helpers/database";
import {
  createModel,
  createProvider,
  createWorld,
  type GatewayWorld,
} from "../helpers/fixtures";

/** Runs `body` with `CARTETHYIA_ROUTE_MAX_ATTEMPTS` pinned, then restores it. */
async function withMaxAttempts<T>(value: number, body: () => Promise<T>): Promise<T> {
  const previous = process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS;
  process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS = String(value);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS;
    else process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS = previous;
  }
}

dbDescribe("route catalog: account-less providers fan out across pools", () => {
  let world: GatewayWorld;
  /** Global (tenant-less) provider with `requires_account = false`, no accounts. */
  let freeProviderId: string;
  let freeModelId: string;

  beforeAll(async () => {
    world = await createWorld();
    const pool = await getTestPool();
    const client = await pool.connect();
    try {
      // `requiresAccount: false` is the OpenCode Free shape: the provider is
      // routable with zero `provider_accounts` rows. Tenant-less, because every
      // built-in provider row is `tenant_id IS NULL`.
      freeProviderId = await createProvider(client, world.runId, {
        suffix: "free",
        requiresAccount: false,
      });
      freeModelId = `free-${world.runId}`;
      await createModel(client, freeProviderId, freeModelId);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const pool = await getTestPool();
    const client = await pool.connect();
    try {
      // A tenant-less provider does not cascade from the tenant delete, so it
      // (and, through `on delete cascade`, its models) is removed explicitly.
      await client.query("delete from providers where id = $1", [freeProviderId]);
    } finally {
      client.release();
    }
    await world?.cleanup();
  });

  /**
   * Inserts `count` active pools owned by the world's tenant, runs `body`, and
   * removes them again. Per-test ownership is what lets a suite assert an exact
   * candidate count without depending on every other suite's pool rows.
   */
  async function withPools<T>(count: number, body: (ids: readonly string[]) => Promise<T>): Promise<T> {
    const pool = await getTestPool();
    const client = await pool.connect();
    const ids: string[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        const id = crypto.randomUUID();
        await client.query(
          `insert into network_pools
             (id, tenant_id, kind, endpoint_config, status, consecutive_failures, weight, max_inflight, created_at)
           values ($1, $2, 'http', $3::jsonb, 'active', 0, 100, 10, now())`,
          [id, world.tenantId, JSON.stringify({ url: "http://127.0.0.1:1" })],
        );
        ids.push(id);
      }
    } finally {
      client.release();
    }
    try {
      return await body(ids);
    } finally {
      const cleanup = await getTestPool();
      await cleanup.query("delete from network_pools where id = any($1::uuid[])", [ids]);
    }
  }

  /** The real snapshot builder's candidates for one provider/model. */
  async function candidatesFor(
    providerId: string,
    modelId: string,
  ): Promise<readonly RouteCandidate[]> {
    const snapshot = await createDatabaseSnapshotBuilder(getDb())();
    return snapshot.candidates.filter(
      (candidate) => candidate.provider_id === providerId && candidate.model_id === modelId,
    );
  }

  /** Candidates the requesting tenant would actually be routed to. */
  function forTenant(
    candidates: readonly RouteCandidate[],
    tenantId: string | null,
  ): readonly RouteCandidate[] {
    return candidates.filter((candidate) => candidate.tenant_id === tenantId);
  }

  test("emits one pooled candidate per usable attempt and keeps the direct fallback last", async () => {
    await withPools(3, async (ids) => {
      await withMaxAttempts(4, async () => {
        const candidates = await candidatesFor(freeProviderId, freeModelId);
        const pooled = forTenant(candidates, world.tenantId);
        const fallback = forTenant(candidates, null);

        // min(3 pools, maxAttempts - 1) = 3 pooled attempts.
        expect(pooled).toHaveLength(3);
        for (const candidate of pooled) {
          expect(candidate.network_pool_ids).toEqual(ids);
          expect(candidate.network_pool_required).toBe(true);
          expect(candidate.requires_account).toBe(false);
        }

        // Exactly one direct fallback, with no pool set: it dispatches from the
        // gateway's own address and is the final resort.
        expect(fallback).toHaveLength(1);
        expect(fallback[0]?.network_pool_ids).toBeUndefined();
        expect(fallback[0]?.requires_account).toBe(false);

        // ...and it is LAST, not the second attempt.
        expect(candidates.at(-1)?.tenant_id).toBeNull();
      });
    });
  });

  test("a single pool is not duplicated — repeating it buys nothing", async () => {
    await withPools(1, async (ids) => {
      await withMaxAttempts(8, async () => {
        const candidates = await candidatesFor(freeProviderId, freeModelId);
        const pooled = forTenant(candidates, world.tenantId);
        expect(pooled).toHaveLength(1);
        expect(pooled[0]?.network_pool_ids).toEqual(ids);
      });
    });
  });

  test("the pooled fan-out is capped at maxAttempts - 1", async () => {
    await withPools(20, async (ids) => {
      await withMaxAttempts(8, async () => {
        const candidates = await candidatesFor(freeProviderId, freeModelId);
        const pooled = forTenant(candidates, world.tenantId);
        // min(20 pools, 8 - 1) = 7, so the fallback still fits inside the cap.
        expect(pooled).toHaveLength(7);
        expect(pooled[0]?.network_pool_ids).toHaveLength(ids.length);
        expect(forTenant(candidates, null)).toHaveLength(1);
        expect(candidates.at(-1)?.tenant_id).toBeNull();
      });
    });
  });

  test("an account-backed provider is untouched: one candidate, no pool fan-out", async () => {
    await withPools(5, async () => {
      await withMaxAttempts(8, async () => {
        // `world`'s own provider requires an account and owns one, so it takes
        // the `accounts.length > 0` path. The fix must not change it: exactly
        // one candidate, and no pool-tenant fan-out even though the tenant owns
        // pools.
        const candidates = await candidatesFor(world.providerId, world.modelId);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.provider_account_id).toBe(world.accountId);
        expect(candidates[0]?.network_pool_ids).toBeUndefined();
      });
    });
  });

  test("plan() keeps the pooled group ahead of the direct fallback", async () => {
    await withPools(3, async () => {
      await withMaxAttempts(4, async () => {
        const built = await createDatabaseSnapshotBuilder(getDb())();
        // `plan()` reads a revision and timestamp the raw builder result leaves
        // to the snapshot service; stamping them here keeps the call on the real
        // path.
        const snapshot: RouteSnapshot = {
          ...built,
          revision: 1,
          created_at: built.created_at ?? Date.now(),
        };
        const plan = await new RoutingEngine().plan(
          `${freeProviderId}/${freeModelId}`,
          snapshot,
          world.tenantId,
        );
        const reached = plan.candidates.filter(
          (candidate) =>
            candidate.provider_id === freeProviderId && candidate.model_id === freeModelId,
        );
        // Provider rotation (`reorderRun`) must not float the direct fallback to
        // the front: that is the exact address the upstream refused.
        expect(reached).toHaveLength(4);
        expect(reached.at(-1)?.tenant_id).toBeNull();
        expect(reached.slice(0, 3).every((candidate) => candidate.tenant_id === world.tenantId)).toBe(
          true,
        );
      });
    });
  });
});
