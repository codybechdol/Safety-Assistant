-- ============================================================================
-- Safety Assistant — Foreman Equipment Inventory Audits (Supabase Setup)
-- ============================================================================
-- Instructions:
-- 1. Open your Supabase project dashboard (https://supabase.com/dashboard)
-- 2. In the left sidebar, click "SQL Editor" -> "New query"
-- 3. Paste this entire file and click "Run" (or Ctrl+Enter)
-- ============================================================================

-- 1. Audit Requests: One unique token link per foreman/crew per audit campaign
CREATE TABLE IF NOT EXISTS public.sa_audit_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token          TEXT UNIQUE NOT NULL,
  campaign_name  TEXT NOT NULL DEFAULT 'Crew Equipment Audit',
  foreman_name   TEXT NOT NULL,
  job_number     TEXT NOT NULL DEFAULT '',
  job_name       TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  foreman_phone  TEXT NOT NULL DEFAULT '',
  foreman_email  TEXT NOT NULL DEFAULT '',
  crew_employees JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'not_sent',
  sent_via       TEXT NOT NULL DEFAULT '',
  sent_at        TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  reopened_at    TIMESTAMPTZ,
  notes          TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT 'Cody Bechdol',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sa_audit_requests_token ON public.sa_audit_requests (token);
CREATE INDEX IF NOT EXISTS idx_sa_audit_requests_status ON public.sa_audit_requests (status);
CREATE INDEX IF NOT EXISTS idx_sa_audit_requests_created_at ON public.sa_audit_requests (created_at DESC);

-- 2. Audit Submissions & Archive: Drafts, final submitted counts, and reconciliation log
CREATE TABLE IF NOT EXISTS public.sa_audit_submissions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id             UUID UNIQUE NOT NULL REFERENCES public.sa_audit_requests(id) ON DELETE CASCADE,
  draft_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_item_count       INTEGER NOT NULL DEFAULT 0,
  draft_saved_at         TIMESTAMPTZ,
  submitted_payload      JSONB,
  submitted_item_count   INTEGER NOT NULL DEFAULT 0,
  submitted_at           TIMESTAMPTZ,
  submitted_by_name      TEXT NOT NULL DEFAULT '',
  submitted_by_device    TEXT NOT NULL DEFAULT '',
  reconciliation_summary JSONB,
  applied_actions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  auditor_notes          TEXT NOT NULL DEFAULT '',
  reconciled_at          TIMESTAMPTZ,
  archived_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sa_audit_submissions_request_id ON public.sa_audit_submissions (request_id);

-- 3. Enable Row Level Security (matching existing Safety Assistant Desktop App policy)
ALTER TABLE public.sa_audit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sa_audit_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow full access to sa_audit_requests" ON public.sa_audit_requests;
CREATE POLICY "Allow full access to sa_audit_requests"
  ON public.sa_audit_requests
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow full access to sa_audit_submissions" ON public.sa_audit_submissions;
CREATE POLICY "Allow full access to sa_audit_submissions"
  ON public.sa_audit_submissions
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- 4. Token-Locked RPC Functions for the Standalone Public Foreman Form
--    These RPCs expose ONLY the specific crew's audit header, employee name list,
--    and draft/submission for the exact matching token—never phones, emails, or other crews.

CREATE OR REPLACE FUNCTION public.get_audit_by_token(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.sa_audit_requests%ROWTYPE;
  v_sub public.sa_audit_submissions%ROWTYPE;
  v_has_sub BOOLEAN := false;
  v_expired BOOLEAN := false;
  v_locked BOOLEAN := false;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 12 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid audit link.');
  END IF;

  SELECT * INTO v_req
  FROM public.sa_audit_requests
  WHERE token = trim(p_token)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Audit link not found. Please contact Safety for a new link.');
  END IF;

  SELECT * INTO v_sub
  FROM public.sa_audit_submissions
  WHERE request_id = v_req.id
  LIMIT 1;
  v_has_sub := FOUND;

  IF v_req.status IN ('submitted', 'reconciled', 'archived') THEN
    v_locked := true;
  END IF;

  IF v_req.status = 'expired' OR (v_req.expires_at IS NOT NULL AND v_req.expires_at < now() AND NOT v_locked) THEN
    v_expired := true;
    v_locked := true;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'expired', v_expired,
    'locked', v_locked,
    'request', jsonb_build_object(
      'campaign_name', v_req.campaign_name,
      'foreman_name', v_req.foreman_name,
      'job_number', v_req.job_number,
      'job_name', v_req.job_name,
      'location', v_req.location,
      'crew_employees', COALESCE(v_req.crew_employees, '[]'::jsonb),
      'status', v_req.status,
      'expires_at', v_req.expires_at,
      'notes', v_req.notes
    ),
    'submission', CASE
      WHEN v_has_sub THEN jsonb_build_object(
        'draft_payload', COALESCE(v_sub.draft_payload, '{}'::jsonb),
        'draft_item_count', COALESCE(v_sub.draft_item_count, 0),
        'draft_saved_at', v_sub.draft_saved_at,
        'submitted_payload', v_sub.submitted_payload,
        'submitted_item_count', COALESCE(v_sub.submitted_item_count, 0),
        'submitted_at', v_sub.submitted_at,
        'submitted_by_name', COALESCE(v_sub.submitted_by_name, '')
      )
      ELSE NULL
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_audit_draft(
  p_token TEXT,
  p_payload JSONB,
  p_item_count INTEGER DEFAULT 0,
  p_device TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.sa_audit_requests%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_req
  FROM public.sa_audit_requests
  WHERE token = trim(COALESCE(p_token, ''))
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Audit link not found.');
  END IF;

  IF v_req.status IN ('submitted', 'reconciled', 'archived') THEN
    RETURN jsonb_build_object('ok', false, 'locked', true, 'error', 'This audit has already been submitted and locked.');
  END IF;

  IF v_req.status = 'expired' OR (v_req.expires_at IS NOT NULL AND v_req.expires_at < v_now) THEN
    RETURN jsonb_build_object('ok', false, 'expired', true, 'error', 'This audit link has expired.');
  END IF;

  INSERT INTO public.sa_audit_submissions (
    request_id, draft_payload, draft_item_count, draft_saved_at, submitted_by_device, updated_at
  )
  VALUES (
    v_req.id, COALESCE(p_payload, '{}'::jsonb), GREATEST(COALESCE(p_item_count, 0), 0), v_now, COALESCE(p_device, ''), v_now
  )
  ON CONFLICT (request_id) DO UPDATE SET
    draft_payload = EXCLUDED.draft_payload,
    draft_item_count = EXCLUDED.draft_item_count,
    draft_saved_at = v_now,
    submitted_by_device = CASE WHEN EXCLUDED.submitted_by_device <> '' THEN EXCLUDED.submitted_by_device ELSE public.sa_audit_submissions.submitted_by_device END,
    updated_at = v_now;

  UPDATE public.sa_audit_requests
  SET status = CASE WHEN status IN ('not_sent', 'sent') THEN 'in_progress' ELSE status END,
      updated_at = v_now
  WHERE id = v_req.id;

  RETURN jsonb_build_object('ok', true, 'saved_at', v_now);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_audit(
  p_token TEXT,
  p_payload JSONB,
  p_item_count INTEGER DEFAULT 0,
  p_submitted_by TEXT DEFAULT '',
  p_device TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.sa_audit_requests%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_req
  FROM public.sa_audit_requests
  WHERE token = trim(COALESCE(p_token, ''))
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Audit link not found.');
  END IF;

  IF v_req.status IN ('reconciled', 'archived') THEN
    RETURN jsonb_build_object('ok', false, 'locked', true, 'error', 'This audit has already been completed and archived.');
  END IF;

  IF v_req.status = 'expired' OR (v_req.expires_at IS NOT NULL AND v_req.expires_at < v_now) THEN
    RETURN jsonb_build_object('ok', false, 'expired', true, 'error', 'This audit link has expired.');
  END IF;

  INSERT INTO public.sa_audit_submissions (
    request_id, draft_payload, draft_item_count, draft_saved_at,
    submitted_payload, submitted_item_count, submitted_at,
    submitted_by_name, submitted_by_device, updated_at
  )
  VALUES (
    v_req.id,
    COALESCE(p_payload, '{}'::jsonb),
    GREATEST(COALESCE(p_item_count, 0), 0),
    v_now,
    COALESCE(p_payload, '{}'::jsonb),
    GREATEST(COALESCE(p_item_count, 0), 0),
    v_now,
    COALESCE(NULLIF(trim(p_submitted_by), ''), v_req.foreman_name),
    COALESCE(p_device, ''),
    v_now
  )
  ON CONFLICT (request_id) DO UPDATE SET
    draft_payload = EXCLUDED.draft_payload,
    draft_item_count = EXCLUDED.draft_item_count,
    draft_saved_at = v_now,
    submitted_payload = EXCLUDED.submitted_payload,
    submitted_item_count = EXCLUDED.submitted_item_count,
    submitted_at = v_now,
    submitted_by_name = EXCLUDED.submitted_by_name,
    submitted_by_device = EXCLUDED.submitted_by_device,
    updated_at = v_now;

  UPDATE public.sa_audit_requests
  SET status = 'submitted',
      updated_at = v_now
  WHERE id = v_req.id;

  RETURN jsonb_build_object('ok', true, 'submitted_at', v_now);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_audit_by_token(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_audit_draft(TEXT, JSONB, INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_audit(TEXT, JSONB, INTEGER, TEXT, TEXT) TO anon, authenticated;

-- 5. Enable Supabase Realtime WebSockets on both audit tables
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'sa_audit_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sa_audit_requests;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'sa_audit_submissions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sa_audit_submissions;
  END IF;
END $$;
