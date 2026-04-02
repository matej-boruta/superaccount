-- ============================================================
-- SuperAccount DB Schema v2.0
-- 2026-04-02
--
-- Struktura:
--   1. Workflow vrstva:    cases, case_events, agent_tasks
--   2. Dokumentová vrstva: documents, document_coverage_checks
--   3. Účetní rozhodování: proposals, reviews, approvals
--   4. Control Tower:      agent_kpis, agent_kpi_measurements, system_reviews, system_findings
--   5. Knowledge base:     manual_documents, manual_versions, manual_sections, manual_rules, manual_render_snapshots
--   6. Agent runs:         agent_runs
-- ============================================================

-- ── 1. WORKFLOW VRSTVA ────────────────────────────────────────────────────────

create table if not exists cases (
  id                  uuid primary key default gen_random_uuid(),
  case_type           text not null check (case_type in ('invoice', 'transaction', 'invoice_transaction_match', 'contract', 'other')),
  status              text not null default 'NEW' check (status in (
                        'NEW', 'DATA_READY', 'NEEDS_INFO', 'ACCOUNTING_PROPOSED',
                        'AUDIT_CHECKED', 'READY_FOR_APPROVAL', 'APPROVED', 'POSTED',
                        'MISSING_DOCUMENT', 'UNMATCHED_TRANSACTION', 'BLOCKED', 'REJECTED', 'ERROR'
                      )),
  priority            text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  assigned_role       text check (assigned_role in ('pm', 'accountant', 'auditor', 'architect', 'user', 'system')),
  source_confidence   numeric(5,2) check (source_confidence between 0 and 100),
  risk_score          numeric(5,2) check (risk_score between 0 and 100),
  -- vazby na existující tabulky (nullable — postupná migrace)
  faktura_id          integer references faktury(id) on delete set null,
  transakce_id        integer references transakce(id) on delete set null,
  company_id          uuid null,
  due_at              timestamptz null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  closed_at           timestamptz null
);

create index if not exists cases_status_idx       on cases(status);
create index if not exists cases_assigned_role_idx on cases(assigned_role);
create index if not exists cases_faktura_id_idx   on cases(faktura_id);
create index if not exists cases_transakce_id_idx on cases(transakce_id);
create index if not exists cases_due_at_idx       on cases(due_at) where due_at is not null;

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists case_events (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references cases(id) on delete cascade,
  event_type  text not null check (event_type in (
                'created', 'ingestion_checked', 'document_found', 'document_missing',
                'proposal_created', 'audit_passed', 'audit_failed', 'escalated',
                'approved', 'rejected', 'posted', 'double_check_started',
                'transaction_matched', 'transaction_unmatched', 'status_changed', 'comment'
              )),
  actor_type  text not null check (actor_type in ('system', 'pm', 'accountant', 'auditor', 'architect', 'user')),
  actor_id    text null,
  payload     jsonb null,
  created_at  timestamptz not null default now()
);

create index if not exists case_events_case_id_idx   on case_events(case_id);
create index if not exists case_events_event_type_idx on case_events(event_type);
create index if not exists case_events_created_at_idx on case_events(created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists agent_tasks (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid null references cases(id) on delete set null,
  task_type       text not null check (task_type in (
                    'missing_document', 'ingestion_check', 'source_verification',
                    'classification', 'audit_review', 'schema_review',
                    'unmatched_transaction', 'double_check', 'learning_update'
                  )),
  owner_role      text not null check (owner_role in ('pm', 'accountant', 'auditor', 'architect', 'user', 'system')),
  priority        text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  execution_mode  text not null default 'auto' check (execution_mode in ('auto', 'semi', 'manual')),
  status          text not null default 'scheduled' check (status in (
                    'scheduled', 'running', 'completed', 'blocked', 'waiting_approval', 'failed'
                  )),
  title           text not null,
  description     text null,
  created_from    text check (created_from in ('control_tower', 'orchestrator', 'pm', 'manual', 'rule')),
  created_at      timestamptz not null default now(),
  started_at      timestamptz null,
  completed_at    timestamptz null
);

create index if not exists agent_tasks_status_idx     on agent_tasks(status) where status in ('scheduled', 'running', 'blocked');
create index if not exists agent_tasks_owner_role_idx on agent_tasks(owner_role);
create index if not exists agent_tasks_case_id_idx    on agent_tasks(case_id);

-- ── 2. DOKUMENTOVÁ VRSTVA ─────────────────────────────────────────────────────

create table if not exists documents (
  id                uuid primary key default gen_random_uuid(),
  document_type     text not null check (document_type in (
                      'invoice_in', 'invoice_out', 'contract', 'credit_note', 'receipt', 'other'
                    )),
  source_system     text not null check (source_system in ('gmail', 'drive', 'api', 'upload', 'abra')),
  source_ref        text null,   -- gdrive_file_id, gmail_message_id, apod.
  file_name         text not null,
  mime_type         text null,
  file_url          text null,
  checksum          text null,
  supplier_id       uuid null,
  issue_date        date null,
  due_date          date null,
  total_amount      numeric(18,2) null,
  currency          text null default 'CZK',
  variable_symbol   text null,
  extracted_data    jsonb null,
  extraction_status text not null default 'pending' check (extraction_status in ('pending', 'parsed', 'failed', 'reviewed')),
  -- vazba na faktury (nullable pro postupnou migraci)
  faktura_id        integer null references faktury(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists documents_source_ref_idx        on documents(source_ref) where source_ref is not null;
create index if not exists documents_extraction_status_idx on documents(extraction_status);
create index if not exists documents_faktura_id_idx        on documents(faktura_id);
create unique index if not exists documents_source_dedup_idx on documents(source_system, source_ref) where source_ref is not null;

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists document_coverage_checks (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references cases(id) on delete cascade,
  check_type  text not null check (check_type in (
                'source_presence', 'duplicate_check', 'transaction_match_check', 'contract_check'
              )),
  status      text not null check (status in ('ok', 'warning', 'fail')),
  result_json jsonb null,
  checked_at  timestamptz not null default now()
);

create index if not exists doc_coverage_case_id_idx on document_coverage_checks(case_id);
create index if not exists doc_coverage_status_idx  on document_coverage_checks(status) where status in ('warning', 'fail');

-- ── 3. ÚČETNÍ ROZHODOVÁNÍ ─────────────────────────────────────────────────────

create table if not exists proposals (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references cases(id) on delete cascade,
  proposal_type   text not null check (proposal_type in (
                    'accounting', 'matching', 'classification', 'source_interpretation'
                  )),
  proposal_json   jsonb not null,
  confidence      numeric(5,2) check (confidence between 0 and 100),
  source_of_rule  text check (source_of_rule in ('explicit_rule', 'supplier_rule', 'learned_pattern', 'inference')),
  status          text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'superseded')),
  created_by_role text not null check (created_by_role in ('accountant', 'system')),
  created_at      timestamptz not null default now()
);

create index if not exists proposals_case_id_idx on proposals(case_id);
create index if not exists proposals_status_idx  on proposals(status) where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists reviews (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references cases(id) on delete cascade,
  proposal_id     uuid not null references proposals(id) on delete cascade,
  verdict         text not null check (verdict in ('ok', 'warning', 'fail')),
  issues_json     jsonb null,
  risk_score      numeric(5,2) check (risk_score between 0 and 100),
  comment         text null,
  created_by_role text not null check (created_by_role in ('auditor', 'system')),
  created_at      timestamptz not null default now()
);

create index if not exists reviews_case_id_idx     on reviews(case_id);
create index if not exists reviews_proposal_id_idx on reviews(proposal_id);
create index if not exists reviews_verdict_idx     on reviews(verdict) where verdict in ('warning', 'fail');

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists approvals (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references cases(id) on delete cascade,
  proposal_id  uuid null references proposals(id) on delete set null,
  review_id    uuid null references reviews(id) on delete set null,
  approved_by  text not null,   -- 'system', email, nebo role
  decision     text not null check (decision in ('approved', 'rejected', 'returned')),
  reason       text null,
  created_at   timestamptz not null default now()
);

create index if not exists approvals_case_id_idx on approvals(case_id);

-- ── 4. CONTROL TOWER & KPI ────────────────────────────────────────────────────

create table if not exists agent_kpis (
  id           uuid primary key default gen_random_uuid(),
  key          text unique not null,
  name         text not null,
  owner_role   text not null check (owner_role in ('accountant', 'auditor', 'pm', 'architect', 'orchestrator')),
  target_value numeric(18,4) null,
  unit         text null,   -- '%', 'count', 'days', apod.
  active       boolean not null default true
);

-- Seed základní KPI
insert into agent_kpis (key, name, owner_role, target_value, unit) values
  ('acc_classification_rate',  'Míra klasifikace faktur',       'accountant',  100,  '%'),
  ('acc_error_rate',           'Chybovost accountanta',         'accountant',  5,    '%'),
  ('aud_false_negative_rate',  'False negative auditora',       'auditor',     2,    '%'),
  ('aud_fix_rate',             'Míra oprav auditorem',          'auditor',     90,   '%'),
  ('pm_coverage_rate',         'Pokrytí zdrojových dat',        'pm',          100,  '%'),
  ('pm_unmatched_txn',         'Nespárované transakce',         'pm',          0,    'count'),
  ('sys_health_pct',           'Zdraví systému',                'orchestrator', 80,  '%'),
  ('abra_sync_delta',          'Delta SB vs ABRA',              'orchestrator', 0,   'count')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists agent_kpi_measurements (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       uuid not null references agent_kpis(id) on delete cascade,
  period_from  date not null,
  period_to    date not null,
  value        numeric(18,4) null,
  status       text not null check (status in ('good', 'warning', 'bad', 'insufficient_data')),
  details_json jsonb null,
  measured_at  timestamptz not null default now()
);

create index if not exists kpi_measurements_kpi_id_idx    on agent_kpi_measurements(kpi_id);
create index if not exists kpi_measurements_period_idx    on agent_kpi_measurements(period_from, period_to);
create index if not exists kpi_measurements_measured_idx  on agent_kpi_measurements(measured_at desc);

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists system_reviews (
  id                   uuid primary key default gen_random_uuid(),
  review_type          text not null check (review_type in (
                         'dashboard', 'weekly_review', 'architecture_review', 'learning_review'
                       )),
  overall_score        numeric(5,2) null,
  accounting_score     numeric(5,2) null,
  audit_score          numeric(5,2) null,
  workflow_score       numeric(5,2) null,
  data_quality_score   numeric(5,2) null,
  architecture_score   numeric(5,2) null,
  learning_score       numeric(5,2) null,
  insufficient_data    boolean not null default false,
  summary              text null,
  output_json          jsonb null,
  created_at           timestamptz not null default now()
);

create index if not exists system_reviews_type_idx       on system_reviews(review_type);
create index if not exists system_reviews_created_at_idx on system_reviews(created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists system_findings (
  id               uuid primary key default gen_random_uuid(),
  system_review_id uuid not null references system_reviews(id) on delete cascade,
  severity         text not null check (severity in ('low', 'medium', 'high', 'critical')),
  area             text not null check (area in ('data', 'workflow', 'architecture', 'accounting', 'audit', 'learning')),
  owner_role       text null check (owner_role in ('pm', 'accountant', 'auditor', 'architect', 'orchestrator')),
  title            text not null,
  symptom          text null,
  root_cause       text null,
  impact           text null,
  recommendation   text null,
  status           text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'resolved')),
  created_at       timestamptz not null default now()
);

create index if not exists findings_system_review_id_idx on system_findings(system_review_id);
create index if not exists findings_severity_idx         on system_findings(severity) where severity in ('high', 'critical');
create index if not exists findings_status_idx           on system_findings(status) where status = 'open';

-- ── 5. KNOWLEDGE BASE / MANUÁL ───────────────────────────────────────────────

create table if not exists manual_documents (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid null,
  code        text unique not null,   -- 'SA-MAIN', 'SA-RULES', apod.
  name        text not null,
  description text null,
  status      text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists manual_versions (
  id                   uuid primary key default gen_random_uuid(),
  manual_document_id   uuid not null references manual_documents(id) on delete cascade,
  version_number       integer not null,
  status               text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  change_summary       text null,
  published_at         timestamptz null,
  created_at           timestamptz not null default now(),
  unique (manual_document_id, version_number)
);

create index if not exists manual_versions_doc_id_idx on manual_versions(manual_document_id);

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists manual_sections (
  id                  uuid primary key default gen_random_uuid(),
  manual_version_id   uuid not null references manual_versions(id) on delete cascade,
  section_key         text not null,
  title               text not null,
  section_type        text not null check (section_type in (
                        'overview', 'policy', 'process', 'rules', 'exceptions', 'integrations', 'learning'
                      )),
  sort_order          integer not null default 0,
  markdown_content    text null,
  parent_section_id   uuid null references manual_sections(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (manual_version_id, section_key)
);

create index if not exists manual_sections_version_id_idx   on manual_sections(manual_version_id);
create index if not exists manual_sections_parent_id_idx    on manual_sections(parent_section_id) where parent_section_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists manual_rules (
  id                  uuid primary key default gen_random_uuid(),
  manual_version_id   uuid not null references manual_versions(id) on delete cascade,
  rule_key            text not null,
  rule_name           text not null,
  rule_type           text not null check (rule_type in (
                        'classification', 'posting', 'vat', 'matching', 'approval',
                        'escalation', 'source_check', 'exception'
                      )),
  scope_type          text not null check (scope_type in (
                        'global', 'supplier', 'category', 'country', 'document_type'
                      )),
  scope_value         text null,
  condition_json      jsonb null,
  action_json         jsonb null,
  priority            integer not null default 50,
  confidence_default  numeric(5,2) null check (confidence_default between 0 and 100),
  is_active           boolean not null default true,
  source_section_id   uuid null references manual_sections(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (manual_version_id, rule_key)
);

create index if not exists manual_rules_version_id_idx on manual_rules(manual_version_id);
create index if not exists manual_rules_type_idx       on manual_rules(rule_type);
create index if not exists manual_rules_active_idx     on manual_rules(is_active) where is_active = true;

-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists manual_render_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  manual_version_id  uuid not null references manual_versions(id) on delete cascade,
  render_type        text not null check (render_type in ('markdown', 'pdf', 'html')),
  file_url           text null,
  content            text null,
  generated_at       timestamptz not null default now()
);

create index if not exists manual_render_version_id_idx on manual_render_snapshots(manual_version_id);

-- ── 6. AGENT RUNS ─────────────────────────────────────────────────────────────

create table if not exists agent_runs (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid null references cases(id) on delete set null,
  role             text not null check (role in (
                     'accountant', 'auditor', 'architect', 'pm', 'orchestrator', 'control_tower'
                   )),
  input_snapshot   jsonb null,
  output_snapshot  jsonb null,
  confidence       numeric(5,2) null check (confidence between 0 and 100),
  status           text not null default 'success' check (status in ('success', 'failed', 'partial')),
  created_at       timestamptz not null default now()
);

create index if not exists agent_runs_case_id_idx    on agent_runs(case_id);
create index if not exists agent_runs_role_idx       on agent_runs(role);
create index if not exists agent_runs_created_at_idx on agent_runs(created_at desc);

-- ── updated_at trigger ────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$ begin
  create trigger cases_updated_at          before update on cases           for each row execute function set_updated_at();
  create trigger documents_updated_at      before update on documents       for each row execute function set_updated_at();
  create trigger manual_documents_updated  before update on manual_documents for each row execute function set_updated_at();
  create trigger manual_sections_updated   before update on manual_sections  for each row execute function set_updated_at();
  create trigger manual_rules_updated      before update on manual_rules     for each row execute function set_updated_at();
exception when duplicate_object then null;
end $$;
