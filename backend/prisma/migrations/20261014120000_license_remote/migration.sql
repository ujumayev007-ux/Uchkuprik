-- AlterTable
ALTER TABLE "app_license" ADD COLUMN     "remoteBlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "statusIssuedAt" TIMESTAMP(3);

