import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../../src/services/storage.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { Lead } from '../../src/models/lead.js';

const TEST_DIR = path.join(process.cwd(), 'data-test');

function makeLead(overrides: Partial<Lead> = {}): Lead {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    first_name: 'Test',
    last_name: 'User',
    full_name: 'Test User',
    job_title: 'CEO',
    source: 'api',
    tags: [],
    custom_fields: {},
    score: null,
    score_breakdown: null,
    status: 'new',
    created_at: now,
    updated_at: now,
    enriched_at: null,
    scored_at: null,
    exported_at: null,
    ...overrides,
  };
}

describe('Storage', () => {
  let store: Storage;

  beforeEach(async () => {
    store = new Storage(TEST_DIR);
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('should add and retrieve a lead', async () => {
    const lead = makeLead({ email: 'john@acme.com' });
    await store.addLead(lead);
    const found = await store.getLeadById(lead.id);
    expect(found).not.toBeNull();
    expect(found!.email).toBe('john@acme.com');
  });

  it('should find lead by email (case-insensitive)', async () => {
    const lead = makeLead({ email: 'Jane@Corp.com' });
    await store.addLead(lead);
    const found = await store.getLeadByEmail('jane@corp.com');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(lead.id);
  });

  it('should update a lead', async () => {
    const lead = makeLead();
    await store.addLead(lead);
    const updated = await store.updateLead(lead.id, { score: 75, status: 'qualified' });
    expect(updated).not.toBeNull();
    expect(updated!.score).toBe(75);
    expect(updated!.status).toBe('qualified');
  });

  it('should delete a lead', async () => {
    const lead = makeLead();
    await store.addLead(lead);
    const deleted = await store.deleteLead(lead.id);
    expect(deleted).toBe(true);
    const found = await store.getLeadById(lead.id);
    expect(found).toBeNull();
  });

  it('should search leads by query', async () => {
    await store.addLead(makeLead({ email: 'alice@startup.io', first_name: 'Alice' }));
    await store.addLead(makeLead({ email: 'bob@bigcorp.com', first_name: 'Bob' }));
    const result = await store.searchLeads({ query: 'alice' });
    expect(result.total).toBe(1);
    expect(result.leads[0].first_name).toBe('Alice');
  });

  it('should search leads by status', async () => {
    await store.addLead(makeLead({ status: 'qualified' }));
    await store.addLead(makeLead({ status: 'new' }));
    await store.addLead(makeLead({ status: 'qualified' }));
    const result = await store.searchLeads({ status: 'qualified' });
    expect(result.total).toBe(2);
  });

  it('should paginate search results', async () => {
    for (let i = 0; i < 10; i++) {
      await store.addLead(makeLead());
    }
    const page1 = await store.searchLeads({ limit: 3, offset: 0 });
    expect(page1.leads.length).toBe(3);
    expect(page1.total).toBe(10);
  });

  it('should compute pipeline stats', async () => {
    await store.addLead(makeLead({ status: 'new', source: 'api' }));
    await store.addLead(makeLead({ status: 'qualified', source: 'webhook', score: 80 }));
    await store.addLead(makeLead({ status: 'qualified', source: 'api', score: 60 }));
    const stats = await store.getStats();
    expect(stats.total_leads).toBe(3);
    expect(stats.by_status['qualified']).toBe(2);
    expect(stats.avg_score).toBe(70);
  });

  it('should manage scoring config', async () => {
    const config = await store.getScoringConfig();
    expect(config.job_title_weight).toBe(0.25);
    const updated = await store.updateScoringConfig({ job_title_weight: 0.4 });
    expect(updated.job_title_weight).toBe(0.4);
  });
});
