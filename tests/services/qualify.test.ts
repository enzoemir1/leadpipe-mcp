import { describe, it, expect, beforeEach } from 'vitest';
import { qualifyLeads } from '../../src/services/qualify.js';
import { Storage } from '../../src/services/storage.js';
import type { Lead } from '../../src/models/lead.js';
import { v4 as uuidv4 } from 'uuid';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeStorage(): Storage {
  const dir = mkdtempSync(join(tmpdir(), `leadpipe-qualify-${uuidv4()}-`));
  return new Storage(dir);
}

/** Test helper: add a lead directly to the store without going through ingestLead (which uses default storage). */
async function seed(store: Storage, partial: Partial<Lead> & { email: string }): Promise<Lead> {
  const now = new Date().toISOString();
  const lead: Lead = {
    id: uuidv4(),
    email: partial.email,
    first_name: partial.first_name,
    last_name: partial.last_name,
    full_name: partial.full_name,
    phone: partial.phone,
    job_title: partial.job_title,
    company: partial.company,
    source: partial.source ?? 'api',
    source_detail: partial.source_detail,
    tags: partial.tags ?? [],
    custom_fields: partial.custom_fields ?? {},
    score: null,
    score_breakdown: null,
    status: partial.status ?? 'new',
    created_at: now,
    updated_at: now,
    enriched_at: null,
    scored_at: null,
    exported_at: null,
  };
  return store.addLead(lead);
}

describe('lead_qualify (ICP pre-enrichment filter)', () => {
  let store: Storage;

  beforeEach(() => {
    store = makeStorage();
  });

  it('rejects freemail domains when reject_freemail=true', async () => {
    await seed(store,{ email: 'john@gmail.com', job_title: 'VP Sales' });
    await seed(store,{ email: 'jane@acme.com', job_title: 'VP Sales' });

    const result = await qualifyLeads(
      { criteria: { reject_freemail: true } },
      store,
    );

    expect(result.evaluated).toBe(2);
    expect(result.qualified).toBe(1);
    expect(result.rejected).toBe(1);

    const rejected = result.results.find((r) => r.email === 'john@gmail.com');
    expect(rejected?.qualified).toBe(false);
    expect(rejected?.signals.is_freemail).toBe(true);
    expect(rejected?.reasons.some((r) => r.includes('freemail'))).toBe(true);
  });

  it('requires job title keywords', async () => {
    await seed(store,{ email: 'alice@acme.com', job_title: 'VP of Marketing' });
    await seed(store,{ email: 'bob@acme.com', job_title: 'Junior Analyst' });

    const result = await qualifyLeads(
      { criteria: { required_title_keywords: ['vp', 'director', 'head'] } },
      store,
    );

    expect(result.qualified).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.results.find((r) => r.email === 'alice@acme.com')?.qualified).toBe(true);
    expect(result.results.find((r) => r.email === 'bob@acme.com')?.qualified).toBe(false);
  });

  it('excludes blocked title keywords', async () => {
    await seed(store,{ email: 'a@acme.com', job_title: 'VP of Sales' });
    await seed(store,{ email: 'b@acme.com', job_title: 'VP Intern' });

    const result = await qualifyLeads(
      { criteria: { exclude_title_keywords: ['intern'] } },
      store,
    );

    expect(result.results.find((r) => r.email === 'a@acme.com')?.qualified).toBe(true);
    expect(result.results.find((r) => r.email === 'b@acme.com')?.qualified).toBe(false);
  });

  it('applies domain allowlist', async () => {
    await seed(store,{ email: 'a@stripe.com' });
    await seed(store,{ email: 'b@random.com' });

    const result = await qualifyLeads(
      { criteria: { domain_allowlist: ['stripe.com'] } },
      store,
    );

    expect(result.results.find((r) => r.email === 'a@stripe.com')?.qualified).toBe(true);
    expect(result.results.find((r) => r.email === 'b@random.com')?.qualified).toBe(false);
  });

  it('applies domain blocklist', async () => {
    await seed(store,{ email: 'a@competitor.com' });
    await seed(store,{ email: 'b@acme.com' });

    const result = await qualifyLeads(
      { criteria: { domain_blocklist: ['competitor.com'] } },
      store,
    );

    expect(result.results.find((r) => r.email === 'a@competitor.com')?.qualified).toBe(false);
    expect(result.results.find((r) => r.email === 'b@acme.com')?.qualified).toBe(true);
  });

  it('auto_disqualify updates status in storage', async () => {
    const lead = await seed(store,{ email: 'junk@gmail.com' });

    const result = await qualifyLeads(
      { criteria: { reject_freemail: true }, auto_disqualify: true },
      store,
    );

    expect(result.auto_disqualified).toBe(1);
    const updated = await store.getLeadById(lead.id);
    expect(updated?.status).toBe('disqualified');
    expect(updated?.custom_fields?.disqualification_reason).toBeTruthy();
    expect(updated?.custom_fields?.disqualified_by).toBe('lead_qualify');
  });

  it('combines multiple criteria — all must pass', async () => {
    await seed(store,{ email: 'perfect@acme.com', job_title: 'VP Engineering' });
    await seed(store,{ email: 'freemail@gmail.com', job_title: 'VP Engineering' });
    await seed(store,{ email: 'junior@acme.com', job_title: 'Junior Engineer' });

    const result = await qualifyLeads(
      {
        criteria: {
          reject_freemail: true,
          required_title_keywords: ['vp', 'director'],
        },
      },
      store,
    );

    expect(result.qualified).toBe(1);
    expect(result.rejected).toBe(2);
  });

  it('cost savings estimate reports saved enrichment calls', async () => {
    for (let i = 0; i < 5; i++) {
      await seed(store,{ email: `spam${i}@gmail.com` });
    }
    const result = await qualifyLeads(
      { criteria: { reject_freemail: true } },
      store,
    );
    expect(result.cost_savings_estimate.enrichment_calls_avoided).toBe(5);
    expect(result.cost_savings_estimate.note).toContain('$0.05');
  });

  it('throws if no criteria provided', async () => {
    await expect(qualifyLeads({ criteria: {} }, store)).rejects.toThrow(/criterion/);
  });

  it('throws if lead_id not found', async () => {
    await expect(
      qualifyLeads(
        { lead_ids: ['00000000-0000-0000-0000-000000000000'], criteria: { reject_freemail: true } },
        store,
      ),
    ).rejects.toThrow(/not found/i);
  });
});
