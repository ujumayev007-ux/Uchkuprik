-- Kassa «TV ekrani» switch: a paused branch's queue TVs show a pause screen. Existing branches stay on.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "tvPaused" BOOLEAN NOT NULL DEFAULT false;
