import { PrismaClient } from './generated/prisma/client';

const prisma = new PrismaClient();

const models = [
  {
    name: 'qwen-trader',
    openRoutermodelName: 'qwen3.5:latest',
    lighterApiKey: process.env['LIGHTER_API_KEY'] ?? '',
    accountIndex: process.env['ACCOUNT_INDEX'] ?? '722509',
  },
];

async function seed() {
  for (const model of models) {
    const existing = await prisma.models.findUnique({ where: { name: model.name } });
    if (existing) {
      console.log(`Model "${model.name}" already exists, skipping.`);
      continue;
    }
    const created = await prisma.models.create({ data: model });
    console.log(`Created model "${created.name}" with id ${created.id}`);
  }
  await prisma.$disconnect();
}

seed();
