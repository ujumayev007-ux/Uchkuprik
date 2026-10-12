-- Multi-brand management is an Enterprise feature by default.
UPDATE "plans" SET "features" = array_append("features", 'multi_brand'), "updatedAt" = now() WHERE "code" = 'ENTERPRISE' AND NOT ('multi_brand' = ANY("features"));
