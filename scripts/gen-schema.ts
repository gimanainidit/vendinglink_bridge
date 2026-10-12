import fs from 'fs';
import path from 'path';

const generateSchemas = () => {
  const baseSchemaPath = path.join(__dirname, '../prisma/schema.base.prisma');
  const baseSchema = fs.readFileSync(baseSchemaPath, 'utf8');

  const configs = [
    {
      provider: 'sqlite',
      dir: path.join(__dirname, '../prisma/sqlite'),
      datasource: `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
`,
    },
    {
      provider: 'postgres',
      dir: path.join(__dirname, '../prisma/postgres'),
      datasource: `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`,
    },
  ];

  for (const config of configs) {
    if (!fs.existsSync(config.dir)) {
      fs.mkdirSync(config.dir, { recursive: true });
    }
    const finalSchema = `${config.datasource}\n${baseSchema}`;
    const outPath = path.join(config.dir, 'schema.prisma');
    fs.writeFileSync(outPath, finalSchema);
    console.log(`✅ Generated schema at ${outPath} (${config.provider})`);
  }
};

generateSchemas();

