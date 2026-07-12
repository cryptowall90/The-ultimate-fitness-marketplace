import { migrate, reset, seed } from "./migrate.js";

const cmd = process.argv[2];

async function main(): Promise<void> {
  switch (cmd) {
    case "migrate": {
      const applied = await migrate();
      process.stdout.write(
        applied.length ? `Applied: ${applied.join(", ")}\n` : "Already up to date\n",
      );
      break;
    }
    case "reset": {
      await reset();
      process.stdout.write("Database reset and migrated\n");
      break;
    }
    case "seed": {
      const applied = await seed();
      process.stdout.write(`Seeded: ${applied.join(", ")}\n`);
      break;
    }
    case "gen-types": {
      process.stdout.write(
        "Type generation uses the Supabase CLI against a running instance:\n" +
          "  supabase gen types typescript --db-url $DATABASE_URL > packages/types/src/database.gen.ts\n",
      );
      break;
    }
    default:
      process.stderr.write("usage: cli.ts migrate|reset|seed|gen-types\n");
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
