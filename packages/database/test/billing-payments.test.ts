import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Db,
  createActiveEnrollment,
  createUser,
  makeTrainer,
  type ActiveEnrollmentFixture,
} from "./helpers.js";

const db = new Db();
let client: string;
let trainer: string;
let fixture: ActiveEnrollmentFixture;

const PERIOD_START = "2026-07-01T00:00:00Z";
const PERIOD_END = "2026-08-01T00:00:00Z";

beforeAll(async () => {
  client = await createUser(db, "bill-client");
  trainer = await createUser(db, "bill-trainer");
  await makeTrainer(db, trainer);
  fixture = await createActiveEnrollment(db, trainer, client);
});

afterAll(async () => {
  await db.close();
});

function insertLedgerRow(idempotencySuffix: string) {
  return db.admin(
    `insert into public.active_client_billing_ledger
       (trainer_id, client_id, enrollment_id, trainer_billing_period_start,
        trainer_billing_period_end, amount_cents, currency, idempotency_key)
     values ($1, $2, $3, $4, $5, 250, 'usd', $6)
     returning id`,
    [trainer, client, fixture.enrollmentId, PERIOD_START, PERIOD_END, `k-${idempotencySuffix}`],
  );
}

describe("critical test 8: one enrollment billed once per trainer billing period", () => {
  it("accepts the first charge and rejects a duplicate for the same period", async () => {
    await insertLedgerRow("first");
    await expect(insertLedgerRow("second")).rejects.toThrow(/acbl_once_per_period|duplicate key/);
  });

  it("allows the same enrollment in the NEXT billing period", async () => {
    const res = await db.admin(
      `insert into public.active_client_billing_ledger
         (trainer_id, client_id, enrollment_id, trainer_billing_period_start,
          trainer_billing_period_end, amount_cents, currency, idempotency_key)
       values ($1, $2, $3, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 250, 'usd', 'k-august')
       returning id`,
      [trainer, client, fixture.enrollmentId],
    );
    expect(res.rows).toHaveLength(1);
  });
});

describe("billing ledger immutability", () => {
  it("forbids DELETE even for the service path", async () => {
    await expect(
      db.admin(`delete from public.active_client_billing_ledger where trainer_id = $1`, [trainer]),
    ).rejects.toThrow(/append-only/);
  });

  it("forbids changing amount/identity columns", async () => {
    await expect(
      db.admin(
        `update public.active_client_billing_ledger set amount_cents = 1 where trainer_id = $1`,
        [trainer],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("allows only valid status transitions", async () => {
    await db.admin(
      `update public.active_client_billing_ledger set status = 'invoiced',
              stripe_invoice_item_id = 'ii_test_1'
       where trainer_id = $1 and idempotency_key = 'k-first'`,
      [trainer],
    );
    await expect(
      db.admin(
        `update public.active_client_billing_ledger set status = 'pending'
         where trainer_id = $1 and idempotency_key = 'k-first'`,
        [trainer],
      ),
    ).rejects.toThrow(/invalid billing ledger status transition/);
  });

  it("payment_ledger rows are fully immutable", async () => {
    await db.admin(
      `insert into public.payment_ledger
         (entry_group_id, account, direction, amount_cents, currency, trainer_id, client_id,
          description, idempotency_key)
       values (gen_random_uuid(), 'client_payment', 'credit', 25000, 'usd', $1, $2,
               'test entry', 'pl-key-1')`,
      [trainer, client],
    );
    await expect(
      db.admin(
        `update public.payment_ledger set amount_cents = 1 where idempotency_key = 'pl-key-1'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin(`delete from public.payment_ledger where idempotency_key = 'pl-key-1'`),
    ).rejects.toThrow(/immutable/);
  });
});

describe("critical test 7: duplicate webhook events are deduplicated", () => {
  it("second insert of the same provider event id fails", async () => {
    await db.admin(
      `insert into public.webhook_events (provider, event_id, event_type, payload)
       values ('stripe', 'evt_duplicate_test', 'checkout.session.completed', '{}')`,
    );
    await expect(
      db.admin(
        `insert into public.webhook_events (provider, event_id, event_type, payload)
         values ('stripe', 'evt_duplicate_test', 'checkout.session.completed', '{}')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("critical test 6: clients cannot fabricate payment state", () => {
  it("client cannot update their order to paid (privilege revoked)", async () => {
    await expect(
      db.as(client, (q) => q(`update orders set status = 'paid' where id = $1`, [fixture.orderId])),
    ).rejects.toThrow(/permission denied/);
  });

  it("client cannot insert orders, payments, enrollments or entitlements", async () => {
    await expect(
      db.as(client, (q) =>
        q(
          `insert into entitlements (enrollment_id, client_id, trainer_id, type)
           values ($1, $2, $3, 'program_content')`,
          [fixture.enrollmentId, client, trainer],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.as(client, (q) =>
        q(
          `insert into enrollments (client_id, trainer_id, program_id, purchase_snapshot_id, status)
           values ($1, $2, $3, $4, 'active')`,
          [client, trainer, fixture.programId, fixture.snapshotId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("client cannot write the billing ledger or webhook tables at all", async () => {
    await expect(db.as(client, (q) => q(`select * from webhook_events`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.as(client, (q) =>
        q(
          `insert into active_client_billing_ledger
             (trainer_id, client_id, enrollment_id, trainer_billing_period_start,
              trainer_billing_period_end, amount_cents, currency, idempotency_key)
           values ($1, $2, $3, now(), now() + interval '1 month', 0, 'usd', 'evil')`,
          [trainer, client, fixture.enrollmentId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("state machines at the database level", () => {
  it("rejects invalid enrollment transitions", async () => {
    await expect(
      db.admin(`update public.enrollments set status = 'pending_payment' where id = $1`, [
        fixture.enrollmentId,
      ]),
    ).rejects.toThrow(/invalid enrollment status transition/);
  });

  it("rejects invalid order transitions (paid -> awaiting_payment)", async () => {
    await expect(
      db.admin(`update public.orders set status = 'awaiting_payment' where id = $1`, [
        fixture.orderId,
      ]),
    ).rejects.toThrow(/invalid order status transition/);
  });

  it("records enrollment status history automatically", async () => {
    const res = await db.admin(
      `select from_status, to_status from public.enrollment_status_history
       where enrollment_id = $1 order by created_at`,
      [fixture.enrollmentId],
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(2);
    expect(res.rows[0].to_status).toBe("pending_payment");
    expect(res.rows.at(-1)!.to_status).toBe("active");
  });
});

describe("program snapshots are immutable (purchases survive edits)", () => {
  it("program_purchase_snapshots reject updates", async () => {
    await expect(
      db.admin(`update public.program_purchase_snapshots set price_cents = 1 where id = $1`, [
        fixture.snapshotId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it("editing a program does not change the purchased snapshot", async () => {
    await db.admin(`update public.programs set price_cents = 99999 where id = $1`, [
      fixture.programId,
    ]);
    const snap = await db.admin(
      `select price_cents from public.program_purchase_snapshots where id = $1`,
      [fixture.snapshotId],
    );
    expect(snap.rows[0].price_cents).toBe(25000);
  });
});

describe("program lifecycle (owner path used by /trainer/programs)", () => {
  it("owner drafts, publishes (snapshot v1), edits with version bump (snapshot v2)", async () => {
    const owner = await createUser(db, "program-owner");
    await makeTrainer(db, owner);
    const created = await db.asCommitted(owner, (q) =>
      q(
        `insert into programs
           (trainer_id, slug, title, price_cents, currency, duration_value, duration_unit)
         values ($1, 'owner-prog', 'Owner program', 19900, 'usd', 8, 'week')
         returning id, status, version`,
        [owner],
      ),
    );
    const programId = created.rows[0].id as string;
    expect(created.rows[0].status).toBe("draft");

    // Drafts are invisible to the public.
    const anonBefore = await db.asAnon((q) =>
      q(`select id from programs where id = $1`, [programId]),
    );
    expect(anonBefore.rows).toHaveLength(0);

    await db.asCommitted(owner, (q) =>
      q(`update programs set status = 'published' where id = $1`, [programId]),
    );
    const v1 = await db.admin(
      `select version, snapshot->>'price_cents' as price from program_versions
       where program_id = $1 order by version`,
      [programId],
    );
    expect(v1.rows).toEqual([{ version: 1, price: "19900" }]);

    // Editing the live program bumps the version and snapshots again.
    await db.asCommitted(owner, (q) =>
      q(`update programs set price_cents = 24900, version = version + 1 where id = $1`, [
        programId,
      ]),
    );
    const v2 = await db.admin(
      `select version, snapshot->>'price_cents' as price from program_versions
       where program_id = $1 order by version`,
      [programId],
    );
    expect(v2.rows).toEqual([
      { version: 1, price: "19900" },
      { version: 2, price: "24900" },
    ]);

    // Owners cannot skip the state machine (draft -> archived is invalid
    // for a fresh program; published -> draft is invalid here).
    await expect(
      db.as(owner, (q) => q(`update programs set status = 'draft' where id = $1`, [programId])),
    ).rejects.toThrow(/invalid program status transition/);
  });
});
