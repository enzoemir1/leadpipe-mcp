import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Storage } from '../../src/services/storage.js';
import { enrichLead } from '../../src/services/enrichment.js';
import type { Lead } from '../../src/models/lead.js';

const TEST_DIR = path.join(process.cwd(), 'data-test-enrichment');

function makeLead(email: string, overrides: Partial<Lead> = {}): Lead {
  const now = new Date().toISOString();
  return {
    id: uuidv4(), email, first_name: 'Test', last_name: 'User',
    phone: null, job_title: null, company_name: null, company_domain: null,
    company: null, source: 'manual', tags: [], status: 'new',
    score: null, score_breakdown: null, qualified: false,
    exported_at: null, enriched_at: null, created_at: now, updated_at: now,
    ...overrides,
  } as Lead;
}

describe('Lead Enrichment', () => {
  let store: Storage;

  beforeEach(() => { store = new Storage(TEST_DIR); });
  afterEach(async () => { try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {} });

  it('should enrich lead with known domain', async () => {
    const lead = makeLead('jane@stripe.com');
    await store.addLead(lead);
    const enriched = await enrichLead(lead.id, store);
    expect(enriched.company).not.toBeNull();
    expect(enriched.company?.domain).toBe('stripe.com');
    expect(enriched.status).toBe('enriched');
  });

  it('should handle freemail domains', async () => {
    const lead = makeLead('user@gmail.com');
    await store.addLead(lead);
    const enriched = await enrichLead(lead.id, store);
    // Freemail — no company enrichment but shouldn't crash
    expect(enriched).toBeDefined();
    expect(enriched.id).toBe(lead.id);
  });

  it('should handle unknown domains', async () => {
    const lead = makeLead('test@randomcompany99.com');
    await store.addLead(lead);
    const enriched = await enrichLead(lead.id, store);
    expect(enriched.company).not.toBeNull();
    expect(enriched.company?.domain).toBe('randomcompany99.com');
  });

  it('should throw for non-existent lead', async () => {
    await expect(enrichLead(uuidv4(), store)).rejects.toThrow('not found');
  });

  it('should throw for invalid UUID', async () => {
    await expect(enrichLead('not-a-uuid', store)).rejects.toThrow('Invalid');
  });
});
