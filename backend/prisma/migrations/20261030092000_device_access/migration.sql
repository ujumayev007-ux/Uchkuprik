-- Terminal management by the restaurant Admin (additive).
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "disabledAt" TIMESTAMP(3);
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "allowedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
