-- Expense receipts may be PDF documents as well as photos (same 2 MB limit).
ALTER TABLE "evidence_files" DROP CONSTRAINT "evidence_files_size";
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_size" CHECK ("size" > 0 AND "size" <= 2097152 AND "contentType" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));
