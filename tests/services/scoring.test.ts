import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../../src/services/storage.js';
import { scoreLead } from '../../src/services/scoring-engine.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { Lead } from '../../src/models/lead.js';

// We need to mock storage to use a test directory
// For simplicity, we'll test the scoring logic through the full flow
const TEST_DIR = path.join(process.cwd(), 'data-test-scoring');

function makeLead(overrides: Partial<Lead> = {}): Lead {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    email: `test-${Date.now()}-${Math.random()}@example.com`,
    first_name: 'Test',
    last_name: 'User',
    full_name: 'Test User',
    job_title: 'Software Engineer',
    company: {
      name: 'Acme Corp',
      domain: 'acme.com',
      industry: 'technology',
      size: '51-200',
    },
    source: 'website_form',
    tags: ['demo-request'],
    custom_fields: {},
    score: null,
    score_breakdown: null,
    status: 'enriched',
    created_at: now,
    updated_at: now,
    enriched_at: now,
    scored_at: null,
    exported_at: null,
    ...overrides,
  };
}

describe('Scoring Engine', () => {
  let store: Storage;

  beforeEach(async () => {
    // The scoring engine uses the singleton storage, so we work with the default data dir
    // For proper isolation we'd need dependency injection, but this tests the real flow
    store = new Storage();
  });

  afterEach(async () => {
    try {
      await fs.rm(path.join(process.cwd(), 'data'), { recursive: true, force: true });
    } catch {}
  });

  it('should score a CEO higher than an intern', async () => {
    const ceoLead = makeLead({ job_title: 'CEO', email: 'ceo@test.com' });
    const internLead = makeLead({ job_title: 'Intern', email: 'intern@test.com' });

    await store.addLead(ceoLead);
    await store.addLead(internLead);

    const scoredCeo = await scoreLead(ceoLead.id);
    const scoredIntern = await scoreLead(internLead.id);

    expect(scoredCeo.score).toBeGreaterThan(scoredIntern.score!);
    expect(scoredCeo.score_breakdown).not.toBeNull();
    expect(scoredCeo.score_breakdown!.job_title_score).toBe(100);
    expect(scoredIntern.score_breakdown!.job_title_score).toBe(15);
  });

  it('should qualify leads with score >= 60', async () => {
    const lead = makeLead({
      job_title: 'VP of Engineering',
      email: 'vp@saas.com',
      company: { name: 'SaaS Co', industry: 'saas', size: '51-200' },
    });
    await store.addLead(lead);

    const scored = await scoreLead(lead.id);
    expect(scored.score).toBeGreaterThanOrEqual(60);
    expect(scored.status).toBe('qualified');
  });

  it('should disqualify leads with score < 60', async () => {
    const lead = makeLead({
      job_title: 'Student',
      email: 'student@university.edu',
      company: undefined,
      source: 'csv_import',
      tags: [],
      created_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(), // 120 days ago
    });
    await store.addLead(lead);

    const scored = await scoreLead(lead.id);
    expect(scored.score).toBeLessThan(60);
    expect(scored.status).toBe('disqualified');
  });

  it('should include detailed breakdown', async () => {
    const lead = makeLead({ email: 'detail@test.com' });
    await store.addLead(lead);

    const scored = await scoreLead(lead.id);
    expect(scored.score_breakdown).not.toBeNull();
    expect(scored.score_breakdown!.details.length).toBeGreaterThan(0);
    expect(scored.score_breakdown!.total).toBe(scored.score);
  });
});
