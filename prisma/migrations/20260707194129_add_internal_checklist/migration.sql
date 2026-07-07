-- AlterTable
ALTER TABLE "WarrantyTickets" ADD COLUMN     "internalChecklist" TEXT[] DEFAULT ARRAY[]::TEXT[];
