import fs from 'fs';
import path from 'path';
import { env } from '../src/config/env';

const generateSchema = () => {
  const baseSchemaPath = path.join(__dirname, '../prisma/schema.base.prisma');
  const baseSchema = fs.readFileSync(baseSchemaPath, 'utf8');

  let datasource = '';
  let outDir = '';

  if (env.DATABASE_PROVIDER === 'sqlite') {
    datasource = `
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
`;
    outDir = path.join(__dirname, '../prisma/sqlite');
  } else if (env.DATABASE_PROVIDER === 'postgres') {
    datasource = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;
    outDir = path.join(__dirname, '../prisma/postgres');
  } else {
    throw new Error('Invalid DATABASE_PROVIDER');
  }

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const finalSchema = `${datasource}\n${baseSchema}`;
  const outPath = path.join(outDir, 'schema.prisma');
  
  fs.writeFileSync(outPath, finalSchema);
  console.log(`✅ Generated schema at ${outPath} using ${env.DATABASE_PROVIDER}`);
};

generateSchema();
