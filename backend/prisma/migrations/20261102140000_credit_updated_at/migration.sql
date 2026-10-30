-- Align with the Prisma schema (@updatedAt: the app sets the value; no database default).
-- Non-destructive: existing rows keep their values.
ALTER TABLE "credit_accounts" ALTER COLUMN "updatedAt" DROP DEFAULT;
