import { PrismaClient } from '@prisma/client';

export function createPrisma() {
  return new PrismaClient({ log: ['warn', 'error'] });
}
