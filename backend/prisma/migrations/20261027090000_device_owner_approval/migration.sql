-- New restaurant terminals wait for the Owner (SUPER_OWNER) approval. Existing devices keep their status.
ALTER TYPE "DeviceStatus" ADD VALUE IF NOT EXISTS 'PENDING';
